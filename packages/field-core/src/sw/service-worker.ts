import type { OfflineQueue } from "../queue/types.js";
import {
  DEFAULT_SW_OPTIONS,
  type CacheStrategy,
  type FieldServiceWorkerOptions,
  type PrecacheEntry,
} from "./types.js";

/**
 * Service Worker の実体。**Service Worker コンテキスト専用。**
 *
 * ここが担うのは3つ:
 *   1. アプリシェルと静的資産のキャッシュ（圏外でも画面が開く）
 *   2. 署名付きメディアのキャッシュ鍵の正規化
 *   3. Background Sync — アプリを閉じたあとに送信を完了させる
 *
 * ## 認証済み HTML を Cache First にしない
 *
 * pf-setsubi の middleware は認証済みページに `Cache-Control: private, no-store` を付ける。
 * 会社スコープの HTML を端末に残さない設計なので、こちらが勝手にキャッシュしてはいけない
 * （docs/auth-findings.md §4-5）。だから既定は Network First で、
 * 落ちたときだけオフライン用ページを返す。
 */

/** SW のグローバル。DOM の型と混ざらないよう最小限だけ定義する */
export interface ServiceWorkerScope {
  addEventListener(type: string, listener: (event: never) => void): void;
  skipWaiting(): Promise<void>;
  clients: { claim(): Promise<void>; matchAll(options?: unknown): Promise<unknown[]> };
  caches: CacheStorage;
  fetch: typeof fetch;
  location: { href: string };
}

interface ExtendableEventLike {
  waitUntil(promise: Promise<unknown>): void;
}

interface FetchEventLike extends ExtendableEventLike {
  request: Request;
  respondWith(response: Response | Promise<Response>): void;
}

interface SyncEventLike extends ExtendableEventLike {
  tag: string;
}

export interface FieldServiceWorkerRuntimeOptions extends FieldServiceWorkerOptions {
  /**
   * Background Sync で送るためのキューを作る。
   *
   * **`issueJobToken` は渡さないこと。** Service Worker にはセッションが無いので
   * 新規発行はできない。投入時に預けたトークンで送るため、代わりに
   * `requireJobToken: true` を指定する。
   *
   * 省略すると sync は登録されず、送信は画面が開いているときだけになる。
   */
  createQueue?: () => Promise<OfflineQueue>;
}

/**
 * @param scope 差し替え可能な SW グローバル。既定は `globalThis`。
 *   テストから globalThis そのものを差し替えると実行環境ごと壊れるので、
 *   受け口を1つだけ開けてある。
 */
export function createFieldServiceWorker(
  options: FieldServiceWorkerRuntimeOptions,
  scope?: ServiceWorkerScope,
): void {
  const self = scope ?? (globalThis as unknown as ServiceWorkerScope);
  const swOrigin = (() => {
    try {
      return new URL(self.location.href).origin;
    } catch {
      return "";
    }
  })();

  const appShell = { ...DEFAULT_SW_OPTIONS.appShell, ...options.appShell };
  const api = { ...DEFAULT_SW_OPTIONS.api, ...options.api };
  const sync = { ...DEFAULT_SW_OPTIONS.queue, ...options.queue };
  const media = options.signedMedia ?? {};

  // 版数を鍵に混ぜる。デプロイのたびに古い資産と入れ替わる
  const shellCache = `pf-field-${options.appId}-shell-${options.version}`;
  const apiCache = `pf-field-${options.appId}-api-${options.version}`;
  const mediaCache = `pf-field-${options.appId}-media-${options.version}`;
  const ours = (name: string) => name.startsWith(`pf-field-${options.appId}-`);

  // ---------------------------------------------------------------- install

  self.addEventListener("install", ((event: ExtendableEventLike) => {
    event.waitUntil(
      (async () => {
        const cache = await self.caches.open(shellCache);
        const urls = [
          ...(options.precache ?? []).map((entry: PrecacheEntry) => entry.url),
          ...(appShell.precacheRoutes ?? []),
        ];
        // 1つ落ちても install ごと失敗させない。
        // 失敗すると SW が入らず、オフライン機能が丸ごと無効になる
        await Promise.allSettled(urls.map((url) => cache.add(url)));

        if (options.skipWaiting) await self.skipWaiting();
      })(),
    );
  }) as (event: never) => void);

  // --------------------------------------------------------------- activate

  self.addEventListener("activate", ((event: ExtendableEventLike) => {
    event.waitUntil(
      (async () => {
        const names = await self.caches.keys();
        await Promise.all(
          names
            .filter((name) => ours(name) && ![shellCache, apiCache, mediaCache].includes(name))
            .map((name) => self.caches.delete(name)),
        );
        await self.clients.claim();
      })(),
    );
  }) as (event: never) => void);

  // ------------------------------------------------------------------ fetch

  function matches(url: URL, patterns?: RegExp[]): boolean {
    return (patterns ?? []).some((pattern) => pattern.test(url.pathname + url.search));
  }

  /**
   * 署名付きURLはトークンがクエリに載る。
   * そのままキャッシュ鍵にすると、同じ画像でも発行のたびにミスして際限なく膨らむ。
   */
  function mediaKey(url: URL): string {
    if (typeof media.normalizeCacheKey === "function") return media.normalizeCacheKey(url);
    const stripped = new URL(url.href);
    stripped.search = "";
    return stripped.href;
  }

  async function networkFirst(
    request: Request,
    cacheName: string,
    timeoutMs: number,
    cacheable: boolean,
  ): Promise<Response> {
    const cache = await self.caches.open(cacheName);
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const response = await self.fetch(request, { signal: controller.signal });
      clearTimeout(timer);

      // 2xx だけ残す。ログイン画面へのリダイレクトや 5xx をキャッシュしない
      if (cacheable && response.status >= 200 && response.status < 300 && !response.redirected) {
        void cache.put(request, response.clone());
      }
      return response;
    } catch (error) {
      const hit = await cache.match(request);
      if (hit) return hit;
      throw error;
    }
  }

  async function cacheFirst(request: Request, cacheName: string, key: string): Promise<Response> {
    const cache = await self.caches.open(cacheName);
    const hit = await cache.match(key);
    if (hit) return hit;

    const response = await self.fetch(request);
    if (response.status >= 200 && response.status < 300) {
      void cache.put(key, response.clone());
    }
    return response;
  }

  self.addEventListener("fetch", ((event: FetchEventLike) => {
    const request = event.request;
    if (request.method !== "GET") return;

    const url = new URL(request.url);
    // 別オリジン（署名付きストレージ）は signedMedia に該当するものだけ扱う
    if (swOrigin && url.origin !== swOrigin && !matches(url, media.include)) return;

    // 署名付きメディア: クエリを外した鍵で使い回す
    if (matches(url, media.include)) {
      event.respondWith(cacheFirst(request, mediaCache, mediaKey(url)));
      return;
    }

    // 署名の発行・認証・アップロードは絶対にキャッシュしない
    if (matches(url, api.exclude)) return;

    if (matches(url, api.include)) {
      event.respondWith(
        networkFirst(request, apiCache, api.timeoutMs, matches(url, api.cacheable)),
      );
      return;
    }

    // ナビゲーション: 認証済み HTML を残さないので Network First
    if (request.mode === "navigate") {
      event.respondWith(
        (async () => {
          try {
            return await networkFirst(
              request,
              shellCache,
              api.timeoutMs,
              appShell.strategy === ("cache-first" as CacheStrategy),
            );
          } catch {
            const cache = await self.caches.open(shellCache);
            const fallback = appShell.navigationFallback
              ? await cache.match(appShell.navigationFallback)
              : undefined;
            if (fallback) return fallback;
            return new Response("オフラインです", {
              status: 503,
              headers: { "Content-Type": "text/plain; charset=utf-8" },
            });
          }
        })(),
      );
    }
  }) as (event: never) => void);

  // ------------------------------------------------------- Background Sync

  /**
   * アプリを閉じたあとの送信。
   *
   * **iOS には無い。** そこでは画面が開いている間のトリガ
   * （visibilitychange / focus / pageshow / 定期実行）が送信の機会になる。
   * どちらが使われるかは `capabilities.backgroundSync` で判る。
   */
  async function runQueue(): Promise<void> {
    if (!options.createQueue) return;
    const queue = await options.createQueue();
    try {
      await queue.flush({ force: true });
    } finally {
      await queue.destroy();
    }
  }

  if (options.createQueue) {
    self.addEventListener("sync", ((event: SyncEventLike) => {
      if (event.tag !== sync.syncTag) return;
      // waitUntil の Promise が reject すると、ブラウザが後で再試行してくれる。
      // ここで握りつぶすと「一度きりで諦める」になる
      event.waitUntil(runQueue());
    }) as (event: never) => void);

    if (sync.enablePeriodicSync) {
      self.addEventListener("periodicsync", ((event: SyncEventLike) => {
        if (event.tag !== (sync.periodicSyncTag ?? sync.syncTag)) return;
        event.waitUntil(runQueue());
      }) as (event: never) => void);
    }
  }

  // 画面からの明示的な依頼（「いま送って」）
  self.addEventListener("message", ((event: { data?: { type?: string } } & ExtendableEventLike) => {
    if (event.data?.type === "pf-field-flush") event.waitUntil(runQueue());
    if (event.data?.type === "pf-field-skip-waiting") event.waitUntil(self.skipWaiting());
  }) as (event: never) => void);
}
