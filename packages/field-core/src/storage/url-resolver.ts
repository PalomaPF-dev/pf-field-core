import { responseError, safeFetch } from "../net/fetch-safe.js";
import { DEFAULT_ENDPOINTS } from "../config.js";
import { now } from "../shared/clock.js";
import { refKey, type FileUrlResolver, type ResolvedUrl, type StoredObjectRef } from "./types.js";

/**
 * 閲覧用の署名付きURLを解決する。
 *
 * バケットは非公開なので、画像を出すたびに署名を発行する必要がある。
 * 素朴に1枚ずつ発行すると、点検一覧に写真が20枚あれば **20往復**する。
 * 弱電界では往復が最大のコストなので、ここで2つのことをしている:
 *
 *   1. **バッチ** — 同じティックに要求されたぶんをまとめて1回で発行する
 *   2. **キャッシュ** — 期限内は再利用する。再描画のたびに発行しない
 *
 * 署名は短命（既定5分）なので、期限が近いものは先に捨てる。
 * 「画面に出た瞬間に切れていた」を避けるため、実際の期限より手前で無効にする。
 */

/** 期限のどれくらい手前で捨てるか。描画してから読み込まれるまでの猶予 */
const EXPIRY_MARGIN_MS = 30_000;

export interface UrlResolverOptions {
  /** 閲覧URL発行エンドポイント。既定 '/api/files/sign-view' */
  signViewUrl?: string;
  /** 既定の有効期間（秒）。サーバ側の上限に従う */
  ttlSec?: number;
  /** まとめる待ち時間（ms）。既定 10ms（同じ描画で並ぶぶんを拾う） */
  batchWindowMs?: number;
  /** 1回のリクエストに載せる上限。サーバ側の maxRefsPerRequest と揃える */
  maxBatchSize?: number;
  timeoutMs?: number;
  /** 共通ヘッダ */
  headers?: () => Promise<Record<string, string>>;
}

interface CacheEntry {
  url: string;
  expiresAt: number;
}

interface Pending {
  ref: StoredObjectRef;
  resolve: (url: ResolvedUrl) => void;
  reject: (error: unknown) => void;
}

export function createFileUrlResolver(options?: UrlResolverOptions): FileUrlResolver {
  const endpoint = options?.signViewUrl ?? DEFAULT_ENDPOINTS.signView;
  const batchWindowMs = options?.batchWindowMs ?? 10;
  const maxBatchSize = options?.maxBatchSize ?? 100;

  const cache = new Map<string, CacheEntry>();
  let queue: Pending[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;

  function cached(ref: StoredObjectRef): string | undefined {
    const entry = cache.get(refKey(ref));
    if (!entry) return undefined;
    if (entry.expiresAt - EXPIRY_MARGIN_MS <= now()) {
      cache.delete(refKey(ref));
      return undefined;
    }
    return entry.url;
  }

  async function requestBatch(batch: Pending[]): Promise<void> {
    const headers = (await options?.headers?.()) ?? {};

    try {
      const response = await safeFetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify({
          refs: batch.map((item) => item.ref),
          ...(options?.ttlSec !== undefined ? { ttlSec: options.ttlSec } : {}),
        }),
        ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      });

      const error = responseError(response, { statusText: response.statusText });
      if (error) throw new Error(error.message);

      const body = (await response.json()) as { urls?: ResolvedUrl[] };
      const byKey = new Map((body.urls ?? []).map((entry) => [refKey(entry.ref), entry]));

      for (const item of batch) {
        const resolved = byKey.get(refKey(item.ref));
        if (!resolved) {
          // 1枚が出せなくても他は出す。一覧が丸ごと崩れるほうが困る
          item.reject(new Error("閲覧用URLを発行できませんでした"));
          continue;
        }
        cache.set(refKey(item.ref), { url: resolved.url, expiresAt: resolved.expiresAt });
        item.resolve(resolved);
      }
    } catch (cause) {
      for (const item of batch) item.reject(cause);
    }
  }

  function schedule(): void {
    if (timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      const batch = queue;
      queue = [];
      for (let i = 0; i < batch.length; i += maxBatchSize) {
        void requestBatch(batch.slice(i, i + maxBatchSize));
      }
    }, batchWindowMs);
  }

  function enqueue(ref: StoredObjectRef): Promise<ResolvedUrl> {
    return new Promise<ResolvedUrl>((resolve, reject) => {
      queue.push({ ref, resolve, reject });
      schedule();
    });
  }

  return {
    async resolve(ref, resolveOptions) {
      void resolveOptions;
      const hit = cached(ref);
      if (hit) return hit;
      return (await enqueue(ref)).url;
    },

    async resolveMany(refs, resolveOptions) {
      void resolveOptions;
      const results: ResolvedUrl[] = [];
      const missing: StoredObjectRef[] = [];

      for (const ref of refs) {
        const hit = cached(ref);
        if (hit) {
          results.push({ ref, url: hit, expiresAt: cache.get(refKey(ref))!.expiresAt });
        } else {
          missing.push(ref);
        }
      }

      // 取れなかったものは落とす。1枚の失敗で一覧を空にしない
      const fetched = await Promise.allSettled(missing.map((ref) => enqueue(ref)));
      for (const entry of fetched) {
        if (entry.status === "fulfilled") results.push(entry.value);
      }

      return results;
    },

    invalidate(ref) {
      if (ref) cache.delete(refKey(ref));
      else cache.clear();
    },
  };
}
