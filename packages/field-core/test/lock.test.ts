import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { acquireRunnerLock, readLease } from "../src/queue/lock.js";
import { openFieldDB, type FieldDB } from "../src/db/open.js";
import { createManualClock, setClock } from "../src/shared/clock.js";

/**
 * 送信ランナーの排他。
 *
 * ここが緩むと、複数タブが同じジョブを同時に送る。サーバは冪等キーで
 * 弾いてくれるが、弱電界で無駄な通信を倍にするのは致命的なので端末側で絞る。
 */

let dbCounter = 0;
let db: FieldDB;
let restoreClock: (() => void) | null = null;

beforeEach(async () => {
  dbCounter++;
  db = await openFieldDB(`pf-field-lock-${dbCounter}`);
});

afterEach(() => {
  db.close();
  restoreClock?.();
  restoreClock = null;
  vi.unstubAllGlobals();
});

describe("IndexedDB のリース（Web Locks が無い環境）", () => {
  it("最初の1つだけが取れる", async () => {
    const a = await acquireRunnerLock(db, "tab-a", { forceIdbLease: true });
    const b = await acquireRunnerLock(db, "tab-b", { forceIdbLease: true });

    expect(a).not.toBeNull();
    expect(a?.kind).toBe("idb-lease");
    expect(b).toBeNull();

    await a?.release();
  });

  it("解放すれば次が取れる", async () => {
    const a = await acquireRunnerLock(db, "tab-a", { forceIdbLease: true });
    await a?.release();

    const b = await acquireRunnerLock(db, "tab-b", { forceIdbLease: true });
    expect(b).not.toBeNull();
    await b?.release();
  });

  it("期限切れのリースは奪える（解放できずに落ちた端末からの回復）", async () => {
    const clock = createManualClock(1_000_000);
    restoreClock = setClock(clock);

    const a = await acquireRunnerLock(db, "dead-tab", { forceIdbLease: true, ttlMs: 30_000 });
    expect(a).not.toBeNull();

    // 解放せずに端末が落ちた、という状況
    clock.advance(29_000);
    expect(await acquireRunnerLock(db, "tab-b", { forceIdbLease: true })).toBeNull();

    clock.advance(2_000); // 期限を過ぎた
    const b = await acquireRunnerLock(db, "tab-b", { forceIdbLease: true });
    expect(b).not.toBeNull();
    await b?.release();
  });

  it("同じ持ち主なら取り直せる", async () => {
    const a = await acquireRunnerLock(db, "tab-a", { forceIdbLease: true });
    const again = await acquireRunnerLock(db, "tab-a", { forceIdbLease: true });
    expect(again).not.toBeNull();
    await a?.release();
    await again?.release();
  });

  it("保持している間はリースを延長する", async () => {
    // フェイクタイマーは使わない。fake-indexeddb が内部でタイマーを使っており、
    // 差し替えると IDB の操作ごと止まってしまう。実時間で短く回す
    const clock = createManualClock(1_000_000);
    restoreClock = setClock(clock);

    const lock = await acquireRunnerLock(db, "tab-a", {
      forceIdbLease: true,
      ttlMs: 30_000,
      renewMs: 20,
    });
    const before = (await readLease(db))?.expiresAt;

    clock.advance(5_000);
    await new Promise((r) => setTimeout(r, 80));

    const after = (await readLease(db))?.expiresAt;
    // 延長されていないと、長い送信の途中で他タブに奪われる
    expect(after).toBeGreaterThan(before as number);
    await lock?.release();
  });

  it("解放したら他タブが即座に取れる（期限を待たせない）", async () => {
    const clock = createManualClock(1_000_000);
    restoreClock = setClock(clock);

    const a = await acquireRunnerLock(db, "tab-a", { forceIdbLease: true, ttlMs: 30_000 });
    await a?.release();

    expect((await readLease(db))?.expiresAt).toBe(0);
    const b = await acquireRunnerLock(db, "tab-b", { forceIdbLease: true });
    expect(b).not.toBeNull();
    await b?.release();
  });
});

describe("Web Locks", () => {
  /** navigator.locks の最小実装 */
  function stubWebLocks() {
    const held = new Set<string>();
    vi.stubGlobal("navigator", {
      locks: {
        request: async (
          name: string,
          options: { ifAvailable?: boolean },
          callback: (lock: object | null) => Promise<void> | void,
        ) => {
          if (options.ifAvailable && held.has(name)) return callback(null);
          held.add(name);
          try {
            return await callback({ name });
          } finally {
            held.delete(name);
          }
        },
      },
    });
    return held;
  }

  it("使える環境では Web Locks を使う", async () => {
    stubWebLocks();
    const lock = await acquireRunnerLock(db, "tab-a");
    expect(lock?.kind).toBe("web-locks");
    await lock?.release();
  });

  it("保持中は他が取れない", async () => {
    stubWebLocks();
    const a = await acquireRunnerLock(db, "tab-a");
    const b = await acquireRunnerLock(db, "tab-b");

    expect(a).not.toBeNull();
    expect(b).toBeNull();

    await a?.release();
  });

  it("解放すれば次が取れる", async () => {
    const held = stubWebLocks();
    const a = await acquireRunnerLock(db, "tab-a");
    await a?.release();
    // release() の Promise 解決が反映されるのを待つ
    await new Promise((r) => setTimeout(r, 0));
    expect(held.size).toBe(0);

    const b = await acquireRunnerLock(db, "tab-b");
    expect(b).not.toBeNull();
    await b?.release();
  });

  it("request が失敗しても例外を投げず null を返す", async () => {
    vi.stubGlobal("navigator", {
      locks: {
        request: async () => {
          throw new Error("SecurityError");
        },
      },
    });
    await expect(acquireRunnerLock(db, "tab-a")).resolves.toBeNull();
  });
});
