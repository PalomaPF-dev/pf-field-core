export type CacheStrategy = "cache-first" | "network-first" | "stale-while-revalidate";

export interface PrecacheEntry {
  url: string;
  /** ビルドごとに変わる版数。これが変われば入れ替える */
  revision: string;
}

export interface AppShellOptions {
  /**
   * 認証済みページは **Cache First にしない**。
   * pf-setsubi の middleware が `Cache-Control: private, no-store` を付けており、
   * 会社スコープの HTML を端末に残さない設計になっているため
   * （docs/auth-findings.md §4-5）。
   */
  strategy?: CacheStrategy;
  /** プリキャッシュしてよい静的ページだけを列挙する。既定 ['/offline'] */
  precacheRoutes?: string[];
  /** ナビゲーションが失敗したときに返すページ */
  navigationFallback?: string;
}

export interface ApiCacheOptions {
  strategy?: CacheStrategy;
  /** ネットワーク応答を待つ上限。既定 3000ms（弱電界で固まらせない） */
  timeoutMs?: number;
  include?: RegExp[];
  /** この中に該当したものだけキャッシュに残す（参照系マスタ等） */
  cacheable?: RegExp[];
  /** 署名URL・認証・アップロードは必ずここに入れる */
  exclude?: RegExp[];
  maxAgeMs?: number;
}

export interface SignedMediaOptions {
  include?: RegExp[];
  /**
   * 署名付きURLはトークンがクエリに載るため、そのままだと毎回キャッシュミスし
   * キャッシュが際限なく膨らむ。パス部分だけを鍵にして同じ画像を再利用する。
   */
  normalizeCacheKey?: "strip-query" | ((url: URL) => string);
  maxEntries?: number;
}

export interface QueueSyncOptions {
  /** Background Sync のタグ。既定 'pf-field-queue' */
  syncTag?: string;
  /** Periodic Background Sync は条件が厳しいので既定 false */
  enablePeriodicSync?: boolean;
  periodicSyncTag?: string;
  periodicSyncMinIntervalMs?: number;
}

export interface FieldServiceWorkerOptions {
  appId: string;
  /** ビルドごとに変わる値（NEXT_PUBLIC_BUILD_ID 等） */
  version: string;
  precache?: PrecacheEntry[];
  appShell?: AppShellOptions;
  api?: ApiCacheOptions;
  signedMedia?: SignedMediaOptions;
  queue?: QueueSyncOptions;
  /**
   * 既定 false。点検入力の途中で SW が入れ替わってリロードされる事故を防ぐ。
   * 更新は useServiceWorkerUpdate() で明示的に促す。
   */
  skipWaiting?: boolean;
}

export const DEFAULT_SW_OPTIONS = {
  appShell: {
    strategy: "network-first" as CacheStrategy,
    precacheRoutes: ["/offline"],
    navigationFallback: "/offline",
  },
  api: {
    strategy: "network-first" as CacheStrategy,
    timeoutMs: 3_000,
    maxAgeMs: 24 * 60 * 60 * 1000,
  },
  queue: {
    syncTag: "pf-field-queue",
    enablePeriodicSync: false,
  },
  skipWaiting: false,
} as const;
