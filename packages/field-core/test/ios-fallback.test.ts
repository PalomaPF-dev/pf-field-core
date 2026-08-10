import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTriggers } from "../src/queue/triggers.js";
import { createOfflineQueue, type OfflineQueueOptions } from "../src/queue/queue.js";
import type { JobProcessor } from "../src/queue/processor.js";
import type { OfflineQueue } from "../src/queue/types.js";
import { openFieldDB, type FieldDB } from "../src/db/open.js";
import { clearSentinel, detectEviction, readSentinel } from "../src/db/eviction.js";
import { noopLogger } from "../src/shared/logger.js";

/**
 * Background Sync が使えない環境（iOS Safari）でのフォールバック。
 *
 * 「iOS では送信されない」ではなく「アプリを開いている間は送信される」。
 * その保証をここで固める。ここが崩れると、iPhone を使う現場だけ
 * 未送信が延々とたまる。
 */

// ---------------------------------------------------------------- トリガ

/** addEventListener を記録する最小の EventTarget */
function createFakeTarget() {
  const listeners = new Map<string, ((event?: Event) => void)[]>();
  return {
    addEventListener(type: string, listener: (event?: Event) => void) {
      const list = listeners.get(type) ?? [];
      list.push(listener);
      listeners.set(type, list);
    },
    removeEventListener(type: string, listener: (event?: Event) => void) {
      const list = listeners.get(type) ?? [];
      listeners.set(
        type,
        list.filter((l) => l !== listener),
      );
    },
    fire(type: string, event?: Event) {
      for (const listener of [...(listeners.get(type) ?? [])]) listener(event);
    },
    count(type: string) {
      return (listeners.get(type) ?? []).length;
    },
  };
}

describe("Background Sync 非対応時の送信トリガ", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("前面復帰・フォーカス・オンライン復帰・bfcache 復帰のすべてで発火する", () => {
    const win = createFakeTarget();
    const doc = { ...createFakeTarget(), visibilityState: "visible" };
    const docTarget = createFakeTarget();
    Object.assign(doc, docTarget);
    vi.stubGlobal("window", win);
    vi.stubGlobal("document", Object.assign(docTarget, { visibilityState: "visible" }));

    const fired: string[] = [];
    const triggers = createTriggers({ onTrigger: (r) => fired.push(r), pollIntervalMs: 0 });
    triggers.start();

    win.fire("online");
    win.fire("focus");
    docTarget.fire("visibilitychange");
    win.fire("pageshow", { persisted: true } as unknown as Event);

    expect(fired).toEqual(["online", "focus", "visible", "restore"]);
    triggers.stop();
  });

  it("bfcache 由来でない pageshow では発火しない", () => {
    // 通常の読み込みでは start() 直後の送信が別途走るので、二重に叩かない
    const win = createFakeTarget();
    vi.stubGlobal("window", win);
    vi.stubGlobal("document", undefined);

    const fired: string[] = [];
    const triggers = createTriggers({ onTrigger: (r) => fired.push(r), pollIntervalMs: 0 });
    triggers.start();

    win.fire("pageshow", { persisted: false } as unknown as Event);
    expect(fired).toEqual([]);
    triggers.stop();
  });

  it("画面が隠れている間の visibilitychange では発火しない", () => {
    const doc = Object.assign(createFakeTarget(), { visibilityState: "hidden" });
    vi.stubGlobal("window", createFakeTarget());
    vi.stubGlobal("document", doc);

    const fired: string[] = [];
    const triggers = createTriggers({ onTrigger: (r) => fired.push(r), pollIntervalMs: 0 });
    triggers.start();

    doc.fire("visibilitychange");
    expect(fired).toEqual([]);
    triggers.stop();
  });

  it("定期ポーリングでも発火する（置きっぱなしで電波が戻った場合）", async () => {
    vi.stubGlobal("window", createFakeTarget());
    vi.stubGlobal("document", undefined);

    const fired: string[] = [];
    const triggers = createTriggers({ onTrigger: (r) => fired.push(r), pollIntervalMs: 20 });
    triggers.start();

    await new Promise((r) => setTimeout(r, 70));
    triggers.stop();

    expect(fired.filter((r) => r === "interval").length).toBeGreaterThanOrEqual(2);
  });

  it("未送信が無ければポーリングを空回りさせない", async () => {
    vi.stubGlobal("window", createFakeTarget());
    vi.stubGlobal("document", undefined);

    const fired: string[] = [];
    const triggers = createTriggers({
      onTrigger: (r) => fired.push(r),
      pollIntervalMs: 20,
      shouldPoll: () => false,
    });
    triggers.start();
    await new Promise((r) => setTimeout(r, 70));
    triggers.stop();

    expect(fired).toEqual([]);
  });

  it("stop() ですべての購読を外す", () => {
    const win = createFakeTarget();
    vi.stubGlobal("window", win);
    vi.stubGlobal("document", undefined);

    const triggers = createTriggers({ onTrigger: () => {}, pollIntervalMs: 0 });
    triggers.start();
    expect(win.count("online")).toBe(1);

    triggers.stop();
    expect(win.count("online")).toBe(0);
    expect(win.count("pageshow")).toBe(0);
  });
});

// ------------------------------------------------------- ストレージ制約

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

const okProcessor: JobProcessor = {
  async process() {
    return { ok: true };
  },
};

let dbCounter = 0;
let db: FieldDB;
let queues: OfflineQueue[] = [];

async function makeQueue(options?: Partial<OfflineQueueOptions>): Promise<OfflineQueue> {
  const queue = await createOfflineQueue({
    appId: "ios-test",
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

/** localStorage の最小実装 */
function stubLocalStorage(initial?: Record<string, string>) {
  const data = new Map<string, string>(Object.entries(initial ?? {}));
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => data.set(k, v),
    removeItem: (k: string) => data.delete(k),
  });
  return data;
}

beforeEach(async () => {
  dbCounter++;
  db = await openFieldDB(`pf-field-ios-${dbCounter}`);
  queues = [];
});

afterEach(async () => {
  for (const queue of queues) await queue.destroy();
  db.close();
  vi.unstubAllGlobals();
});

describe("永続化が拒否された場合", () => {
  function stubStorage(options: { persisted: boolean }) {
    vi.stubGlobal("navigator", {
      storage: {
        estimate: async () => ({ usage: 10 * 1024 * 1024, quota: 1024 * 1024 * 1024 }),
        persist: async () => options.persisted,
        persisted: async () => options.persisted,
      },
    });
  }

  it("未送信を抱えていれば warn にして送信を促す", async () => {
    // iOS では珍しくない。この状態で放置すると7日でブラウザに消される
    stubStorage({ persisted: false });
    stubLocalStorage();
    const queue = await makeQueue();
    await queue.enqueue({ type: "t", payload: {} });

    const health = await queue.health();
    expect(health.persisted).toBe(false);
    expect(health.persistenceDenied).toBe(true);
    expect(health.level).toBe("warn");
    expect(health.reason).toMatch(/保存が保証されていません/);
  });

  it("未送信が無ければ警告しない（不要に不安を煽らない）", async () => {
    stubStorage({ persisted: false });
    stubLocalStorage();
    const queue = await makeQueue();

    const health = await queue.health();
    expect(health.persistenceDenied).toBe(true);
    expect(health.level).toBe("ok");
  });

  it("許可されていれば警告しない", async () => {
    stubStorage({ persisted: true });
    stubLocalStorage();
    const queue = await makeQueue();
    await queue.enqueue({ type: "t", payload: {} });

    const health = await queue.health();
    expect(health.persisted).toBe(true);
    expect(health.persistenceDenied).toBe(false);
    expect(health.level).toBe("ok");
  });

  it("拒否されても保存自体は続く（機能を止めない）", async () => {
    stubStorage({ persisted: false });
    stubLocalStorage();
    const queue = await makeQueue();

    await expect(queue.enqueue({ type: "t", payload: {} })).resolves.toBeTruthy();
    expect((await queue.counts()).unsent).toBe(1);
  });
});

describe("IndexedDB の消失検知", () => {
  it("預かっていたはずなのに空なら消失とみなす", () => {
    const signal = detectEviction({ unsent: 3, at: 1000, dbName: "x" }, 0);
    expect(signal).toEqual({ lostJobs: 3, lastSeenAt: 1000 });
  });

  it("減っただけなら鳴らさない（送信できた可能性のほうが高い）", () => {
    // 誤検知で「データが消えました」と出すほうが害が大きい
    expect(detectEviction({ unsent: 3, at: 1000, dbName: "x" }, 1)).toBeNull();
  });

  it("元から未送信が無ければ鳴らさない", () => {
    expect(detectEviction({ unsent: 0, at: 1000, dbName: "x" }, 0)).toBeNull();
  });

  it("目印が無ければ判定しない（best-effort）", () => {
    // iOS の7日ルールは localStorage も一緒に消すので、この経路は起きうる
    expect(detectEviction(null, 0)).toBeNull();
  });

  it("キューが未送信件数の目印を書く", async () => {
    stubLocalStorage();
    const queue = await makeQueue();
    await queue.enqueue({ type: "t", payload: {} });

    const sentinel = readSentinel("ios-test");
    expect(sentinel?.unsent).toBe(1);
  });

  it("localStorage が使えなくても落ちない", async () => {
    vi.stubGlobal("localStorage", undefined);
    const queue = await makeQueue();
    await expect(queue.enqueue({ type: "t", payload: {} })).resolves.toBeTruthy();
    expect(readSentinel("ios-test")).toBeNull();
  });

  it("起動時に消失を検知してイベントを出す", async () => {
    // 目印だけが残り、IndexedDB が空になった状態を作る
    stubLocalStorage({
      "pf-field-sentinel:ios-test": JSON.stringify({ unsent: 2, at: 1000, dbName: "x" }),
    });

    const events: { type: string; data?: Record<string, unknown> }[] = [];
    const queue = await makeQueue({
      autoStart: true,
      onEvent: (e) => events.push(e),
    });
    // start() の後片付けは非同期
    await new Promise((r) => setTimeout(r, 50));

    const evicted = events.find((e) => e.type === "storage.evicted");
    expect(evicted).toBeTruthy();
    expect(evicted?.data?.lostJobs).toBe(2);
    expect(String(evicted?.data?.message)).toMatch(/失われました/);

    expect((await queue.health()).evictionSuspected).toBe(true);
  });

  it("データが残っていれば消失とみなさない", async () => {
    stubLocalStorage();
    const first = await makeQueue();
    await first.enqueue({ type: "t", payload: {} });

    const events: { type: string }[] = [];
    await makeQueue({ autoStart: true, instanceId: "second", onEvent: (e) => events.push(e) });
    await new Promise((r) => setTimeout(r, 50));

    expect(events.find((e) => e.type === "storage.evicted")).toBeUndefined();
  });

  afterEach(() => {
    clearSentinel("ios-test");
  });
});

describe("容量逼迫時の片付け", () => {
  it("断る前に送信済みジョブを片付ける", async () => {
    stubLocalStorage();
    // 滞留上限を小さくして逼迫状態を作る
    const queue = await makeQueue({
      processor: okProcessor,
      retention: { maxUnsentJobs: 2 },
    });

    await queue.enqueue({ jobId: "a", type: "t", payload: {} });
    await queue.flush({ force: true });
    expect((await queue.counts()).succeeded).toBe(1);

    await queue.enqueue({ jobId: "b", type: "t", payload: {} });
    await queue.enqueue({ jobId: "c", type: "t", payload: {} });

    // 上限に当たる直前で、送信済みのレコードは片付けられている
    await expect(queue.enqueue({ jobId: "d", type: "t", payload: {} })).rejects.toThrow();
    expect((await queue.counts()).succeeded).toBe(0);
  });

  it("未送信ジョブは片付けの対象にしない", async () => {
    // 端末にしか無いデータなので、容量のために捨てる選択肢は無い
    stubLocalStorage();
    const queue = await makeQueue({ retention: { maxUnsentJobs: 2 } });
    await queue.enqueue({ jobId: "a", type: "t", payload: {} });
    await queue.enqueue({ jobId: "b", type: "t", payload: {} });

    await expect(queue.enqueue({ jobId: "c", type: "t", payload: {} })).rejects.toThrow();

    expect(await queue.get("a")).toBeTruthy();
    expect(await queue.get("b")).toBeTruthy();
  });
});
