import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createOfflineQueue, type OfflineQueueOptions } from "../src/queue/queue.js";
import type { JobProcessor, ProcessOutcome } from "../src/queue/processor.js";
import type { OfflineQueue, QueueError, QueueJob } from "../src/queue/types.js";
import type { StoredObjectRef } from "../src/storage/types.js";
import { openFieldDB, type FieldDB } from "../src/db/open.js";
import { getJob } from "../src/db/jobs.repo.js";
import { markActive } from "../src/queue/state.js";
import { FieldCoreError } from "../src/shared/errors.js";
import { noopLogger } from "../src/shared/logger.js";
import { setClock } from "../src/shared/clock.js";

/**
 * キューの検証。fake-indexeddb の実装に対して走らせる。
 *
 * 通信は JobProcessor 経由で差し替えるので、ここでは1バイトも発生しない。
 * 「永続化・状態遷移・実行順・バックオフ・排他」だけを見る。
 */

const REF: StoredObjectRef = { provider: "supabase", bucket: "field-uploads", path: "x/y.jpg" };

const NETWORK_ERROR: QueueError = { kind: "network", retryable: true, message: "圏外", at: 0 };
const AUTH_ERROR: QueueError = { kind: "auth", retryable: false, message: "認証切れ", at: 0 };

/** 圧縮は M1 で検証済み。ここでは通り道だけ確保する */
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

function photo(bytes = 1000): Blob {
  return new Blob([new Uint8Array(bytes)], { type: "image/jpeg" });
}

/** 呼ばれた回数と結果を制御できる processor */
function createProcessor(
  behaviour: (job: QueueJob, callIndex: number) => ProcessOutcome | Promise<ProcessOutcome>,
): JobProcessor & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async process(job, ctx) {
      const index = calls.length;
      calls.push(job.jobId);
      const outcome = await behaviour(job, index);
      if (outcome.ok) {
        for (const attachment of job.attachments) {
          if (attachment.status !== "uploaded") {
            await ctx.onAttachmentUploaded(attachment.attachmentId, REF);
          }
        }
      }
      return outcome;
    },
  };
}

const alwaysOk = () => createProcessor(() => ({ ok: true }) as ProcessOutcome);

let dbCounter = 0;
let db: FieldDB;
let queues: OfflineQueue[] = [];

async function makeQueue(options?: Partial<OfflineQueueOptions>): Promise<OfflineQueue> {
  const queue = await createOfflineQueue({
    appId: "test",
    db,
    compress: passthroughCompress,
    logger: noopLogger,
    autoStart: false,
    pollIntervalMs: 0,
    forceIdbLease: true,
    ...options,
    // Partial<> は各プロパティに undefined を足すため、exactOptionalPropertyTypes と
    // 噛み合わない。テストヘルパの中で1回だけ吸収する
  } as OfflineQueueOptions);
  queues.push(queue);
  return queue;
}

beforeEach(async () => {
  dbCounter++;
  db = await openFieldDB(`pf-field-test-${dbCounter}`);
  queues = [];
});

afterEach(async () => {
  for (const queue of queues) await queue.destroy();
  db.close();
  vi.unstubAllGlobals();
});

describe("enqueue", () => {
  it("ジョブと添付を保存し、pending で待たせる", async () => {
    const queue = await makeQueue();
    const job = await queue.enqueue({
      type: "setsubi.inspection",
      payload: { equipmentId: "EQ-1234" },
      label: "設備No.1234 点検",
      attachments: [{ blob: photo(2000), fileName: "before.jpg", role: "before" }],
    });

    expect(job.status).toBe("pending");
    expect(job.attachments).toHaveLength(1);
    expect(job.progress).toEqual({
      uploadedBytes: 0,
      totalBytes: 2000,
      uploadedCount: 0,
      totalCount: 1,
    });

    const stored = await queue.get(job.jobId);
    expect(stored?.label).toBe("設備No.1234 点検");

    const blob = await queue.getAttachmentBlob(job.jobId, job.attachments[0]!.attachmentId);
    expect(blob?.size).toBe(2000);
  });

  it("jobId を省略すると UUID を採番する（冪等キーになる）", async () => {
    const queue = await makeQueue();
    const a = await queue.enqueue({ type: "t", payload: {} });
    const b = await queue.enqueue({ type: "t", payload: {} });
    expect(a.jobId).not.toBe(b.jobId);
    expect(a.jobId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("同じ jobId は二度受け付けない", async () => {
    const queue = await makeQueue();
    await queue.enqueue({ jobId: "fixed", type: "t", payload: {} });
    await expect(queue.enqueue({ jobId: "fixed", type: "t", payload: {} })).rejects.toThrow(
      /既に存在します/,
    );
  });

  it("画像は enqueue の時点で圧縮する（送信時には触らない）", async () => {
    const compress = vi.fn(passthroughCompress);
    const queue = await makeQueue({ compress });
    await queue.enqueue({
      type: "t",
      payload: {},
      attachments: [{ blob: photo(), fileName: "a.jpg" }],
    });
    expect(compress).toHaveBeenCalledOnce();
  });

  it("compress: false の添付は圧縮しない", async () => {
    const compress = vi.fn(passthroughCompress);
    const queue = await makeQueue({ compress });
    await queue.enqueue({
      type: "t",
      payload: {},
      attachments: [{ blob: photo(), fileName: "a.jpg", compress: false }],
    });
    expect(compress).not.toHaveBeenCalled();
  });

  it("画像以外は圧縮しない", async () => {
    const compress = vi.fn(passthroughCompress);
    const queue = await makeQueue({ compress });
    await queue.enqueue({
      type: "t",
      payload: {},
      attachments: [
        { blob: new Blob([new Uint8Array(10)], { type: "application/pdf" }), fileName: "a.pdf" },
      ],
    });
    expect(compress).not.toHaveBeenCalled();
  });

  it("ジョブと添付は同じトランザクションで書く", async () => {
    // 分けて書くと「ジョブはあるが画像が無い」が起きうる
    const queue = await makeQueue();
    const job = await queue.enqueue({
      type: "t",
      payload: {},
      attachments: [
        { blob: photo(), fileName: "a.jpg" },
        { blob: photo(), fileName: "b.jpg" },
      ],
    });
    for (const attachment of job.attachments) {
      expect(await queue.getAttachmentBlob(job.jobId, attachment.attachmentId)).toBeTruthy();
    }
  });
});

describe("滞留上限", () => {
  it("未送信の件数が上限に達したら enqueue を断る", async () => {
    const queue = await makeQueue({ retention: { maxUnsentJobs: 3 } });
    for (let i = 0; i < 3; i++) await queue.enqueue({ type: "t", payload: { i } });

    await expect(queue.enqueue({ type: "t", payload: {} })).rejects.toThrow(FieldCoreError);
    await expect(queue.enqueue({ type: "t", payload: {} })).rejects.toThrow(/上限（3 件）/);
  });

  it("既存の未送信ジョブは絶対に消さない", async () => {
    // 端末にしか無いデータを保持ポリシーで捨てたら、それはデータ消失
    const queue = await makeQueue({ retention: { maxUnsentJobs: 2 } });
    const first = await queue.enqueue({ type: "t", payload: { n: 1 } });
    await queue.enqueue({ type: "t", payload: { n: 2 } });
    await expect(queue.enqueue({ type: "t", payload: { n: 3 } })).rejects.toThrow();

    expect(await queue.get(first.jobId)).toBeTruthy();
    expect((await queue.counts()).unsent).toBe(2);
  });

  it("未送信の写真枚数の上限を守る", async () => {
    const queue = await makeQueue({ retention: { maxUnsentAttachments: 2 } });
    await queue.enqueue({
      type: "t",
      payload: {},
      attachments: [
        { blob: photo(), fileName: "a.jpg" },
        { blob: photo(), fileName: "b.jpg" },
      ],
    });
    await expect(
      queue.enqueue({ type: "t", payload: {}, attachments: [{ blob: photo(), fileName: "c.jpg" }] }),
    ).rejects.toThrow(/写真が上限（2 枚）/);
  });

  it("未送信の合計バイト数の上限を守る", async () => {
    const queue = await makeQueue({ retention: { maxUnsentBytes: 5000 } });
    await queue.enqueue({
      type: "t",
      payload: {},
      attachments: [{ blob: photo(4000), fileName: "a.jpg" }],
    });
    await expect(
      queue.enqueue({
        type: "t",
        payload: {},
        attachments: [{ blob: photo(2000), fileName: "b.jpg" }],
      }),
    ).rejects.toThrow(/データ量が上限/);
  });

  it("上限は設定で変えられる", async () => {
    const queue = await makeQueue({ retention: { maxUnsentJobs: 50 } });
    for (let i = 0; i < 10; i++) await queue.enqueue({ type: "t", payload: { i } });
    expect((await queue.counts()).unsent).toBe(10);
  });

  it("送信が済めば枠が空く", async () => {
    const queue = await makeQueue({
      retention: { maxUnsentJobs: 2 },
      processor: alwaysOk(),
    });
    await queue.enqueue({ type: "t", payload: { n: 1 } });
    await queue.enqueue({ type: "t", payload: { n: 2 } });
    await expect(queue.enqueue({ type: "t", payload: { n: 3 } })).rejects.toThrow();

    await queue.flush({ force: true });
    await expect(queue.enqueue({ type: "t", payload: { n: 3 } })).resolves.toBeTruthy();
  });
});

describe("端末の空き容量", () => {
  function stubStorage(usage: number, quota: number) {
    vi.stubGlobal("navigator", {
      storage: {
        estimate: async () => ({ usage, quota }),
        persist: async () => true,
        persisted: async () => true,
      },
    });
  }

  it("空きが下限を切ったら enqueue を断る", async () => {
    // 撮った写真がその場で失われる前に伝える
    stubStorage(95 * 1024 * 1024, 100 * 1024 * 1024); // 残り 5MB
    const queue = await makeQueue({ quota: { blockBelowBytes: 20 * 1024 * 1024 } });

    await expect(queue.enqueue({ type: "t", payload: {} })).rejects.toThrow(FieldCoreError);
    await expect(queue.enqueue({ type: "t", payload: {} })).rejects.toThrow(/空き容量が足りません/);
  });

  it("空きが警告域なら enqueue は通るが warn になる", async () => {
    stubStorage(70 * 1024 * 1024, 100 * 1024 * 1024); // 残り 30MB
    const queue = await makeQueue({
      quota: { warnBelowBytes: 50 * 1024 * 1024, blockBelowBytes: 20 * 1024 * 1024 },
    });

    await expect(queue.enqueue({ type: "t", payload: {} })).resolves.toBeTruthy();
    const health = await queue.health();
    expect(health.level).toBe("warn");
    expect(health.reason).toMatch(/空き容量が少なく/);
  });

  it("これから書く分を足しても下限を切るなら断る", async () => {
    stubStorage(78 * 1024 * 1024, 100 * 1024 * 1024); // 残り 22MB
    const queue = await makeQueue({ quota: { blockBelowBytes: 20 * 1024 * 1024 } });

    await expect(
      queue.enqueue({
        type: "t",
        payload: {},
        attachments: [{ blob: photo(5 * 1024 * 1024), fileName: "big.jpg" }],
      }),
    ).rejects.toThrow(/空き容量が足りません/);
  });

  it("estimate が取れない環境では容量では止めない", async () => {
    // navigator.storage が無いブラウザで、何も保存できなくなるほうが困る
    const queue = await makeQueue();
    await expect(queue.enqueue({ type: "t", payload: {} })).resolves.toBeTruthy();
    const health = await queue.health();
    expect(health.availableBytes).toBeNull();
    expect(health.level).toBe("ok");
  });

  it("状態は subscribe のスナップショットにも載る", async () => {
    // バッジやヘッダが「入らなくなる前に」警告を出せるようにするための経路
    stubStorage(95 * 1024 * 1024, 100 * 1024 * 1024);
    const queue = await makeQueue();
    await queue.health(); // 初回計算

    const level = await new Promise<string | undefined>((resolve) => {
      const off = queue.subscribe((snapshot) => {
        off();
        resolve(snapshot.storage?.level);
      });
    });

    expect(level).toBe("critical");
  });
});

describe("flush", () => {
  it("processor が無ければ何もしない", async () => {
    const queue = await makeQueue();
    await queue.enqueue({ type: "t", payload: {} });
    const result = await queue.flush();
    expect(result).toMatchObject({ attempted: 0, reason: "stopped" });
    expect((await queue.get((await queue.list())[0]!.jobId))?.status).toBe("pending");
  });

  it("成功したジョブを succeeded にし、添付を端末から消す", async () => {
    const queue = await makeQueue({ processor: alwaysOk() });
    const job = await queue.enqueue({
      type: "t",
      payload: {},
      attachments: [{ blob: photo(), fileName: "a.jpg" }],
    });

    const result = await queue.flush({ force: true });
    expect(result).toMatchObject({ attempted: 1, succeeded: 1, failed: 0 });

    const stored = await queue.get(job.jobId);
    expect(stored?.status).toBe("succeeded");
    // 送信済みの画像を端末に残す理由はない
    expect(await queue.getAttachmentBlob(job.jobId, job.attachments[0]!.attachmentId)).toBeUndefined();
  });

  it("待てば直る失敗は pending に戻し、次回時刻を入れる", async () => {
    const processor = createProcessor(() => ({ ok: false, error: NETWORK_ERROR }));
    const queue = await makeQueue({ processor });
    const job = await queue.enqueue({ type: "t", payload: {} });

    await queue.flush({ force: true });

    const stored = await queue.get(job.jobId);
    expect(stored?.status).toBe("pending");
    expect(stored?.attempts).toBe(1);
    expect(stored?.nextAttemptAt).toBeGreaterThan(0);
    expect(stored?.lastError?.kind).toBe("network");
  });

  it("人手が要る失敗は blocked にする", async () => {
    const processor = createProcessor(() => ({ ok: false, error: AUTH_ERROR }));
    const queue = await makeQueue({ processor });
    const job = await queue.enqueue({ type: "t", payload: {} });

    await queue.flush({ force: true });

    const stored = await queue.get(job.jobId);
    expect(stored?.status).toBe("blocked");
    expect(stored?.nextAttemptAt).toBeNull();
  });

  it("1回の flush で同じジョブを二度試さない", async () => {
    // バックオフが 0 に振れたジョブで無限に回り続けないこと
    const processor = createProcessor(() => ({ ok: false, error: NETWORK_ERROR }));
    const queue = await makeQueue({
      processor,
      backoff: { baseMs: 0, maxMs: 0, jitter: "none" },
    });
    await queue.enqueue({ type: "t", payload: {} });

    const result = await queue.flush({ force: true });
    expect(result.attempted).toBe(1);
    expect(processor.calls).toHaveLength(1);
  });

  it("自動の周回では、待ち時間が来ていないジョブに触らない", async () => {
    const processor = createProcessor(() => ({ ok: false, error: NETWORK_ERROR }));
    const queue = await makeQueue({ processor, backoff: { baseMs: 60_000, jitter: "none" } });
    await queue.enqueue({ type: "t", payload: {} });

    await queue.flush({ force: true });
    expect(processor.calls).toHaveLength(1);

    // オンライン復帰や定期実行で回ってきた場合。ここで待たないとサーバに殺到する
    const second = await queue.flush();
    expect(second).toMatchObject({ attempted: 0, reason: "empty" });
  });

  it("利用者が「いま送信する」を押したときは待ち時間を無視する", async () => {
    /*
     * バックオフは自動再試行を散らすためのもので、
     * 電波の良い所まで歩いてきて押した人を待たせる理由は無い。
     * ここで待つと「押しても何も起きない」画面になり、現場では故障と見なされる。
     */
    const processor = createProcessor(() => ({ ok: false, error: NETWORK_ERROR }));
    const queue = await makeQueue({ processor, backoff: { baseMs: 60_000, jitter: "none" } });
    await queue.enqueue({ type: "t", payload: {} });

    await queue.flush({ force: true });
    expect(processor.calls).toHaveLength(1);

    const second = await queue.flush({ force: true });
    expect(second.attempted).toBe(1);
    expect(processor.calls).toHaveLength(2);
  });

  it("優先度が高いものから、同じなら古いものから送る", async () => {
    const processor = createProcessor(() => ({ ok: true }));
    const queue = await makeQueue({ processor });

    const a = await queue.enqueue({ jobId: "a", type: "t", payload: {}, priority: 0 });
    const b = await queue.enqueue({ jobId: "b", type: "t", payload: {}, priority: 0 });
    const c = await queue.enqueue({ jobId: "c", type: "t", payload: {}, priority: 5 });

    await queue.flush({ force: true });
    expect(processor.calls).toEqual([c.jobId, a.jobId, b.jobId]);
  });

  it("到達性の確認が false なら状態を変えない", async () => {
    const processor = alwaysOk();
    const queue = await makeQueue({ processor, precheck: async () => false });
    const job = await queue.enqueue({ type: "t", payload: {} });

    const result = await queue.flush();
    expect(result).toMatchObject({ attempted: 0, reason: "unreachable" });
    expect((await queue.get(job.jobId))?.status).toBe("pending");
    expect((await queue.get(job.jobId))?.attempts).toBe(0);
    expect(processor.calls).toHaveLength(0);
  });

  it("processor が例外を投げてもキューは止まらない", async () => {
    let first = true;
    const processor = createProcessor(() => {
      if (first) {
        first = false;
        throw new Error("想定外");
      }
      return { ok: true };
    });
    const queue = await makeQueue({ processor, backoff: { baseMs: 0, jitter: "none" } });
    await queue.enqueue({ jobId: "a", type: "t", payload: {} });
    await queue.enqueue({ jobId: "b", type: "t", payload: {} });

    const result = await queue.flush({ force: true });
    expect(result.attempted).toBe(2);
    expect(result.succeeded).toBe(1);
    expect((await queue.get("a"))?.status).toBe("pending");
    expect((await queue.get("b"))?.status).toBe("succeeded");
  });

  it("jobIds を指定すればその分だけ送る", async () => {
    const processor = createProcessor(() => ({ ok: true }));
    const queue = await makeQueue({ processor });
    await queue.enqueue({ jobId: "a", type: "t", payload: {} });
    await queue.enqueue({ jobId: "b", type: "t", payload: {} });

    await queue.flush({ force: true, jobIds: ["b"] });
    expect(processor.calls).toEqual(["b"]);
  });
});

describe("添付の途中再開", () => {
  it("送れた添付だけを記録し、次回は残りだけを送る", async () => {
    // 3枚中2枚まで送った時点で圏外になる、という現場でよくある状況
    const processor: JobProcessor = {
      async process(job, ctx) {
        const remaining = job.attachments.filter((a) => a.status !== "uploaded");
        if (remaining.length === 3) {
          await ctx.onAttachmentUploaded(remaining[0]!.attachmentId, REF);
          await ctx.onAttachmentUploaded(remaining[1]!.attachmentId, REF);
          return { ok: false, error: NETWORK_ERROR };
        }
        for (const attachment of remaining) {
          await ctx.onAttachmentUploaded(attachment.attachmentId, REF);
        }
        return { ok: true };
      },
    };

    const queue = await makeQueue({ processor, backoff: { baseMs: 0, jitter: "none" } });
    const job = await queue.enqueue({
      type: "t",
      payload: {},
      attachments: [
        { blob: photo(100), fileName: "1.jpg" },
        { blob: photo(200), fileName: "2.jpg" },
        { blob: photo(300), fileName: "3.jpg" },
      ],
    });

    await queue.flush({ force: true });

    const after = await queue.get(job.jobId);
    expect(after?.status).toBe("pending");
    expect(after?.progress).toMatchObject({ uploadedCount: 2, uploadedBytes: 300 });
    expect(after?.attachments.filter((a) => a.status === "uploaded")).toHaveLength(2);

    await queue.flush({ force: true });
    expect((await queue.get(job.jobId))?.status).toBe("succeeded");
  });
});

describe("手動再送", () => {
  it("failed を即時実行できる状態に戻す", async () => {
    const processor = createProcessor((_job, index) =>
      index === 0 ? { ok: false, error: NETWORK_ERROR } : { ok: true },
    );
    const queue = await makeQueue({ processor, maxAttempts: 1 });
    const job = await queue.enqueue({ type: "t", payload: {} });

    await queue.flush({ force: true });
    expect((await queue.get(job.jobId))?.status).toBe("failed");

    await queue.retry(job.jobId);
    const retried = await queue.get(job.jobId);
    expect(retried?.status).toBe("pending");
    expect(retried?.attempts).toBe(0);

    await queue.flush({ force: true });
    expect((await queue.get(job.jobId))?.status).toBe("succeeded");
  });

  it("retryAll は既定では blocked を戻さない", async () => {
    const processor = createProcessor(() => ({ ok: false, error: AUTH_ERROR }));
    const queue = await makeQueue({ processor });
    const job = await queue.enqueue({ type: "t", payload: {} });
    await queue.flush({ force: true });

    await queue.retryAll();
    expect((await queue.get(job.jobId))?.status).toBe("blocked");
  });

  it("includeBlocked で認証切れのジョブも戻せる（再ログイン後の救済）", async () => {
    const processor = createProcessor(() => ({ ok: false, error: AUTH_ERROR }));
    const queue = await makeQueue({ processor });
    const job = await queue.enqueue({ type: "t", payload: {} });
    await queue.flush({ force: true });

    await queue.retryAll({ includeBlocked: true });
    expect((await queue.get(job.jobId))?.status).toBe("pending");
  });
});

describe("破棄と削除", () => {
  it("cancel は添付も消す", async () => {
    const queue = await makeQueue();
    const job = await queue.enqueue({
      type: "t",
      payload: {},
      attachments: [{ blob: photo(), fileName: "a.jpg" }],
    });

    await queue.cancel(job.jobId);
    expect((await queue.get(job.jobId))?.status).toBe("canceled");
    expect(await queue.getAttachmentBlob(job.jobId, job.attachments[0]!.attachmentId)).toBeUndefined();
  });

  it("送信済みのジョブは取り消せない", async () => {
    const queue = await makeQueue({ processor: alwaysOk() });
    const job = await queue.enqueue({ type: "t", payload: {} });
    await queue.flush({ force: true });

    await queue.cancel(job.jobId);
    expect((await queue.get(job.jobId))?.status).toBe("succeeded");
  });

  it("remove はジョブごと消す", async () => {
    const queue = await makeQueue();
    const job = await queue.enqueue({
      type: "t",
      payload: {},
      attachments: [{ blob: photo(), fileName: "a.jpg" }],
    });
    await queue.remove(job.jobId);
    expect(await queue.get(job.jobId)).toBeUndefined();
    expect(await queue.getAttachmentBlob(job.jobId, job.attachments[0]!.attachmentId)).toBeUndefined();
  });

  it("purgeSucceeded は期限を過ぎた成功ジョブだけを消す", async () => {
    const queue = await makeQueue({ processor: alwaysOk() });
    const job = await queue.enqueue({ type: "t", payload: {} });
    await queue.flush({ force: true });

    expect(await queue.purgeSucceeded(60_000)).toBe(0); // まだ新しい
    expect(await queue.get(job.jobId)).toBeTruthy();

    expect(await queue.purgeSucceeded(0)).toBe(1);
    expect(await queue.get(job.jobId)).toBeUndefined();
  });

  it("同じミリ秒に成功したジョブも purge(0) の対象になる", async () => {
    /*
     * CI で1回落ちて見つかった取りこぼし。境界が厳密比較だと、
     * 「成功した瞬間に purge(0) を呼ぶ」と何も消えない。
     *
     * 実害があるのは容量逼迫時。enqueue は断る前に purgeSucceeded(0) を呼ぶので、
     * ここで取りこぼすと、消せるものが残っているのに写真を断ることになる。
     * 時計を固定して、運任せにせず境界そのものを固定する。
     */
    const at = 1_000_000;
    const restore = setClock({ now: () => at });
    try {
      const queue = await makeQueue({ processor: alwaysOk() });
      const job = await queue.enqueue({ type: "t", payload: {} });
      await queue.flush({ force: true });

      expect((await queue.get(job.jobId))?.succeededAt).toBe(at);
      // before === succeededAt。ここが境界
      expect(await queue.purgeSucceeded(0)).toBe(1);
    } finally {
      restore();
    }
  });

  it("未送信ジョブは purge の対象にならない", async () => {
    const queue = await makeQueue();
    const job = await queue.enqueue({ type: "t", payload: {} });
    expect(await queue.purgeSucceeded(0)).toBe(0);
    expect(await queue.get(job.jobId)).toBeTruthy();
  });
});

describe("落ちた端末からの回復", () => {
  it("active のまま残ったジョブを pending に戻す（試行回数は増やさない）", async () => {
    // WebView が kill されると起きる。Zebra 端末では現実に起きる
    const queue = await makeQueue({ processor: alwaysOk(), staleActiveAfterMs: 0 });
    const job = await queue.enqueue({ type: "t", payload: {} });

    // 送信中に落ちた状態を作る
    const stored = await getJob(db, job.jobId);
    await db.put("jobs", markActive(stored!, "dead-tab", 1));

    await queue.flush({ force: true });
    const after = await queue.get(job.jobId);
    expect(after?.status).toBe("succeeded");
    expect(after?.attempts).toBe(0);
  });

  it("まだ新しい active は他タブのものとみなして触らない", async () => {
    const queue = await makeQueue({ processor: alwaysOk(), staleActiveAfterMs: 10 * 60_000 });
    const job = await queue.enqueue({ type: "t", payload: {} });

    const stored = await getJob(db, job.jobId);
    await db.put("jobs", markActive(stored!, "other-tab"));

    await queue.flush({ force: true });
    expect((await queue.get(job.jobId))?.status).toBe("active");
  });
});

describe("排他", () => {
  it("同時に走るのは1つだけ", async () => {
    let concurrent = 0;
    let maxConcurrent = 0;
    const processor: JobProcessor = {
      async process() {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise((r) => setTimeout(r, 10));
        concurrent--;
        return { ok: true };
      },
    };

    // 同じ DB を共有する2つのキュー = 2タブ相当
    const a = await makeQueue({ processor, instanceId: "tab-a" });
    const b = await makeQueue({ processor, instanceId: "tab-b" });
    await a.enqueue({ jobId: "1", type: "t", payload: {} });
    await a.enqueue({ jobId: "2", type: "t", payload: {} });

    const [ra, rb] = await Promise.all([a.flush({ force: true }), b.flush({ force: true })]);

    // 片方はロックが取れずに何もしない
    const reasons = [ra.reason, rb.reason];
    expect(reasons).toContain("locked");
    expect(maxConcurrent).toBe(1);
    expect((await a.counts()).succeeded).toBe(2);
  });
});

describe("subscribe", () => {
  it("購読した直後に現在値が届く", async () => {
    const queue = await makeQueue();
    await queue.enqueue({ type: "t", payload: {} });

    const snapshot = await new Promise<Parameters<Parameters<OfflineQueue["subscribe"]>[0]>[0]>(
      (resolve) => {
        const off = queue.subscribe((s) => {
          off();
          resolve(s);
        });
      },
    );
    expect(snapshot.counts.unsent).toBe(1);
  });

  it("状態が変わるたびに通知する", async () => {
    const queue = await makeQueue({ processor: alwaysOk() });
    const counts: number[] = [];
    const off = queue.subscribe((s) => counts.push(s.counts.unsent));

    await queue.enqueue({ type: "t", payload: {} });
    await queue.flush({ force: true });
    off();

    expect(counts.at(-1)).toBe(0);
    expect(Math.max(...counts)).toBe(1);
  });
});

describe("counts", () => {
  it("未送信は pending / active / failed / blocked の合計", async () => {
    const processor = createProcessor((job) =>
      job.jobId === "blocked-one"
        ? { ok: false, error: AUTH_ERROR }
        : { ok: false, error: NETWORK_ERROR },
    );
    const queue = await makeQueue({ processor, maxAttempts: 1 });

    await queue.enqueue({ jobId: "blocked-one", type: "t", payload: {} });
    await queue.enqueue({ jobId: "failed-one", type: "t", payload: {} });
    await queue.flush({ force: true });
    await queue.enqueue({ jobId: "pending-one", type: "t", payload: {} });

    const counts = await queue.counts();
    expect(counts).toMatchObject({ blocked: 1, failed: 1, pending: 1, unsent: 3 });
  });

  it("最も古い未送信の作成時刻を返す", async () => {
    const queue = await makeQueue();
    const first = await queue.enqueue({ type: "t", payload: {} });
    await queue.enqueue({ type: "t", payload: {} });

    expect((await queue.counts()).oldestPendingAt).toBe(first.createdAt);
  });
});

describe("list", () => {
  it("状態と種別で絞れる", async () => {
    const queue = await makeQueue();
    await queue.enqueue({ type: "a", payload: {} });
    await queue.enqueue({ type: "b", payload: {} });

    expect(await queue.list({ type: ["a"] })).toHaveLength(1);
    expect(await queue.list({ status: ["pending"] })).toHaveLength(2);
    expect(await queue.list({ status: ["succeeded"] })).toHaveLength(0);
  });

  it("件数を絞れる", async () => {
    const queue = await makeQueue();
    for (let i = 0; i < 5; i++) await queue.enqueue({ type: "t", payload: { i } });
    expect(await queue.list({ limit: 2 })).toHaveLength(2);
    expect(await queue.list({ offset: 3 })).toHaveLength(2);
  });
});
