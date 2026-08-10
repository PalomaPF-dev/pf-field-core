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
