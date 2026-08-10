import { now } from "../shared/clock.js";
import type { FieldDB } from "./open.js";
import type { StoredDraft } from "./schema.js";

/**
 * 下書きの永続化。
 *
 * **これが無いと「圏外で入力を継続できる」が成立しない。**
 * Zebra 端末は WebView をバックグラウンドで kill する。
 * 点検の途中で端末を胸ポケットに入れた時点で入力内容が消えるなら、
 * オフライン対応を名乗れない。
 *
 * ジョブ（`jobs`）とは別物であることに注意:
 *   下書き … まだ送信を頼まれていない。利用者が編集中のもの
 *   ジョブ … 送信を頼まれたもの。以後は field-core が責任を持つ
 *
 * 送信を頼まれた時点で下書きは役目を終える（`enqueue` 成功後に破棄する）。
 */

export async function putDraft(
  db: FieldDB,
  draft: Omit<StoredDraft, "updatedAt"> & { updatedAt?: number },
): Promise<StoredDraft> {
  const record: StoredDraft = { ...draft, updatedAt: draft.updatedAt ?? now() };
  await db.put("drafts", record);
  return record;
}

export async function getDraft(db: FieldDB, draftId: string): Promise<StoredDraft | undefined> {
  return db.get("drafts", draftId);
}

export async function listDrafts(db: FieldDB, type?: string): Promise<StoredDraft[]> {
  const all = type
    ? await db.getAllFromIndex("drafts", "by-type", type)
    : await db.getAll("drafts");
  // 新しいものから。「書きかけの点検」を上に出す
  return all.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function deleteDraft(db: FieldDB, draftId: string): Promise<void> {
  await db.delete("drafts", draftId);
}

/**
 * 古い下書きを片付ける。
 *
 * ジョブと違って下書きは「送られる保証」が無いので、放っておくと端末に溜まる。
 * ただし**既定では消さない**（呼び出し側が明示的に指示したときだけ動く）。
 * 書きかけを勝手に消されるのは、送信済みデータを消されるより体感が悪い。
 */
export async function purgeDraftsOlderThan(db: FieldDB, olderThanMs: number): Promise<number> {
  const before = now() - olderThanMs;
  const stale = (await db.getAll("drafts")).filter((draft) => draft.updatedAt < before);
  for (const draft of stale) await db.delete("drafts", draft.draftId);
  return stale.length;
}
