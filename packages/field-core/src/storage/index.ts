/**
 * ストレージ抽象（端末側）。
 *
 * 既定は `httpSigned` — サーバの `/api/uploads/sign` が返した記述子どおりに転送するだけで、
 * 裏が Supabase Storage か S3 かを知らない。差し替わるのはサーバ側の実装だけ。
 *
 * `memory` は通信しないアダプタ。送信ランナーの検証を Supabase 無しで回すために使う。
 */

export { createHttpSignedStorageAdapter, DEFAULT_SIGN_TIMEOUT_MS } from "./http-signed.js";
export type { HttpSignedAdapterOptions } from "./http-signed.js";

export { createMemoryStorageAdapter } from "./memory.js";
export type { MemoryStorage, MemoryStorageOptions } from "./memory.js";

export {
  canReportProgress,
  DEFAULT_UPLOAD_TIMEOUT_MS,
  UploadFailure,
  uploadFailure,
  uploadToTarget,
} from "./transport.js";
export type { TransportOptions } from "./transport.js";

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
} from "./types.js";

export { refKey } from "./types.js";
