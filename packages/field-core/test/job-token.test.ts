import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createOfflineQueue, type OfflineQueueOptions } from "../src/queue/queue.js";
import type { JobProcessor } from "../src/queue/processor.js";
import type { OfflineQueue } from "../src/queue/types.js";
import { openFieldDB, type FieldDB } from "../src/db/open.js";
import { getJobToken } from "../src/db/tokens.repo.js";
import { recordServerDate, resetClockSkew } from "../src/shared/clock-skew.js";
import { DEFAULT_JOB_TOKEN_TTL_MS } from "../src/db/schema.js";
import { noopLogger } from "../src/shared/logger.js";

/**
 * ジョブ単位の送信トークン。
 *
 * Cookie ではなく端末に預かるのが要点。無操作ログアウト（共用端末15分）や
 * セッション期限（12時間）で認証が切れても、預かった写真は送れなければならない。
 */

const okProcessor: JobProcessor = { async process() { return { ok: true }; } };

const passthroughCompress: OfflineQueueOptions["compress"] = async (blob) => ({
  blob,
  width: 1,
  height: 1,
  bytes: blob.size,
  quality: 1,
  passes: 0,
  original: { bytes: blob.size, width: 1, height: 1, type: blob.type },
  orientation: 1,
  renderer: "passthrough",
  durationMs: 0,
});

let dbCounter = 0;
let db: FieldDB;
let queues: OfflineQueue[] = [];

async function makeQueue(options?: Partial<OfflineQueueOptions>): Promise<OfflineQueue> {
  const queue = await createOfflineQueue({
    appId: "token-test",
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
  db = await openFieldDB(`pf-field-token-${dbCounter}`);
  queues = [];
});

afterEach(async () => {
  for (const queue of queues) await queue.destroy();
  db.close();
  vi.unstubAllGlobals();
});

describe("発行", () => {
  it("ジョブ投入時に発行して端末に預かる", async () => {
    // 認証が生きているのは投入時だけ。ここで取らないと、圏外から戻ったときには遅い
    const issue = vi.fn(async (job: { jobId: string }) => ({ token: `tok-${job.jobId}` }));
    const queue = await makeQueue({ issueJobToken: issue });

    const job = await queue.enqueue({ type: "t", payload: {} });

    expect(issue).toHaveBeenCalledOnce();
    expect(issue.mock.calls[0]?.[0]).toMatchObject({ jobId: job.jobId, type: "t" });

    const stored = await getJobToken(db, job.jobId);
    expect(stored?.token.token).toBe(`tok-${job.jobId}`);
  });

  it("既定の有効期限は26時間", async () => {
    // next-auth のセッション（12時間）より長い。
    // 「夕方に撮って翌朝に圏内へ戻る」を1本のトークンで賄うため
    const queue = await makeQueue({ issueJobToken: async () => ({ token: "tok" }) });
    const job = await queue.enqueue({ type: "t", payload: {} });

    const stored = await getJobToken(db, job.jobId);
    const ttl = (stored?.token.expiresAt ?? 0) - (stored?.token.createdAt ?? 0);
    expect(ttl).toBe(DEFAULT_JOB_TOKEN_TTL_MS);
    expect(ttl).toBeGreaterThan(12 * 60 * 60 * 1000);
  });

  it("サーバが期限を指定すればそれに従う", async () => {
    const expiresAt = Date.now() + 60_000;
    const queue = await makeQueue({ issueJobToken: async () => ({ token: "tok", expiresAt }) });
    const job = await queue.enqueue({ type: "t", payload: {} });

    expect((await getJobToken(db, job.jobId))?.token.expiresAt).toBe(expiresAt);
  });

  it("トークンは jobs には入らない（list に乗せない）", async () => {
    // UI やログへ流出させないため、ストアを分けてある
    const queue = await makeQueue({ issueJobToken: async () => ({ token: "secret-value" }) });
    await queue.enqueue({ type: "t", payload: {} });

    const jobs = await queue.list();
    expect(JSON.stringify(jobs)).not.toContain("secret-value");
  });

  it("発行できなければジョブごと取り消す", async () => {
    // 「預かったのに送れない」状態を端末に残さない
    const queue = await makeQueue({
      issueJobToken: async () => {
        throw new Error("サーバに繋がりません");
      },
    });

    await expect(queue.enqueue({ type: "t", payload: {} })).rejects.toThrow(/認証情報を取得できません/);
    expect(await queue.list()).toHaveLength(0);
    expect((await queue.counts()).unsent).toBe(0);
  });

  it("issueJobToken を設定しなければ何も発行しない（Cookie 認証のまま使える）", async () => {
    const queue = await makeQueue();
    const job = await queue.enqueue({ type: "t", payload: {} });
    expect(await getJobToken(db, job.jobId)).toBeUndefined();
  });
});

describe("破棄", () => {
  it("送信が成功したら、そのジョブのトークンを消す", async () => {
    const queue = await makeQueue({
      issueJobToken: async () => ({ token: "tok" }),
      processor: okProcessor,
    });
    const job = await queue.enqueue({ type: "t", payload: {} });
    expect(await getJobToken(db, job.jobId)).toBeTruthy();

    await queue.flush({ force: true });
    expect(await getJobToken(db, job.jobId)).toBeUndefined();
  });

  it("キューが空になったらすべて破棄する", async () => {
    const queue = await makeQueue({
      issueJobToken: async () => ({ token: "tok" }),
      processor: okProcessor,
    });
    await queue.enqueue({ jobId: "a", type: "t", payload: {} });
    await queue.enqueue({ jobId: "b", type: "t", payload: {} });

    await queue.flush({ force: true });

    expect(await db.count("tokens")).toBe(0);
  });

  it("未送信が残っている間は破棄しない", async () => {
    const failing: JobProcessor = {
      async process() {
        return { ok: false, error: { kind: "network", retryable: true, message: "圏外", at: 0 } };
      },
    };
    const queue = await makeQueue({
      issueJobToken: async () => ({ token: "tok" }),
      processor: failing,
    });
    const job = await queue.enqueue({ type: "t", payload: {} });

    await queue.flush({ force: true });

    // まだ送れていないので、トークンは持ち続ける
    expect(await getJobToken(db, job.jobId)).toBeTruthy();
  });

  it("破棄・削除でもトークンを残さない", async () => {
    const queue = await makeQueue({ issueJobToken: async () => ({ token: "tok" }) });
    const a = await queue.enqueue({ jobId: "a", type: "t", payload: {} });
    const b = await queue.enqueue({ jobId: "b", type: "t", payload: {} });

    await queue.cancel(a.jobId);
    expect(await getJobToken(db, a.jobId)).toBeUndefined();

    await queue.remove(b.jobId);
    expect(await getJobToken(db, b.jobId)).toBeUndefined();
  });

  it("期限切れは、時計のずれを測れていれば期限切れとして返す", async () => {
    const queue = await makeQueue({
      issueJobToken: async () => ({ token: "tok", expiresAt: Date.now() - 60_000 }),
    });
    const job = await queue.enqueue({ type: "t", payload: {} });

    // ずれ ≒ 0 と分かっている状態
    recordServerDate(new Date().toUTCString());

    const found = await getJobToken(db, job.jobId);
    expect(found).toMatchObject({ expired: true, confident: true });
  });

  it("★ 時計のずれを測れていなければ、期限切れでも捨てない", async () => {
    /*
     * expiresAt はサーバ時刻。端末時計が数時間ずれていると、
     * 有効なトークンを「期限切れ」と誤判定してしまう。
     * 判断の確からしさを添えて返し、送るかどうかは呼び出し側に委ねる。
     */
    resetClockSkew();

    const queue = await makeQueue({
      issueJobToken: async () => ({ token: "tok", expiresAt: Date.now() - 60_000 }),
    });
    const job = await queue.enqueue({ type: "t", payload: {} });

    const found = await getJobToken(db, job.jobId);
    expect(found).toMatchObject({ expired: true, confident: false });
    expect(found?.token.token).toBe("tok");
  });
});
