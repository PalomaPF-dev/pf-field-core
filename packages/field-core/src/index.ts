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
