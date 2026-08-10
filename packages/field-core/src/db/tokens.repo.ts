import { now } from "../shared/clock.js";
import type { FieldDB } from "./open.js";
import type { StoredJobToken } from "./schema.js";

/**
 * ジョブ単位の送信トークン。
 *
 * 認証が生きているうち（＝ジョブ投入時）にサーバから受け取り、端末に預かる。
 * Cookie ではないので、無操作ログアウトでセッションが切れても失われない。
 * これにより「夕方に撮って翌朝に圏内へ戻る」が成立する。
 *
 * トークンは `jobs` とは別ストアに置いてある。`queue.list()` の戻り値に乗ると
 * UI やログに流れうるため、ここは送信ランナーだけが読む。
 */

export async function putJobToken(db: FieldDB, token: StoredJobToken): Promise<void> {
  await db.put("tokens", token);
}

/** 有効なトークンだけを返す。期限切れは無いものとして扱う。 */
export async function getJobToken(
  db: FieldDB,
  jobId: string,
  at = now(),
): Promise<StoredJobToken | undefined> {
  const token = await db.get("tokens", jobId);
  if (!token) return undefined;
  if (token.expiresAt <= at) return undefined;
  return token;
}

export async function deleteJobToken(db: FieldDB, jobId: string): Promise<void> {
  await db.delete("tokens", jobId);
}

/**
 * すべてのトークンを破棄する。
 * キューが空になった時点で呼ぶ。持ち続ける理由が無いものを端末に残さない。
 */
export async function deleteAllJobTokens(db: FieldDB): Promise<number> {
  const tx = db.transaction("tokens", "readwrite");
  const count = await tx.store.count();
  await tx.store.clear();
  await tx.done;
  return count;
}

/** 期限切れのトークンを掃除する。起動時に呼ぶ。 */
export async function deleteExpiredJobTokens(db: FieldDB, at = now()): Promise<number> {
  const tx = db.transaction("tokens", "readwrite");
  let deleted = 0;
  for await (const cursor of tx.store.index("by-expires").iterate(IDBKeyRange.upperBound(at))) {
    await cursor.delete();
    deleted++;
  }
  await tx.done;
  return deleted;
}

/** ジョブが消えたのに残っているトークンを掃除する。 */
export async function deleteOrphanJobTokens(db: FieldDB): Promise<number> {
  const jobIds = new Set(await db.getAllKeys("jobs"));
  const tx = db.transaction("tokens", "readwrite");
  let deleted = 0;
  for await (const cursor of tx.store.iterate()) {
    if (!jobIds.has(cursor.value.jobId)) {
      await cursor.delete();
      deleted++;
    }
  }
  await tx.done;
  return deleted;
}
