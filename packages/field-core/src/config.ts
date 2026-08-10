import type { CompressImageOptions } from "./image/types.js";
import type { FileUrlResolver, StorageAdapter } from "./storage/types.js";
import type { SubmitAdapter } from "./submit/types.js";
import type { BackoffOptions } from "./queue/backoff.js";
import type { OfflineQueue, QueueJob } from "./queue/types.js";
import type { FieldLogger, LogLevel } from "./shared/logger.js";

export type FieldAppId = "pf-setsubi" | "pf-hinshitsu" | "pf-zaiko" | "pf-keisoku" | (string & {});

export interface FieldCoreConfig {
  appId: FieldAppId;
  /** IndexedDB 名。既定は `pf-field-${appId}` */
  dbName?: string;

  /**
   * アップロード先の抽象。省略時は createHttpSignedStorageAdapter() が使われる。
   * 既定実装は「サーバの /api/uploads/sign が返した記述子どおりに転送する」だけで、
   * 裏が Supabase Storage か S3 かを知らない。
   */
  storage?: StorageAdapter;

  /** レコード本体の送信先の抽象。省略時は httpSubmitAdapter */
  submit?: SubmitAdapter;

  endpoints: {
    /** 到達性プローブ。既定 '/api/health' */
    health?: string;
    /** 署名付きアップロードURLの発行。既定 '/api/uploads/sign' */
    signUpload?: string;
    /** 閲覧用URLの発行。既定 '/api/files/sign-view' */
    signView?: string;
    /** ジョブ種別 → レコード送信先（httpSubmitAdapter 使用時） */
    submit: Record<string, string> | ((job: QueueJob) => string);
  };

  /**
   * 認証。
   *
   * 現構成は next-auth の Cookie 認証なので、同一オリジンへの fetch には
   * 自動で Cookie が載る。getHeaders は将来 Bearer 方式へ移るときの余地として残してある。
   *
   * onUnauthorized は必須級: セッションは12時間・リフレッシュトークン無しのため、
   * 長時間の圏外滞留から復帰すると 401 になる。ここで再ログインへ導く。
   */
  auth?: {
    getHeaders?: () => Promise<Record<string, string>>;
    /** 401/403 のとき呼ばれる。true を返せば1回だけ再試行する */
    onUnauthorized?: () => Promise<boolean>;
  };

  queue?: {
    maxAttempts?: number;
    backoff?: Partial<BackoffOptions>;
    /** 同時に処理するジョブ数。既定 1 */
    concurrency?: number;
    /** 1ジョブ内の添付の同時アップロード数。既定 2（弱電界では自動で 1 に落とす） */
    attachmentConcurrency?: number;
    /** 定期ポーリング間隔。既定 60秒。未送信 0 のときは止まる */
    pollIntervalMs?: number;
    autoStart?: boolean;
    /** 成功ジョブの自動削除。既定 7日 */
    purgeSucceededAfterMs?: number;
    /** 1ジョブあたりの添付上限。既定 10枚 / 合計 8MB */
    maxAttachmentsPerJob?: number;
    maxTotalAttachmentBytes?: number;
  };

  storageQuota?: {
    /** 残量がこれを下回ったら警告イベントを出す。既定 50MB */
    warnBelowBytes?: number;
    /** 残量がこれを下回ったら enqueue を拒否する。既定 20MB */
    blockBelowBytes?: number;
  };

  /** アプリ既定の圧縮設定 */
  image?: CompressImageOptions;

  logger?: FieldLogger;
  logLevel?: LogLevel;

  /** 監視・計測フック */
  onEvent?: (event: FieldCoreEvent) => void;
}

export interface FieldCoreEvent {
  type: string;
  at: number;
  data?: Record<string, unknown>;
}

export interface StorageInfo {
  /** navigator.storage.estimate() の結果 */
  usageBytes: number | null;
  quotaBytes: number | null;
  /** navigator.storage.persist() が許可されたか */
  persisted: boolean;
}

export interface FieldCore {
  queue: OfflineQueue;
  files: FileUrlResolver;
  storage(): Promise<StorageInfo>;
  destroy(): Promise<void>;
}

/** 既定値。アプリ側の設定とマージして使う。 */
export const DEFAULT_ENDPOINTS = {
  health: "/api/health",
  signUpload: "/api/uploads/sign",
  signView: "/api/files/sign-view",
} as const;

export const DEFAULT_QUEUE_LIMITS = {
  maxAttachmentsPerJob: 10,
  maxTotalAttachmentBytes: 8 * 1024 * 1024,
  concurrency: 1,
  attachmentConcurrency: 2,
  pollIntervalMs: 60_000,
  purgeSucceededAfterMs: 7 * 24 * 60 * 60 * 1000,
} as const;

export const DEFAULT_STORAGE_QUOTA = {
  warnBelowBytes: 50 * 1024 * 1024,
  blockBelowBytes: 20 * 1024 * 1024,
} as const;
