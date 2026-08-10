import type { DBSchema } from "idb";
import type { QueueJob, QueueJobStatus } from "../queue/types.js";

/**
 * IndexedDB のスキーマ。
 *
 * ジョブ本体と画像 Blob を別ストアに分けているのが要点。
 * 未送信一覧を開くたびに数MBの画像を読み込むわけにはいかないため、
 * `jobs` には添付の**メタ情報だけ**を持たせ、実体は `blobs` に置く。
 */

/** 永続化されるジョブ。実行中を検知するための activeSince が増えている */
export interface StoredJob extends QueueJob {
  /**
   * `active` になった時刻。
   * WebView が突然 kill されると `active` のまま残るので、
   * 一定時間を過ぎたものは pending へ戻して回収する（Zebra 端末では現実に起きる）。
   */
  activeSince?: number;
  /** 実行中のインスタンス。多タブでの取り違えを避けるため */
  activeBy?: string;
}

export interface StoredBlob {
  /** `${jobId}:${attachmentId}` */
  id: string;
  jobId: string;
  attachmentId: string;
  blob: Blob;
  bytes: number;
}

/**
 * ジョブ単位の送信トークン。
 *
 * **ジョブ本体とは別のストアに置く。** `jobs` に入れると queue.list() の戻り値に
 * 乗り、UI やログに流出しうるため。ここは送信ランナーだけが読む。
 */
export interface StoredJobToken {
  jobId: string;
  token: string;
  /** epoch ms。既定は発行から26時間 */
  expiresAt: number;
  createdAt: number;
}

export interface MetaRecord {
  key: string;
  value: unknown;
  updatedAt: number;
}

export interface FieldCoreDB extends DBSchema {
  jobs: {
    key: string;
    value: StoredJob;
    indexes: {
      "by-status": QueueJobStatus;
      "by-created": number;
      "by-type": string;
      /** 成功ジョブの自動削除に使う */
      "by-succeeded": number;
    };
  };
  blobs: {
    key: string;
    value: StoredBlob;
    indexes: {
      "by-job": string;
    };
  };
  meta: {
    key: string;
    value: MetaRecord;
  };
  tokens: {
    key: string;
    value: StoredJobToken;
    indexes: {
      "by-expires": number;
    };
  };
}

/**
 * 送信トークンの既定の有効期限。
 *
 * 26時間にしてあるのは、next-auth のセッション（12時間）より長く、
 * 「夕方に撮って翌朝に圏内へ戻る」までを1本のトークンで賄うため。
 * これより長くしても、キューが空になれば破棄されるので端末に残り続けはしない。
 */
export const DEFAULT_JOB_TOKEN_TTL_MS = 26 * 60 * 60 * 1000;

export const DB_VERSION = 1;

export const META_KEYS = {
  /** 送信ランナーのリース（Web Locks が使えない環境のフォールバック） */
  runnerLease: "runner-lease",
  /** この端末のインスタンス識別子 */
  instanceId: "instance-id",
  /** navigator.storage.persist() の結果を覚えておく */
  persisted: "storage-persisted",
} as const;

export function defaultDbName(appId: string): string {
  return `pf-field-${appId}`;
}

export function blobKey(jobId: string, attachmentId: string): string {
  return `${jobId}:${attachmentId}`;
}

/** 未送信とみなす状態。未送信バッジと滞留上限の対象になる */
export const UNSENT_STATUSES: QueueJobStatus[] = ["pending", "active", "failed", "blocked"];

export function isUnsent(status: QueueJobStatus): boolean {
  return UNSENT_STATUSES.includes(status);
}
