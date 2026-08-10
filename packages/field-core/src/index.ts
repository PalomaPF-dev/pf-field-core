/**
 * @palomapf-dev/pf-field-core
 *
 * 現場系アプリ共通のオフライン・アップロード基盤。
 * 設計は docs/DESIGN.md を参照。
 *
 * ## M0 時点で使えるもの
 * - 型の契約（キュー / ストレージ / 送信 / 設定）
 * - 指数バックオフの計算
 * - HTTP・例外からのエラー分類（再試行可 / 人手が要る）
 * - UUID・イベントエミッタ・ロガー等の下回り
 *
 * キュー本体（configureFieldCore）は M2、送信ランナーは M3 で入る。
 */

export { VERSION } from "./version.js";

// 設定
export type {
  FieldAppId,
  FieldCore,
  FieldCoreConfig,
  FieldCoreEvent,
  JobTokenIssue,
  StorageInfo,
} from "./config.js";
export { DEFAULT_ENDPOINTS, DEFAULT_QUEUE_LIMITS, DEFAULT_STORAGE_QUOTA } from "./config.js";

// キューの契約
export type {
  FlushResult,
  OfflineQueue,
  QueueAttachment,
  QueueAttachmentInput,
  QueueAttachmentStatus,
  QueueCounts,
  QueueError,
  QueueErrorKind,
  QueueFilter,
  QueueJob,
  QueueJobInput,
  QueueJobPhase,
  QueueJobProgress,
  QueueJobStatus,
  QueueSnapshot,
} from "./queue/types.js";

// バックオフ
export type { BackoffOptions } from "./queue/backoff.js";
export {
  backoffDelay,
  backoffSchedule,
  DEFAULT_BACKOFF,
  DEFAULT_MAX_ATTEMPTS,
  nextAttemptAt,
} from "./queue/backoff.js";

// キュー本体
export { createOfflineQueue } from "./queue/queue.js";
export type { CompressFn, OfflineQueueOptions } from "./queue/queue.js";
export type { JobProcessor, ProcessContext, ProcessOutcome } from "./queue/processor.js";
export { createTriggers } from "./queue/triggers.js";
export type { TriggerReason, Triggers } from "./queue/triggers.js";

// 状態遷移（送信ランナーを自作する場合に使う）
export {
  canTransition,
  InvalidTransitionError,
  isTerminal,
  markActive,
  markAttachmentUploaded,
  markCanceled,
  markFailed,
  markForRetry,
  markSucceeded,
  pendingAttachments,
  releaseToPending,
} from "./queue/state.js";
export type { FailureOutcome } from "./queue/state.js";

/**
 * 送信で使う fetch。
 * ログイン画面へのリダイレクトを成功と誤認しないよう、redirect: "manual" を強制する。
 * 送信経路では素の fetch を使わないこと。
 */
export { classifyResponse, responseError, SAFE_FETCH_INIT, safeFetch } from "./net/fetch-safe.js";
export type { ClassifiableResponse, SafeFetchOptions } from "./net/fetch-safe.js";

// 排他
export { acquireRunnerLock, readLease } from "./queue/lock.js";
export type { LeaseRecord, RunnerLock } from "./queue/lock.js";

// 端末ストレージ
export {
  DEFAULT_QUOTA,
  DEFAULT_RETENTION,
  ensurePersistence,
  estimateStorage,
} from "./db/quota.js";
export type {
  QuotaLimits,
  RetentionLimits,
  StorageEstimate,
  StorageHealth,
} from "./db/quota.js";
export type { UnsentSummary } from "./db/jobs.repo.js";
export { openFieldDB } from "./db/open.js";
export type { FieldDB } from "./db/open.js";
export { defaultDbName } from "./db/schema.js";

// エラー分類
export type { Classification } from "./queue/errors.js";
export {
  classifyHttpStatus,
  classifyThrown,
  isPermanent,
  queueErrorFromResponse,
  queueErrorFromThrown,
  toQueueError,
} from "./queue/errors.js";

// ストレージ・送信の契約（実装は ./storage / ./server から）
export type {
  AdapterContext,
  CreateUploadTargetsRequest,
  FileUrlResolver,
  ResolvedUrl,
  StorageAdapter,
  StoredObjectRef,
  UploadContext,
  UploadFileDescriptor,
  UploadRequestSpec,
  UploadResult,
  UploadTarget,
} from "./storage/types.js";
export { refKey } from "./storage/types.js";

export type { SubmitAdapter, SubmitResult } from "./submit/types.js";
export { IDEMPOTENCY_HEADER } from "./submit/types.js";

// 下回り
export { FieldCoreError, isFieldCoreError, NotImplementedError } from "./shared/errors.js";
export type { FieldCoreErrorCode } from "./shared/errors.js";
export { isUuid, uuid } from "./shared/uuid.js";
export { createEmitter } from "./shared/emitter.js";
export type { Emitter, Listener } from "./shared/emitter.js";
export { createLogger, noopLogger } from "./shared/logger.js";
export type { FieldLogger, LogLevel } from "./shared/logger.js";
export { now } from "./shared/clock.js";
