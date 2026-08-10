import { deleteDraft, getDraft, listDrafts, putDraft, purgeDraftsOlderThan } from "../db/drafts.repo.js";
import { openFieldDB, type FieldDB } from "../db/open.js";
import { defaultDbName, type StoredDraft } from "../db/schema.js";
import { now } from "../shared/clock.js";
import { uuid } from "../shared/uuid.js";

/**
 * 下書きの保管。
 *
 * **これが無いと「圏外で入力を継続できる」が成立しない。**
 * Zebra 端末は WebView をバックグラウンドで kill する。点検の途中で
 * 端末を胸ポケットに入れた瞬間に入力が消えるなら、オフライン対応とは呼べない。
 *
 * ジョブと違い、下書きは**まだ送信を頼まれていない**もの。
 * 送信を頼まれた（enqueue した）時点で役目を終える。
 */

export interface Draft<T = unknown> {
  draftId: string;
  type: string;
  value: T;
  label?: string;
  createdAt: number;
  updatedAt: number;
}

export interface DraftStore {
  /** 保存する。draftId 省略で新規採番 */
  save<T>(input: { draftId?: string; type: string; value: T; label?: string }): Promise<Draft<T>>;
  get<T>(draftId: string): Promise<Draft<T> | undefined>;
  list<T>(type?: string): Promise<Draft<T>[]>;
  remove(draftId: string): Promise<void>;
  /** 古いものを片付ける。既定では動かない — 書きかけを勝手に消さない */
  purgeOlderThan(ms: number): Promise<number>;
  destroy(): Promise<void>;
}

export interface DraftStoreOptions {
  appId: string;
  dbName?: string;
  /** 既に開いてある接続を使う */
  db?: FieldDB;
}

export async function createDraftStore(options: DraftStoreOptions): Promise<DraftStore> {
  const db = options.db ?? (await openFieldDB(options.dbName ?? defaultDbName(options.appId)));
  const owned = !options.db;

  function toDraft<T>(record: StoredDraft): Draft<T> {
    return {
      draftId: record.draftId,
      type: record.type,
      value: record.value as T,
      ...(record.label !== undefined ? { label: record.label } : {}),
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }

  return {
    async save<T>(input: {
      draftId?: string;
      type: string;
      value: T;
      label?: string;
    }): Promise<Draft<T>> {
      const draftId = input.draftId ?? uuid();
      const existing = input.draftId ? await getDraft(db, input.draftId) : undefined;
      const at = now();

      const record = await putDraft(db, {
        draftId,
        type: input.type,
        value: input.value,
        ...(input.label !== undefined ? { label: input.label } : {}),
        createdAt: existing?.createdAt ?? at,
        updatedAt: at,
      });

      return toDraft<T>(record);
    },

    async get<T>(draftId: string): Promise<Draft<T> | undefined> {
      const record = await getDraft(db, draftId);
      return record ? toDraft<T>(record) : undefined;
    },

    async list<T>(type?: string): Promise<Draft<T>[]> {
      const records = await listDrafts(db, type);
      return records.map((record) => toDraft<T>(record));
    },

    async remove(draftId: string): Promise<void> {
      await deleteDraft(db, draftId);
    },

    async purgeOlderThan(ms: number): Promise<number> {
      return purgeDraftsOlderThan(db, ms);
    },

    async destroy(): Promise<void> {
      if (owned) db.close();
    },
  };
}
