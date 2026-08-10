/**
 * サーバ側（Next.js Route Handler / StorageProvider）。
 *
 * **このエントリはサーバ専用。** `SUPABASE_SECRET_KEY` を読むため、
 * クライアントコンポーネントから import してはいけない
 * （test/no-client-leak.test.ts が、クライアント向けエントリから
 *  このモジュールへ辿れないことを検証する）。
 *
 * M0 では型の契約のみ。supabaseStorageProvider と Route Handler は M3。
 */

export type {
  AuthContext,
  PathContext,
  ServerContext,
  SignUploadFile,
  SignUploadRequest,
  SignUploadResponse,
  SignViewRequest,
  SignViewResponse,
  StorageProvider,
} from "./types.js";

export {
  DEFAULT_ALLOWED_CONTENT_TYPES,
  DEFAULT_SERVER_LIMITS,
  UnauthorizedError,
} from "./types.js";

/** 保存パス。`<companyId>/<appId>/<YYYY>/<MM>/<jobId>/<attachmentId>` */
export { companyIdOfPath, defaultObjectPath, sanitizeSegment } from "./path.js";

/** Supabase Storage 実装 */
export {
  createSupabaseStorageProvider,
  supabaseStorageFromEnv,
  SUPABASE_PROVIDER,
} from "./supabase.js";
export type { SupabaseStorageOptions } from "./supabase.js";

/**
 * S3 互換実装（3-f）。
 * 「差し替えられる」をテストで担保するために置いてある。
 */
export { createS3StorageProvider, S3_PROVIDER } from "./s3.js";
export type { S3StorageOptions } from "./s3.js";

/**
 * Route Handler。**認可の実体はここ**（署名鍵は RLS を迂回するため）。
 */
export { createSignUploadRoute, createSignViewRoute } from "./routes.js";
export type { SignUploadRouteOptions, SignViewRouteOptions } from "./routes.js";
