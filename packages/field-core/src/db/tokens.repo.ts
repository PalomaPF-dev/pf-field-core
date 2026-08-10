import { now } from "../shared/clock.js";
import { judgeExpiry } from "../shared/clock-skew.js";
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

/**
 * トークンを返す。**期限切れでも、判断に自信が無ければ返す。**
 *
 * `expiresAt` はサーバ時刻で発行されるのに、端末はそれを端末時計と比べている。
 * 端末が数時間進んでいると、有効なトークンを「期限切れ」と誤判定し、
 * 一度も送信を試みないまま blocked(auth) に落ちる。
 * 認証の正否を決めるのはサーバなので、端末時計だけを根拠に止めない。
 *
 * @returns `token` … 送信に使うもの（期限切れの疑いがあっても、試す価値があれば返す）
 *          `expired` … 端末の判断として期限切れか
 *          `confident` … その判断を信じてよいか（時計のずれを測れているか）
 */
export async function getJobToken(
  db: FieldDB,
  jobId: string,
): Promise<
  { token: StoredJobToken; expired: boolean; confident: boolean } | undefined
> {
  const token = await db.get("tokens", jobId);
  if (!token) return undefined;

  const verdict = judgeExpiry(token.expiresAt);
  if (!verdict.expired) return { token, expired: false, confident: true };

  // 期限切れが確かなときだけ、無いものとして扱う
  if (verdict.confident) return { token, expired: true, confident: true };

  // 時計が当てにならない。送って、サーバに決めてもらう
  return { token, expired: true, confident: false };
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
