import type { FieldCoreEvent } from "./events.js";
import type { CompressImageOptions } from "./image/types.js";
import type { DraftStore } from "./draft/store.js";
import type { MasterCache } from "./master/cache.js";
import type { MasterCacheLimits, MasterCollectionInput } from "./master/types.js";
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
   * 認証 —「ジョブ単位の送信トークン」方式。
   *
   * Cookie は使わない。無操作ログアウト（共用端末15分）や
   * セッション期限（12時間）で Cookie が消えても、預かった写真は送れなければならない。
   *
   * 流れ:
   *   1. ジョブ投入時（＝認証が生きている今この瞬間）に issueJobToken でトークンを受け取る
   *   2. IndexedDB の専用ストアに保管する（jobs とは別。list() には乗らない）
   *   3. 送信時に `Authorization: Bearer <jobToken>` で送る
   *   4. 有効期限は既定26時間。キューが空になれば破棄する
   */
  auth?: {
    /**
     * そのジョブ専用の送信トークンを発行する。
     *
     * 認証が生きているうちに1回だけ呼ばれる。ここで失敗すると enqueue も失敗するので、
     * 「撮ったのに預かれない」を避けたい場合はサーバ側を落ちにくく作ること。
     */
    issueJobToken?: (job: { jobId: string; type: string }) => Promise<JobTokenIssue>;

    /**
     * 401 / 403 / ログイン画面へのリダイレクトを受けたときに呼ばれる。
     * true を返せば1回だけ再試行する（トークンを取り直せた場合など）。
     * false ならジョブは `blocked(auth)` として残る。**消さない。**
     */
    onUnauthorized?: (job: { jobId: string; type: string }) => Promise<boolean>;

    /** 全リクエスト共通で足すヘッダ。将来 Bearer 以外へ移る場合の余地 */
    getHeaders?: () => Promise<Record<string, string>>;
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

  /**
   * マスタのローカルキャッシュ（M6）。
   *
   * 一覧系は起動時とオンライン復帰時に全置換で取り直す。
   * メディア（正常見本・図面ピン）は**点検開始時に該当分だけ**先読みする
   * （全設備分を持つと容量が持たない）。
   */
  master?: {
    /**
     * 会社・工場のスコープ。**取得範囲を絞るのは容量のためだけではない。**
     * 全社分を端末に置くと、テナント分離が端末の中で崩れる。
     */
    scope: string;
    /** 一覧系マスタの取得 */
    fetchCollections?: (scope: string) => Promise<MasterCollectionInput[]>;
    limits?: Partial<MasterCacheLimits>;
    /** 起動時に取り直すか。既定 true */
    refreshOnStart?: boolean;
  };

  /** アプリ既定の圧縮設定 */
  image?: CompressImageOptions;

  logger?: FieldLogger;
  logLevel?: LogLevel;

  /** 監視・計測フック */
  onEvent?: (event: FieldCoreEvent) => void;
}

export interface JobTokenIssue {
  token: string;
  /** epoch ms。省略時は発行から26時間 */
  expiresAt?: number;
}

export type { FieldCoreEvent } from "./events.js";

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
  /**
   * 下書き（入力中の値）の保管。
   * Zebra 端末は WebView をバックグラウンドで kill するので、
   * ここに落としておかないと「圏外で入力を継続する」が成立しない。
   */
  drafts: DraftStore;
  /**
   * マスタのローカルキャッシュ。圏外で点検を新規に開始するための土台。
   * `config.master` を設定していない場合も、空のキャッシュとして使える。
   */
  master: MasterCache;
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
