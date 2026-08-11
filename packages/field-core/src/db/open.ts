import { openDB, type IDBPDatabase } from "idb";
import { FieldCoreError } from "../shared/errors.js";
import { DB_VERSION, type FieldCoreDB } from "./schema.js";

export type FieldDB = IDBPDatabase<FieldCoreDB>;

/**
 * データベースを開く。
 *
 * 既存の DB のほうが新しい（＝アプリを一度ダウングレードした）場合は
 * IndexedDB が VersionError を投げる。ここで握りつぶすとジョブが消えたように
 * 見えるので、明示的なエラーにして UI に出せるようにしている。
 */
export async function openFieldDB(
  dbName: string,
  options?: {
    /** 他のタブがバージョン更新を待っているときに呼ばれる */
    onBlocking?: () => void;
    /** DB が別タブから削除された・接続が切れたときに呼ばれる */
    onTerminated?: () => void;
  },
): Promise<FieldDB> {
  if (typeof indexedDB === "undefined") {
    throw new FieldCoreError(
      "unsupported_environment",
      "IndexedDB が使えません。オフラインキューを利用できない環境です",
    );
  }

  try {
    return await openDB<FieldCoreDB>(dbName, DB_VERSION, {
      upgrade(db, oldVersion) {
        // v1: 初期スキーマ
        if (oldVersion < 1) {
          const jobs = db.createObjectStore("jobs", { keyPath: "jobId" });
          jobs.createIndex("by-status", "status");
          jobs.createIndex("by-created", "createdAt");
          jobs.createIndex("by-type", "type");
          jobs.createIndex("by-succeeded", "succeededAt");

          const blobs = db.createObjectStore("blobs", { keyPath: "id" });
          blobs.createIndex("by-job", "jobId");

          db.createObjectStore("meta", { keyPath: "key" });

          // 送信トークンはジョブ本体と分ける（list() の戻り値に乗せないため）
          const tokens = db.createObjectStore("tokens", { keyPath: "jobId" });
          tokens.createIndex("by-expires", "expiresAt");
        }
        // v2: 下書き（M4）。既存のストアには触らない
        if (oldVersion < 2) {
          const drafts = db.createObjectStore("drafts", { keyPath: "draftId" });
          drafts.createIndex("by-updated", "updatedAt");
          drafts.createIndex("by-type", "type");
        }
        // v3: マスタのローカルキャッシュ（M6）。既存のストアには触らない
        if (oldVersion < 3) {
          const masters = db.createObjectStore("masters", { keyPath: "key" });
          masters.createIndex("by-collection", "collection");

          const assets = db.createObjectStore("assets", { keyPath: "key" });
          assets.createIndex("by-group", "groupId");
          // 容量が苦しいときに古い順で捨てる
          assets.createIndex("by-fetched", "fetchedAt");
        }
        // 以降のバージョンはここに追記する。
        // 未送信ジョブは端末にしか無いデータなので、移行では絶対に消さないこと。
      },
      blocking() {
        options?.onBlocking?.();
      },
      terminated() {
        options?.onTerminated?.();
      },
    });
  } catch (error) {
    if (error instanceof Error && error.name === "VersionError") {
      throw new FieldCoreError(
        "unsupported_environment",
        "端末に保存されているデータのほうが新しいため開けません。アプリを最新版に更新してください",
        { cause: error },
      );
    }
    throw new FieldCoreError("unsupported_environment", "オフライン用のデータベースを開けませんでした", {
      cause: error,
    });
  }
}
