import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createOfflineQueue, type OfflineQueueOptions } from "../src/queue/queue.js";
import { createUploadProcessor } from "../src/queue/upload-processor.js";
import { createMemoryStorageAdapter, type MemoryStorage } from "../src/storage/memory.js";
import { uploadFailure } from "../src/storage/transport.js";
import { createHttpSubmitAdapter } from "../src/submit/http.js";
import type { SubmitAdapter } from "../src/submit/types.js";
import type { OfflineQueue, QueueJob } from "../src/queue/types.js";
import type { StoredObjectRef } from "../src/storage/types.js";
import { openFieldDB, type FieldDB } from "../src/db/open.js";
import { getJobToken, putJobToken } from "../src/db/tokens.repo.js";
import { noopLogger } from "../src/shared/logger.js";

/**
 * 送信ランナー（M3）の検証。
 *
 * memory アダプタに対して走らせるので、Supabase もネットワークも要らない。
 * ここで見るのは通信の「やり方」ではなく、**送れていないものを送れたことにしないか**:
 *   - 途中で切れたら、次回は残りの添付だけを送るか
 *   - 401 でジョブを消さずに残すか
 *   - ログイン画面へのリダイレクトを成功と誤認しないか
 *   - 二重に送らないか
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

function photo(bytes = 1000): Blob {
  return new Blob([new Uint8Array(bytes)], { type: "image/jpeg" });
}

/** 呼ばれた回数を数える submit。既定は成功 */
function createSubmit(
  behaviour?: (job: QueueJob, refs: StoredObjectRef[], call: number) => void | Promise<void>,
): SubmitAdapter & { calls: { jobId: string; refs: StoredObjectRef[] }[] } {
  const calls: { jobId: string; refs: StoredObjectRef[] }[] = [];
  return {
    name: "test-submit",
    calls,
    async send(job, refs) {
      const index = calls.length;
      calls.push({ jobId: job.jobId, refs });
      await behaviour?.(job, refs, index);
      return { ok: true };
    },
  };
}

let dbCounter = 0;
let db: FieldDB;
let queues: OfflineQueue[] = [];
let storage: MemoryStorage;

beforeEach(async () => {
  dbCounter++;
  db = await openFieldDB(`pf-field-runner-${dbCounter}`);
  queues = [];
  storage = createMemoryStorageAdapter();
});

afterEach(async () => {
  for (const queue of queues) await queue.destroy();
  db.close();
  vi.unstubAllGlobals();
});

async function makeQueue(
  processorOptions: Parameters<typeof createUploadProcessor>[0],
  queueOptions?: Partial<OfflineQueueOptions>,
): Promise<OfflineQueue> {
  const queue = await createOfflineQueue({
    appId: "test",
    db,
    compress: passthroughCompress,
    logger: noopLogger,
    autoStart: false,
    pollIntervalMs: 0,
    forceIdbLease: true,
    processor: createUploadProcessor({ storage, ...processorOptions }),
    ...queueOptions,
  } as OfflineQueueOptions);
  queues.push(queue);
  return queue;
}

describe("送信ランナー", () => {
  it("署名 → アップロード → 本体送信 を通して成功させる", async () => {
    const submit = createSubmit();
    const queue = await makeQueue({ submit });

    const job = await queue.enqueue({
      type: "setsubi.inspection",
      payload: { equipmentId: "EQ-1" },
      attachments: [
        { blob: photo(1000), fileName: "a.jpg", role: "before" },
        { blob: photo(2000), fileName: "b.jpg", role: "after" },
      ],
    });

    const result = await queue.flush({ force: true });
    expect(result.succeeded).toBe(1);

    // 本体には添付2枚ぶんの ref が載る
    expect(submit.calls).toHaveLength(1);
    expect(submit.calls[0]!.refs).toHaveLength(2);
    expect(storage.objects.size).toBe(2);

    // 送信済みの画像は端末に残さない（容量回復の主役）
    const stored = await queue.get(job.jobId);
    expect(stored?.status).toBe("succeeded");
    expect(await queue.getAttachmentBlob(job.jobId, job.attachments[0]!.attachmentId)).toBeUndefined();
  });

  it("パスはサーバが決める。クライアントは記述子どおりに送るだけ", async () => {
    const submit = createSubmit();
    const queue = await makeQueue({ submit });
    await queue.enqueue({
      type: "setsubi.inspection",
      payload: {},
      attachments: [{ blob: photo(), fileName: "../../etc/passwd" }],
    });

    await queue.flush({ force: true });

    // ファイル名がそのままパスになっていない
    const paths = [...storage.objects.keys()];
    expect(paths[0]).toContain("setsubi.inspection/");
    expect(paths[0]).not.toContain("passwd");
  });

  it("途中で切れたら、次回は残りの添付だけを送る", async () => {
    // 2枚目だけ最初の1回失敗させる
    let failures = 0;
    const failing = createMemoryStorageAdapter({
      beforeUpload: (target) => {
        if (target.attachmentId.endsWith("-2") && failures === 0) {
          failures++;
          throw uploadFailure({ kind: "network", retryable: true, message: "圏外", at: 0 });
        }
      },
    });
    const submit = createSubmit();
    const queue = await makeQueue(
      { submit, storage: failing, attachmentConcurrency: 1 },
      // 待ち時間そのものは backoff.test.ts の担当。ここは再送の中身を見たいので待たない
      { backoff: { baseMs: 0, factor: 1, maxMs: 0, jitter: "none" } },
    );

    const job = await queue.enqueue({
      type: "t",
      payload: {},
      attachments: [
        { attachmentId: "att-1", blob: photo(1000), fileName: "a.jpg" },
        { attachmentId: "att-2", blob: photo(2000), fileName: "b.jpg" },
      ],
    });

    await queue.flush({ force: true });

    // 1枚目は送れている。ジョブは未送信のまま残る
    let current = await queue.get(job.jobId);
    expect(current?.status).toBe("pending");
    expect(current?.attachments[0]!.status).toBe("uploaded");
    expect(current?.attachments[1]!.status).not.toBe("uploaded");
    expect(submit.calls).toHaveLength(0);

    await queue.flush({ force: true });

    current = await queue.get(job.jobId);
    expect(current?.status).toBe("succeeded");

    // ★ 1枚目を送り直していない
    expect(failing.uploadCalls).toEqual(["att-1", "att-2", "att-2"]);
    expect(failing.objects.get("field-uploads/t/" + job.jobId + "/att-1")?.writes).toBe(1);
  });

  it("写真が端末から失われていたら、再試行せず要対応にする", async () => {
    const submit = createSubmit();
    const queue = await makeQueue({ submit });

    const job = await queue.enqueue({
      type: "t",
      payload: {},
      attachments: [{ attachmentId: "att-1", blob: photo(), fileName: "a.jpg" }],
    });

    // ストレージ逼迫で画像だけ退避された状況を作る
    await db.delete("blobs", `${job.jobId}:att-1`);

    await queue.flush({ force: true });

    const current = await queue.get(job.jobId);
    // 待っても戻らないので blocked。無いものを送って本文だけ登録することはしない
    expect(current?.status).toBe("blocked");
    expect(current?.lastError?.kind).toBe("validation");
    expect(submit.calls).toHaveLength(0);
  });

  it("1回の送信で本体を二度送らない", async () => {
    const submit = createSubmit();
    const queue = await makeQueue({ submit });
    await queue.enqueue({
      type: "t",
      payload: {},
      attachments: [{ blob: photo(), fileName: "a.jpg" }],
    });

    await queue.flush({ force: true });
    // 成功したジョブは runnable に出てこないので、もう一度 flush しても送らない
    await queue.flush({ force: true });

    expect(submit.calls).toHaveLength(1);
  });
});

describe("認証", () => {
  it("ジョブ単位のトークンを Authorization: Bearer で送る", async () => {
    const seen: Record<string, string>[] = [];
    const submit: SubmitAdapter = {
      name: "capture",
      async send(_job, _refs, ctx) {
        seen.push(ctx.headers);
        return { ok: true };
      },
    };

    const queue = await makeQueue(
      { submit },
      { issueJobToken: async () => ({ token: "tok-abc" }) },
    );

    await queue.enqueue({
      type: "t",
      payload: {},
      attachments: [{ blob: photo(), fileName: "a.jpg" }],
    });
    await queue.flush({ force: true });

    expect(seen[0]?.Authorization).toBe("Bearer tok-abc");
  });

  it("トークンが期限切れなら、通信せずに要対応へ落とす", async () => {
    const submit = createSubmit();
    const queue = await makeQueue(
      { submit },
      { issueJobToken: async () => ({ token: "tok-abc" }) },
    );

    const job = await queue.enqueue({
      type: "t",
      payload: {},
      attachments: [{ blob: photo(), fileName: "a.jpg" }],
    });

    // 26時間が過ぎた状態にする
    await putJobToken(db, {
      jobId: job.jobId,
      token: "tok-abc",
      expiresAt: Date.now() - 1,
      createdAt: 0,
    });

    await queue.flush({ force: true });

    const current = await queue.get(job.jobId);
    expect(current?.status).toBe("blocked");
    expect(current?.lastError?.kind).toBe("auth");
    // 署名も送信も試していない。投げても 401 になるだけ
    expect(storage.signCalls).toHaveLength(0);
    expect(submit.calls).toHaveLength(0);
  });

  it("401 でもジョブと写真は消さない", async () => {
    const submit: SubmitAdapter = {
      name: "401",
      async send() {
        throw uploadFailure({
          kind: "auth",
          retryable: false,
          message: "認証エラー（HTTP 401）",
          at: 0,
          httpStatus: 401,
        });
      },
    };
    const queue = await makeQueue({ submit });

    const job = await queue.enqueue({
      type: "t",
      payload: {},
      attachments: [{ attachmentId: "att-1", blob: photo(), fileName: "a.jpg" }],
    });

    await queue.flush({ force: true });

    const current = await queue.get(job.jobId);
    expect(current?.status).toBe("blocked");
    expect(current?.lastError?.httpStatus).toBe(401);
    // ★ 端末の写真は残っている。再ログイン後に送り直せる
    expect(await queue.getAttachmentBlob(job.jobId, "att-1")).toBeTruthy();

    const counts = await queue.counts();
    expect(counts.unsent).toBe(1);
  });

  it("onUnauthorized が true を返したら1回だけやり直す", async () => {
    let calls = 0;
    const submit: SubmitAdapter = {
      name: "401-once",
      async send() {
        calls++;
        if (calls === 1) {
          throw uploadFailure({ kind: "auth", retryable: false, message: "401", at: 0 });
        }
        return { ok: true };
      },
    };

    let recovered = 0;
    const queue = await makeQueue({
      submit,
      onUnauthorized: async () => {
        recovered++;
        return true;
      },
    });

    const job = await queue.enqueue({
      type: "t",
      payload: {},
      attachments: [{ blob: photo(), fileName: "a.jpg" }],
    });
    await queue.flush({ force: true });

    expect(recovered).toBe(1);
    expect(calls).toBe(2);
    expect((await queue.get(job.jobId))?.status).toBe("succeeded");
  });

  it("未送信が無くなったらトークンを破棄する", async () => {
    const submit = createSubmit();
    const queue = await makeQueue(
      { submit },
      { issueJobToken: async () => ({ token: "tok-abc" }) },
    );

    const job = await queue.enqueue({ type: "t", payload: {} });
    expect(await getJobToken(db, job.jobId)).toBeTruthy();

    await queue.flush({ force: true });

    expect(await getJobToken(db, job.jobId)).toBeUndefined();
  });
});

describe("HTTP 送信アダプタ", () => {
  /** 応答の形だけを与えるスタブ。fetch と同じ引数で呼ばれたことを検査できるよう型を合わせる */
  function stubFetch(response: { status: number; type?: string; statusText?: string; json?: () => Promise<unknown> }) {
    const fn = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit): Promise<Response> =>
        response as unknown as Response,
    );
    vi.stubGlobal("fetch", fn);
    return fn;
  }

  const job = {
    jobId: "job-1",
    type: "t",
    payload: { a: 1 },
    attachments: [],
    createdAt: 0,
    updatedAt: 0,
  } as unknown as QueueJob;

  it("redirect: manual を必ず付ける（ログイン画面を成功と誤認しないため）", async () => {
    const fn = stubFetch({ status: 200, json: async () => ({}) });
    const adapter = createHttpSubmitAdapter({ urls: { t: "/api/submit" } });

    await adapter.send(job, [], { headers: {} });

    expect(fn).toHaveBeenCalledOnce();
    expect(fn.mock.calls[0]![1]).toMatchObject({ redirect: "manual" });
  });

  it("冪等キーを載せる", async () => {
    const fn = stubFetch({ status: 200, json: async () => ({}) });
    const adapter = createHttpSubmitAdapter({ urls: { t: "/api/submit" } });

    await adapter.send(job, [], { headers: {} });

    const init = fn.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>)["Idempotency-Key"]).toBe("job-1");
  });

  it("ログイン画面へのリダイレクトは失敗（auth）にする", async () => {
    stubFetch({ status: 0, type: "opaqueredirect" });
    const adapter = createHttpSubmitAdapter({ urls: { t: "/api/submit" } });

    await expect(adapter.send(job, [], { headers: {} })).rejects.toMatchObject({
      queueError: { kind: "auth", retryable: false },
    });
  });

  it("409 は「既に受け付け済み」= 成功として扱う", async () => {
    stubFetch({ status: 409 });
    const adapter = createHttpSubmitAdapter({ urls: { t: "/api/submit" } });

    await expect(adapter.send(job, [], { headers: {} })).resolves.toMatchObject({
      ok: true,
      duplicated: true,
    });
  });

  it("503 は待てば直る側に分類する", async () => {
    stubFetch({ status: 503, statusText: "Service Unavailable" });
    const adapter = createHttpSubmitAdapter({ urls: { t: "/api/submit" } });

    await expect(adapter.send(job, [], { headers: {} })).rejects.toMatchObject({
      queueError: { kind: "server", retryable: true },
    });
  });

  it("200 でも本文が JSON でなければ serverId 無しの成功にする", async () => {
    stubFetch({
      status: 200,
      json: async () => {
        throw new Error("not json");
      },
    });
    const adapter = createHttpSubmitAdapter({ urls: { t: "/api/submit" } });

    await expect(adapter.send(job, [], { headers: {} })).resolves.toEqual({ ok: true });
  });

  it("送信先が無ければ、待っても直らない失敗にする", async () => {
    const adapter = createHttpSubmitAdapter({ urls: {} });
    await expect(adapter.send(job, [], { headers: {} })).rejects.toMatchObject({
      queueError: { kind: "validation", retryable: false },
    });
  });
});
