/**
 * playground の Service Worker。**アプリ側が書く sw.ts の見本**でもある。
 *
 * `pf-field-sw build` が `public/sw.js` に束ねる。
 * precache 一覧とビルド識別子はビルド時に差し込まれる。
 */
import { createFieldServiceWorker } from "@palomapf-dev/pf-field-core/sw";
import {
  createHttpSubmitAdapter,
  createOfflineQueue,
  createUploadProcessor,
} from "@palomapf-dev/pf-field-core";
import { createHttpSignedStorageAdapter } from "@palomapf-dev/pf-field-core/storage";

declare const __PF_FIELD_PRECACHE__: { url: string; revision: string }[];
declare const __PF_FIELD_BUILD_ID__: string;

createFieldServiceWorker({
  appId: "playground",
  version: __PF_FIELD_BUILD_ID__,
  precache: __PF_FIELD_PRECACHE__,

  api: {
    // 署名の発行・認証・アップロードは絶対にキャッシュしない
    exclude: [/^\/api\/(uploads|token|submit|files)/],
    include: [/^\/api\//],
    cacheable: [/^\/api\/health/],
  },

  signedMedia: {
    include: [/^\/api\/uploads\/get\//],
    // 署名はクエリに載るので、パスだけを鍵にする
    normalizeCacheKey: "strip-query",
  },

  /**
   * Background Sync 用のキュー。
   *
   * issueJobToken は渡さない — Service Worker にはセッションが無く、
   * 新規発行はできない。投入時に預けたトークンで送るので requireJobToken を立てる。
   */
  createQueue: () =>
    createOfflineQueue({
      appId: "playground-app",
      requireJobToken: true,
      autoStart: false,
      pollIntervalMs: 0,
      processor: createUploadProcessor({
        storage: createHttpSignedStorageAdapter({ signUrl: "/api/uploads/sign" }),
        submit: createHttpSubmitAdapter({ urls: { "playground.inspection": "/api/submit" } }),
      }),
    }),
});
