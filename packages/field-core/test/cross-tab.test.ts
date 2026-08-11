import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCrossTabChannel } from "../src/queue/cross-tab.js";
import { createOfflineQueue, type OfflineQueueOptions } from "../src/queue/queue.js";
import type { JobProcessor, ProcessOutcome } from "../src/queue/processor.js";
import type { OfflineQueue } from "../src/queue/types.js";
import { openFieldDB, type FieldDB } from "../src/db/open.js";
import { noopLogger } from "../src/shared/logger.js";

/**
 * 多タブ。
 *
 * 排他（lock.ts）と対になる話で、こちらは**送った結果を他のタブへ伝える**側。
 * 排他だけだと二重送信は防げるが、送信した側のタブだけが 0 件になり、
 * もう一方は未送信バッジを抱えたまま残る。
 * 現場から見ると「片方の画面では送れていない」で、問い合わせになる。
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

const okProcessor: JobProcessor = {
  async process(job, ctx) {
    for (const attachment of job.attachments) {
      await ctx.onAttachmentUploaded(attachment.attachmentId, {
        provider: "supabase",
        bucket: "field-uploads",
        path: `x/${attachment.attachmentId}`,
      });
    }
    return { ok: true } as ProcessOutcome;
  },
};

let dbCounter = 0;
let db: FieldDB;
let queues: OfflineQueue[] = [];

async function makeQueue(options?: Partial<OfflineQueueOptions>): Promise<OfflineQueue> {
  const queue = await createOfflineQueue({
    appId: "cross-tab-test",
    db,
    compress: passthroughCompress,
    logger: noopLogger,
    autoStart: false,
    pollIntervalMs: 0,
    forceIdbLease: true,
    ...options,
  } as OfflineQueueOptions);
  queues.push(queue);
  return queue;
}

beforeEach(async () => {
  dbCounter++;
  db = await openFieldDB(`pf-field-cross-tab-${dbCounter}`);
  queues = [];
});

afterEach(async () => {
  for (const queue of queues) await queue.destroy();
  db.close();
  vi.unstubAllGlobals();
});

describe("チャンネルそのもの", () => {
  it("自分が出したメッセージは自分に返さない（通知が回り続けないこと）", async () => {
    let received = 0;
    const channel = createCrossTabChannel({
      name: "self-echo",
      selfId: "me",
      onRemoteChange: () => received++,
      coalesceMs: 1,
    });

    channel.post();
    await new Promise((r) => setTimeout(r, 30));

    expect(received).toBe(0);
    channel.close();
  });

  it("連続した変更をまとめて1回にする", async () => {
    let received = 0;
    const listener = createCrossTabChannel({
      name: "coalesce",
      selfId: "b",
      onRemoteChange: () => received++,
      coalesceMs: 30,
    });
    const sender = createCrossTabChannel({
      name: "coalesce",
      selfId: "a",
      onRemoteChange: () => {},
    });

    for (let i = 0; i < 5; i++) sender.post();
    await new Promise((r) => setTimeout(r, 80));

    expect(received).toBe(1);
    listener.close();
    sender.close();
  });

  it("BroadcastChannel が無い環境でも落ちない（単一タブの動作は変わらない）", () => {
    vi.stubGlobal("BroadcastChannel", undefined);
    const channel = createCrossTabChannel({
      name: "absent",
      selfId: "me",
      onRemoteChange: () => {},
    });

    expect(channel.available).toBe(false);
    expect(() => {
      channel.post();
      channel.close();
    }).not.toThrow();
  });
});

describe("キューに繋いだとき", () => {
  it("★ 他のタブが積んだぶんが自分の画面にも出る", async () => {
    const a = await makeQueue({ instanceId: "tab-a" });
    const b = await makeQueue({ instanceId: "tab-b" });

    const seen: number[] = [];
    b.subscribe((snapshot) => seen.push(snapshot.counts.unsent));
    // subscribe は現在値を1回流す
    await vi.waitFor(() => expect(seen.length).toBeGreaterThan(0));

    await a.enqueue({ type: "t", payload: {} });

    await vi.waitFor(() => expect(seen.at(-1)).toBe(1), { timeout: 2000 });
  });

  it("★ 他のタブが送り終えたら、こちらの未送信バッジも消える", async () => {
    const a = await makeQueue({ instanceId: "tab-a", processor: okProcessor });
    const b = await makeQueue({ instanceId: "tab-b" });

    await b.enqueue({ type: "t", payload: {} });
    expect((await b.counts()).unsent).toBe(1);

    const seen: number[] = [];
    b.subscribe((snapshot) => seen.push(snapshot.counts.unsent));

    // 送るのは A。B は何もしていないのに 0 にならなければならない
    const result = await a.flush({ force: true });
    expect(result.succeeded).toBe(1);

    await vi.waitFor(() => expect(seen.at(-1)).toBe(0), { timeout: 2000 });
  });

  it("送信中のタブがあるあいだ、もう一方は送信を試みない（排他）", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const slow: JobProcessor = {
      async process(job, ctx) {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 60));
        for (const attachment of job.attachments) {
          await ctx.onAttachmentUploaded(attachment.attachmentId, {
            provider: "supabase",
            bucket: "field-uploads",
            path: `x/${attachment.attachmentId}`,
          });
        }
        inFlight--;
        return { ok: true } as ProcessOutcome;
      },
    };

    const a = await makeQueue({ instanceId: "tab-a", processor: slow });
    const b = await makeQueue({ instanceId: "tab-b", processor: slow });

    await a.enqueue({ type: "t", payload: {} });
    await a.enqueue({ type: "t", payload: {} });

    const [ra, rb] = await Promise.all([a.flush({ force: true }), b.flush({ force: true })]);

    // 片方はロックを取れずに何もしない
    expect([ra.reason, rb.reason]).toContain("locked");
    expect(maxInFlight).toBe(1);
    // ロックを取れた側が2件とも送っている（取りこぼしていない）
    expect(ra.succeeded + rb.succeeded).toBe(2);
  });
});
