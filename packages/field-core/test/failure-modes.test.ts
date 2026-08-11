import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createOfflineQueue, type OfflineQueueOptions } from "../src/queue/queue.js";
import type { JobProcessor, ProcessOutcome } from "../src/queue/processor.js";
import type { OfflineQueue, QueueError } from "../src/queue/types.js";
import { openFieldDB, type FieldDB } from "../src/db/open.js";
import { FieldCoreError } from "../src/shared/errors.js";
import { noopLogger } from "../src/shared/logger.js";

/*
 * 障害系。
 *
 * 単体の分類や閾値は各テストで固めてある。ここで見るのはその先で、
 * **障害が起きたあと現場がどうなるか**。
 *
 *   - 容量が尽きたとき、既に撮ってある写真は残るか
 *   - 尽きた状態から自力で戻れるか
 *   - 戻れないとき、黙って捨てずに断れるか
 *   - 認証が切れたとき、写真は残るか。再ログイン後に送り切れるか
 *
 * どれも「データが消える」に直結する。消えたら撮り直せない。
 */

const passthroughCompress: OfflineQueueOptions["compress"] = async (blob) => ({
  blob,
  width: 100,
  height: 100,
  bytes: blob.size,
  quality: 0.75,
  passes: 1,
  original: { bytes: blob.size, width: 100, height: 100, type: blob.type },
  orientation: 1,
  renderer: "offscreen-main",
  durationMs: 1,
});

const AUTH_ERROR: QueueError = {
  kind: "auth",
  retryable: false,
  message: "認証の有効期限が切れています",
  at: 0,
};

function photo(bytes = 1000): Blob {
  return new Blob([new Uint8Array(bytes)], { type: "image/jpeg" });
}

/** n 回目までは失敗し、それ以降は成功する processor */
function createProcessor(behaviour: (callIndex: number) => ProcessOutcome): JobProcessor {
  let calls = 0;
  return {
    async process(job, ctx) {
      const outcome = behaviour(calls++);
      if (outcome.ok) {
        for (const attachment of job.attachments) {
          if (attachment.status !== "uploaded") {
            await ctx.onAttachmentUploaded(attachment.attachmentId, {
              provider: "supabase",
              bucket: "field-uploads",
              path: `x/${attachment.attachmentId}`,
            });
          }
        }
      }
      return outcome;
    },
  };
}

let dbCounter = 0;
let db: FieldDB;
let queues: OfflineQueue[] = [];

async function makeQueue(options?: Partial<OfflineQueueOptions>): Promise<OfflineQueue> {
  const queue = await createOfflineQueue({
    appId: "failure-modes",
    db,
    compress: passthroughCompress,
    logger: noopLogger,
    autoStart: false,
    pollIntervalMs: 0,
    forceIdbLease: true,
    crossTab: false,
    ...options,
  } as OfflineQueueOptions);
  queues.push(queue);
  return queue;
}

/** navigator.storage.estimate() を差し替えて空き容量を作る */
function stubStorage(free: { usage: number; quota: number }) {
  vi.stubGlobal("navigator", {
    storage: {
      estimate: async () => ({ usage: free.usage, quota: free.quota }),
      persist: async () => true,
      persisted: async () => true,
    },
  });
}

const MB = 1024 * 1024;

beforeEach(async () => {
  dbCounter++;
  db = await openFieldDB(`pf-field-failure-${dbCounter}`);
  queues = [];
});

afterEach(async () => {
  for (const queue of queues) await queue.destroy();
  db.close();
  vi.unstubAllGlobals();
});

describe("ストレージ逼迫", () => {
  it("★ 断られても、既にある未送信は消えない", async () => {
    // 空きがあるうちに1件積む
    stubStorage({ usage: 10 * MB, quota: 100 * MB });
    const queue = await makeQueue({ quota: { blockBelowBytes: 20 * MB } });
    const first = await queue.enqueue({
      type: "t",
      payload: { n: 1 },
      attachments: [{ blob: photo(2000), fileName: "a.jpg" }],
    });

    // 空きが尽きる
    stubStorage({ usage: 95 * MB, quota: 100 * MB });
    await expect(queue.enqueue({ type: "t", payload: { n: 2 } })).rejects.toThrow(FieldCoreError);

    // 断ったことで既存を巻き添えにしていないこと。写真の実体まで確かめる
    const stored = await queue.get(first.jobId);
    expect(stored?.status).toBe("pending");
    const blob = await queue.getAttachmentBlob(
      first.jobId,
      first.attachments[0]!.attachmentId,
    );
    expect(blob?.size).toBe(2000);
  });

  it("★ 逼迫していても送信はできる（詰まりを解消する経路を塞がない）", async () => {
    stubStorage({ usage: 10 * MB, quota: 100 * MB });
    const queue = await makeQueue({
      quota: { blockBelowBytes: 20 * MB },
      processor: createProcessor(() => ({ ok: true }) as ProcessOutcome),
    });
    await queue.enqueue({ type: "t", payload: {} });

    // 撮る余地は無くなったが、送るのは通らなければならない。
    // ここが塞がると、容量が減った端末は永久に回復できない
    stubStorage({ usage: 95 * MB, quota: 100 * MB });
    await expect(queue.enqueue({ type: "t", payload: {} })).rejects.toThrow();

    const result = await queue.flush({ force: true });
    expect(result.succeeded).toBe(1);
    expect((await queue.counts()).unsent).toBe(0);
  });

  it("滞留の上限に達しても、送り切れば再び受け付ける（自力で戻れる）", async () => {
    const queue = await makeQueue({
      retention: { maxUnsentJobs: 2 },
      processor: createProcessor(() => ({ ok: true }) as ProcessOutcome),
    });
    await queue.enqueue({ type: "t", payload: { n: 1 } });
    await queue.enqueue({ type: "t", payload: { n: 2 } });
    await expect(queue.enqueue({ type: "t", payload: { n: 3 } })).rejects.toThrow(/上限/);

    await queue.flush({ force: true });
    await expect(queue.enqueue({ type: "t", payload: { n: 3 } })).resolves.toBeTruthy();
  });

  it("★ 空きが戻らないなら、黙って捨てずに断る", async () => {
    /*
     * ここで「古い未送信を捨てて場所を空ける」をやってはいけない。
     * 未送信は端末にしか無く、捨てたら撮り直せない。
     * 断って利用者に伝えるほうが正しい。
     */
    stubStorage({ usage: 95 * MB, quota: 100 * MB });
    const queue = await makeQueue({ quota: { blockBelowBytes: 20 * MB } });

    await expect(queue.enqueue({ type: "t", payload: {} })).rejects.toThrow(FieldCoreError);
    await expect(queue.enqueue({ type: "t", payload: {} })).rejects.toThrow(
      /空き容量が足りません/,
    );

    // 断り続けても状態は壊れない
    expect((await queue.counts()).total).toBe(0);
    expect((await queue.health()).level).toBe("critical");
  });
});

describe("認証切れ", () => {
  it("★ blocked になっても写真は残る（再ログイン後に送り切れる）", async () => {
    /*
     * 認証切れは「待っても直らない」ので blocked に落とすが、
     * **落とすのは状態だけで、データは落とさない**。
     * ここで添付が消えると、現場は撮り直しになる（多くの場合それは不可能）。
     */
    let failNext = true;
    const queue = await makeQueue({
      processor: createProcessor(() =>
        failNext ? ({ ok: false, error: AUTH_ERROR } as ProcessOutcome) : ({ ok: true } as ProcessOutcome),
      ),
    });

    const job = await queue.enqueue({
      type: "t",
      payload: {},
      attachments: [{ blob: photo(3000), fileName: "before.jpg" }],
    });

    await queue.flush({ force: true });

    const blocked = await queue.get(job.jobId);
    expect(blocked?.status).toBe("blocked");
    expect(blocked?.lastError?.kind).toBe("auth");

    // 写真の実体が残っていること
    const blob = await queue.getAttachmentBlob(job.jobId, job.attachments[0]!.attachmentId);
    expect(blob?.size).toBe(3000);

    // 再ログインした
    failNext = false;
    await queue.retryAll({ includeBlocked: true });
    const result = await queue.flush({ force: true });

    expect(result.succeeded).toBe(1);
    expect((await queue.get(job.jobId))?.status).toBe("succeeded");
  });

  it("★ 認証切れは何度 flush しても再試行されない（無駄な通信をしない）", async () => {
    let calls = 0;
    const queue = await makeQueue({
      processor: {
        async process() {
          calls++;
          return { ok: false, error: AUTH_ERROR } as ProcessOutcome;
        },
      },
    });
    await queue.enqueue({ type: "t", payload: {} });

    await queue.flush({ force: true });
    await queue.flush({ force: true });
    await queue.flush({ force: true });

    // 弱電界で通らない通信を繰り返すと電池も帯域も食う
    expect(calls).toBe(1);
  });
});
