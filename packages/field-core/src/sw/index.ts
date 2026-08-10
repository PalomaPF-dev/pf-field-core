/**
 * Service Worker。
 *
 * `createFieldServiceWorker` は **Service Worker コンテキスト専用**（worker/sw.ts で呼ぶ）。
 * `registerFieldServiceWorker` / `requestQueueSync` は**ページ側**から呼ぶ。
 */

export { createFieldServiceWorker } from "./service-worker.js";
export type { FieldServiceWorkerRuntimeOptions } from "./service-worker.js";

export {
  askServiceWorkerToFlush,
  registerFieldServiceWorker,
  requestQueueSync,
} from "./register.js";
export type { RegisterOptions, RegisterResult, SyncRequestResult } from "./register.js";

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
