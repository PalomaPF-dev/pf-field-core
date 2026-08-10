import {
  DEFAULT_ENDPOINTS,
  DEFAULT_QUEUE_LIMITS,
  DEFAULT_STORAGE_QUOTA,
  type FieldCore,
  type FieldCoreConfig,
  type StorageInfo,
} from "./config.js";
import { createDraftStore } from "./draft/store.js";
import { openFieldDB } from "./db/open.js";
import { defaultDbName } from "./db/schema.js";
import { createOfflineQueue } from "./queue/queue.js";
import { createUploadProcessor } from "./queue/upload-processor.js";
import { createHttpSignedStorageAdapter } from "./storage/http-signed.js";
import { createFileUrlResolver } from "./storage/url-resolver.js";
import { createHttpSubmitAdapter } from "./submit/http.js";
import { estimateStorage } from "./db/quota.js";
import { safeFetch } from "./net/fetch-safe.js";
import { createLogger, noopLogger } from "./shared/logger.js";

/**
 * 設定ひとつからキュー一式を組み立てる。
 *
 * アプリ側が個々の部品（アダプタ・ランナー・リゾルバ）を知らずに済むための入口。
 * 部品を差し替えたい場合は `config.storage` / `config.submit` に渡せば、
 * ここは組み立てだけを行う。
 */

export async function configureFieldCore(config: FieldCoreConfig): Promise<FieldCore> {
  const logger = config.logger ?? (config.logLevel ? createLogger(config.logLevel) : noopLogger);
  const endpoints = { ...DEFAULT_ENDPOINTS, ...config.endpoints };
  const limits = { ...DEFAULT_QUEUE_LIMITS, ...config.queue };
  const quota = { ...DEFAULT_STORAGE_QUOTA, ...config.storageQuota };

  const storage =
    config.storage ?? createHttpSignedStorageAdapter({ signUrl: endpoints.signUpload });

  const submit =
    config.submit ??
    createHttpSubmitAdapter({
      urls:
        typeof config.endpoints.submit === "function"
          ? config.endpoints.submit
          : config.endpoints.submit,
    });

  const files = createFileUrlResolver({
    signViewUrl: endpoints.signView,
    ...(config.auth?.getHeaders ? { headers: config.auth.getHeaders } : {}),
  });

  // 接続は1本。キューと下書きで開き直さない
  const db = await openFieldDB(config.dbName ?? defaultDbName(config.appId));
  const drafts = await createDraftStore({ appId: config.appId, db });

  const queue = await createOfflineQueue({
    appId: config.appId,
    db,

    processor: createUploadProcessor({
      storage,
      submit,
      attachmentConcurrency: limits.attachmentConcurrency,
      ...(config.auth?.onUnauthorized ? { onUnauthorized: config.auth.onUnauthorized } : {}),
      logger,
    }),

    /*
     * 送信前の到達性確認。
     *
     * `navigator.onLine` は「電波があるか」しか見ておらず、
     * 認証切れのキャプティブポータルや、繋がっているのに通らない状態（lie-fi）を
     * 見抜けない。届かないと分かっているなら、試行回数を消費させない。
     */
    precheck: async () => {
      if (typeof navigator !== "undefined" && navigator.onLine === false) return false;
      if (!endpoints.health) return true;
      try {
        const response = await safeFetch(endpoints.health, { method: "GET", timeoutMs: 5_000 });
        return response.status >= 200 && response.status < 400;
      } catch {
        return false;
      }
    },

    ...(config.auth?.issueJobToken ? { issueJobToken: config.auth.issueJobToken } : {}),
    ...(config.auth?.getHeaders ? { authHeaders: config.auth.getHeaders } : {}),

    ...(config.image ? { imageOptions: config.image } : {}),
    ...(limits.maxAttempts !== undefined ? { maxAttempts: limits.maxAttempts } : {}),
    ...(config.queue?.backoff ? { backoff: config.queue.backoff } : {}),
    concurrency: limits.concurrency,
    pollIntervalMs: limits.pollIntervalMs,
    autoStart: config.queue?.autoStart ?? true,

    retention: {
      succeededMaxAgeMs: limits.purgeSucceededAfterMs,
      maxUnsentAttachments: limits.maxAttachmentsPerJob * 20,
      maxUnsentBytes: limits.maxTotalAttachmentBytes * 20,
    },
    quota: {
      warnBelowBytes: quota.warnBelowBytes,
      blockBelowBytes: quota.blockBelowBytes,
    },

    logger,
    ...(config.onEvent ? { onEvent: config.onEvent } : {}),
  });

  return {
    queue,
    files,
    drafts,

    async storage(): Promise<StorageInfo> {
      const estimate = await estimateStorage();
      const health = await queue.health();
      return {
        usageBytes: estimate.usageBytes,
        quotaBytes: estimate.quotaBytes,
        persisted: health.persisted,
      };
    },

    async destroy() {
      files.invalidate();
      await drafts.destroy();
      // 接続を閉じるのはキュー側（db を渡してあるので二重には閉じない）
      await queue.destroy();
    },
  };
}
