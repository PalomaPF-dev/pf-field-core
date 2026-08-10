import type { CompressedImage, CompressImageOptions } from "../image/types.js";
import type { StorageHealth } from "../db/quota.js";
import type { StoredObjectRef } from "../storage/types.js";

/**
 * ジョブの状態。
 *
 * `failed`（再試行の上限に到達）と `blocked`（人手が要る恒久エラー）を分けているのが要点。
 * 圏外での自動再試行と、認証切れ・入力不備のような「待っても直らない」ものを
 * 同じ扱いにすると、現場では「いつまでも送信中のまま」になって信頼を失う。
 */
export type QueueJobStatus =
  /** 待機中。nextAttemptAt を過ぎたら実行できる */
  | "pending"
  /** 実行中 */
  | "active"
  /** 送信完了 */
  | "succeeded"
  /** 再試行の上限に到達。手動再送で pending に戻せる */
  | "failed"
  /** 恒久エラー（認証切れ / バリデーション）。同じ条件で再送しても通らない */
  | "blocked"
  /** 利用者が破棄した */
  | "canceled";

export type QueueJobPhase = "signing" | "uploading" | "submitting";

export type QueueAttachmentStatus = "pending" | "uploaded" | "failed";

export interface QueueAttachmentInput {
  /** 省略時は UUID を採番 */
  attachmentId?: string;
  blob: Blob;
  fileName: string;
  /** 省略時は blob.type */
  contentType?: string;
  /** 'before' | 'after' | 'defect' などアプリ定義 */
  role?: string;
  /** false で圧縮をスキップ（PDF・署名画像など） */
  compress?: CompressImageOptions | false;
  meta?: Record<string, unknown>;
}

export interface QueueAttachment {
  attachmentId: string;
  fileName: string;
  contentType: string;
  bytes: number;
  role?: string;
  status: QueueAttachmentStatus;
  /** アップロード完了後に確定する保存先。ここが埋まった添付は再送しない */
  ref?: StoredObjectRef;
  uploadedAt?: number;
  /** 圧縮の結果（Blob は含まない）。実機での効き具合を後から追えるように残す */
  compression?: Omit<CompressedImage, "blob">;
  meta?: Record<string, unknown>;
}

export interface QueueJobInput<P = unknown> {
  /** クライアント発行 UUID = 冪等キー。省略時は採番 */
  jobId?: string;
  /** 'setsubi.inspection' 等 */
  type: string;
  payload: P;
  attachments?: QueueAttachmentInput[];
  /** config.endpoints.submit を上書き */
  submitUrl?: string;
  maxAttempts?: number;
  /** 大きいほど先に処理する。既定 0 */
  priority?: number;
  /** 未送信一覧に出す表示名（例: 「設備No.1234 点検」） */
  label?: string;
  meta?: Record<string, unknown>;
}

export interface QueueJobProgress {
  uploadedBytes: number;
  totalBytes: number;
  uploadedCount: number;
  totalCount: number;
}

export interface QueueJob<P = unknown> {
  jobId: string;
  type: string;
  label?: string;
  status: QueueJobStatus;
  phase?: QueueJobPhase;
  payload: P;
  attachments: QueueAttachment[];
  attempts: number;
  maxAttempts: number;
  priority: number;
  /** epoch ms。null は「即時実行可能」 */
  nextAttemptAt: number | null;
  lastError?: QueueError;
  progress: QueueJobProgress;
  submitUrl?: string;
  meta?: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
  succeededAt?: number;
}

export type QueueErrorKind =
  | "network"
  | "timeout"
  | "server"
  | "auth"
  | "validation"
  | "quota"
  | "expired"
  | "aborted"
  | "unknown";

export interface QueueError {
  kind: QueueErrorKind;
  /** 待てば直る見込みがあるか。false なら blocked にする */
  retryable: boolean;
  message: string;
  httpStatus?: number;
  at: number;
}

export interface QueueCounts {
  pending: number;
  active: number;
  failed: number;
  blocked: number;
  succeeded: number;
  canceled: number;
  /** 未送信バッジに出す数 = pending + active + failed + blocked */
  unsent: number;
  total: number;
  /** 最も古い未送信ジョブの作成時刻。「最古 2時間前」の表示に使う */
  oldestPendingAt: number | null;
}

export interface QueueFilter {
  status?: QueueJobStatus[];
  type?: string[];
  limit?: number;
  offset?: number;
}

export interface FlushResult {
  attempted: number;
  succeeded: number;
  failed: number;
  skipped: number;
  /** 1件も試さなかったときの理由 */
  reason?: "offline" | "unreachable" | "locked" | "empty" | "stopped";
}

export interface QueueSnapshot {
  counts: QueueCounts;
  isSyncing: boolean;
  lastSyncAt: number | null;
  lastError: QueueError | null;
  /**
   * 端末ストレージと滞留量の状態。
   * 「入らなくなってから気づく」と撮った写真がその場で失われるので、
   * バッジやヘッダで**入らなくなる前に**warn を出せるようにここへ載せている。
   */
  storage: StorageHealth | null;
}

export interface OfflineQueue {
  enqueue<P>(input: QueueJobInput<P>): Promise<QueueJob<P>>;
  get(jobId: string): Promise<QueueJob | undefined>;
  list(filter?: QueueFilter): Promise<QueueJob[]>;
  counts(): Promise<QueueCounts>;

  /**
   * ランナーを1周回す。
   *
   * `force` は利用者の明示操作（「いま送信する」）を表す。
   * 到達性の事前確認を飛ばすことに加え、**バックオフの残り時間も待たない**。
   * 電波の良い所まで歩いてきて押したのに数分待たされると、
   * 現場では「押しても動かない」と受け取られるため。
   */
  flush(options?: { force?: boolean; jobIds?: string[]; signal?: AbortSignal }): Promise<FlushResult>;
  retry(jobId: string): Promise<void>;
  /** includeBlocked: 再ログイン後の救済に使う */
  retryAll(options?: { includeBlocked?: boolean }): Promise<void>;

  cancel(jobId: string): Promise<void>;
  remove(jobId: string): Promise<void>;
  purgeSucceeded(olderThanMs?: number): Promise<number>;

  /** 未送信一覧のサムネイル表示用（ローカルに残っている Blob を返す） */
  getAttachmentBlob(jobId: string, attachmentId: string): Promise<Blob | undefined>;

  /** 端末ストレージと滞留量の状態。容量警告の表示に使う */
  health(): Promise<StorageHealth>;

  start(): void;
  stop(): void;
  subscribe(listener: (snapshot: QueueSnapshot) => void): () => void;

  /** DB 接続とタイマーを閉じる */
  destroy(): Promise<void>;
}
