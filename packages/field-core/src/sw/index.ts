/**
 * Service Worker ビルダー。**Service Worker コンテキスト専用。**
 * M0 では型の契約のみ。createFieldServiceWorker の実装は M5。
 */

export type {
  ApiCacheOptions,
  AppShellOptions,
  CacheStrategy,
  FieldServiceWorkerOptions,
  PrecacheEntry,
  QueueSyncOptions,
  SignedMediaOptions,
} from "./types.js";

export { DEFAULT_SW_OPTIONS } from "./types.js";
