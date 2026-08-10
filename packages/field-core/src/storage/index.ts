/**
 * ストレージ抽象（端末側）。
 *
 * M0 では型の契約のみ。実装（httpSigned / supabaseDirect / memory アダプタと transport）は M3。
 * 型を先に固めておくことで、M1・M2 の作業がこの契約に向かって進められる。
 */

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
