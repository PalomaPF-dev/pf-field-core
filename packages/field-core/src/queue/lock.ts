import { now } from "../shared/clock.js";
import type { FieldDB } from "../db/open.js";
import { META_KEYS } from "../db/schema.js";

/**
 * 送信ランナーの排他。
 *
 * 複数タブと Service Worker が同時に走っても、同じジョブを二重に送らないようにする。
 * サーバ側は冪等キーで重複を吸収するが、無駄な通信は弱電界では致命的なので
 * 端末側でも1つに絞る。
 *
 * Web Locks が使えればそれを使い、無ければ IndexedDB のリースで代用する。
 */
export interface RunnerLock {
  release(): Promise<void>;
  readonly kind: "web-locks" | "idb-lease";
}

export interface LeaseRecord {
  owner: string;
  expiresAt: number;
}

/** リースの寿命。短すぎると正常なランナーを追い出し、長すぎると復帰が遅れる */
export const LEASE_TTL_MS = 30_000;
/** リースを延長する間隔 */
export const LEASE_RENEW_MS = 10_000;

function webLocksAvailable(): boolean {
  return typeof navigator !== "undefined" && typeof navigator.locks?.request === "function";
}

/**
 * ロックを取る。取れなければ null（他が動いているので今回は何もしない）。
 */
export async function acquireRunnerLock(
  db: FieldDB,
  instanceId: string,
  options?: { name?: string; ttlMs?: number; renewMs?: number; forceIdbLease?: boolean },
): Promise<RunnerLock | null> {
  const name = options?.name ?? "pf-field-runner";

  if (webLocksAvailable() && !options?.forceIdbLease) {
    return acquireWebLock(name);
  }
  return acquireIdbLease(db, instanceId, options);
}

function acquireWebLock(name: string): Promise<RunnerLock | null> {
  return new Promise<RunnerLock | null>((resolve) => {
    let settled = false;
    navigator.locks
      .request(name, { ifAvailable: true }, (lock) => {
        if (!lock) {
          settled = true;
          resolve(null);
          return;
        }
        // コールバックが返した Promise が解決するまでロックを保持する
        let release!: () => void;
        const held = new Promise<void>((r) => {
          release = r;
        });
        settled = true;
        resolve({
          kind: "web-locks",
          release: async () => {
            release();
          },
        });
        return held;
      })
      .catch(() => {
        if (!settled) resolve(null);
      });
  });
}

/**
 * IndexedDB のレコードでリースを取る（Web Locks が無い環境向け）。
 *
 * 読み取りと書き込みを1トランザクションに収めているのが要点。
 * 分けると、2つのタブが同時に「空いている」と判断して両方が走る。
 */
async function acquireIdbLease(
  db: FieldDB,
  instanceId: string,
  options?: { ttlMs?: number; renewMs?: number },
): Promise<RunnerLock | null> {
  const ttlMs = options?.ttlMs ?? LEASE_TTL_MS;
  const renewMs = options?.renewMs ?? LEASE_RENEW_MS;
  const at = now();

  const acquired = await withLease(db, (current) => {
    if (current && current.expiresAt > at && current.owner !== instanceId) return null;
    return { owner: instanceId, expiresAt: at + ttlMs };
  });

  if (!acquired) return null;

  // 保持している間は定期的に延長する。延長しないと長い送信の途中で他タブに奪われる
  const timer = setInterval(() => {
    void withLease(db, (current) => {
      if (current && current.owner !== instanceId) return null; // 奪われていた
      return { owner: instanceId, expiresAt: now() + ttlMs };
    });
  }, renewMs);

  return {
    kind: "idb-lease",
    release: async () => {
      clearInterval(timer);
      await withLease(db, (current) =>
        current && current.owner === instanceId ? { owner: instanceId, expiresAt: 0 } : null,
      );
    },
  };
}

/** リースレコードを1トランザクションで読み書きする。update が null を返せば書き込まない。 */
async function withLease(
  db: FieldDB,
  update: (current: LeaseRecord | undefined) => LeaseRecord | null,
): Promise<boolean> {
  const tx = db.transaction("meta", "readwrite");
  const record = await tx.store.get(META_KEYS.runnerLease);
  const current = record?.value as LeaseRecord | undefined;
  const next = update(current);
  if (next === null) {
    await tx.done;
    return false;
  }
  await tx.store.put({ key: META_KEYS.runnerLease, value: next, updatedAt: now() });
  await tx.done;
  return true;
}

/** 現在のリース（診断用）。 */
export async function readLease(db: FieldDB): Promise<LeaseRecord | undefined> {
  const record = await db.get("meta", META_KEYS.runnerLease);
  return record?.value as LeaseRecord | undefined;
}
