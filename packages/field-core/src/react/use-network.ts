"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { safeFetch } from "../net/fetch-safe.js";
import { DEFAULT_ENDPOINTS } from "../config.js";
import { now } from "../shared/clock.js";

/**
 * 通信状態。
 *
 * **`navigator.onLine` を信じないのが要点。**
 * これは「ネットワークインタフェースが繋がっているか」しか見ておらず、
 * 工場でよくある次の状況をすべて `true` と報告する:
 *
 *   - 弱電界で繋がってはいるが、実際にはほとんど通らない（lie-fi）
 *   - Wi-Fi には繋がっているが、その先のゲートウェイが死んでいる
 *   - 認証切れでログイン画面へ吸い込まれる
 *
 * `false` のときは確実に圏外なので信用してよい。**真だけが疑わしい。**
 * だから到達性は実際に叩いて確かめる。
 */

export type NetworkQuality = "good" | "poor" | "offline";

export interface UseNetworkStatusResult {
  /** navigator.onLine。false なら確実に圏外 */
  online: boolean;
  /** 実際にサーバへ届いたか。未確認のうちは online と同じ値 */
  reachable: boolean;
  quality: NetworkQuality;
  effectiveType?: "4g" | "3g" | "2g" | "slow-2g";
  lastCheckedAt: number;
  /** 手動で確かめ直す。「送信」ボタンの直前などに使う */
  recheck(): Promise<boolean>;
}

export interface UseNetworkStatusOptions {
  /** 到達性を確かめる先。既定 '/api/health' */
  healthUrl?: string;
  /** 定期確認の間隔。既定30秒。0 で止める */
  intervalMs?: number;
  timeoutMs?: number;
}

interface ConnectionLike {
  effectiveType?: string;
  addEventListener?: (type: string, listener: () => void) => void;
  removeEventListener?: (type: string, listener: () => void) => void;
}

function connection(): ConnectionLike | undefined {
  if (typeof navigator === "undefined") return undefined;
  return (navigator as Navigator & { connection?: ConnectionLike }).connection;
}

export function useNetworkStatus(options?: UseNetworkStatusOptions): UseNetworkStatusResult {
  const healthUrl = options?.healthUrl ?? DEFAULT_ENDPOINTS.health;
  const intervalMs = options?.intervalMs ?? 30_000;
  const timeoutMs = options?.timeoutMs ?? 5_000;

  // SSR とハイドレーション初回は「オンライン」に倒す。
  // ここで false にすると、繋がっている端末で一瞬「圏外」が出る
  const [online, setOnline] = useState(true);
  const [reachable, setReachable] = useState(true);
  const [lastCheckedAt, setLastCheckedAt] = useState(0);
  const [effectiveType, setEffectiveType] = useState<string | undefined>(undefined);

  const inFlight = useRef<Promise<boolean> | null>(null);

  const check = useCallback(async (): Promise<boolean> => {
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      setOnline(false);
      setReachable(false);
      setLastCheckedAt(now());
      return false;
    }
    setOnline(true);

    // 同時に何本も投げない。画面のあちこちからこのフックが呼ばれる
    if (inFlight.current) return inFlight.current;

    const probe = (async () => {
      try {
        const response = await safeFetch(healthUrl, {
          method: "GET",
          timeoutMs,
          cache: "no-store",
        });
        // 3xx（ログイン画面へのリダイレクト）は「届いていない」と同じ扱い。
        // 送っても通らないので、送信を促してはいけない
        const ok = response.status >= 200 && response.status < 300;
        setReachable(ok);
        return ok;
      } catch {
        setReachable(false);
        return false;
      } finally {
        setLastCheckedAt(now());
        inFlight.current = null;
      }
    })();

    inFlight.current = probe;
    return probe;
  }, [healthUrl, timeoutMs]);

  useEffect(() => {
    setOnline(typeof navigator === "undefined" ? true : navigator.onLine);

    const onOnline = () => {
      setOnline(true);
      void check();
    };
    const onOffline = () => {
      setOnline(false);
      setReachable(false);
    };

    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);

    const conn = connection();
    const onChange = () => setEffectiveType(conn?.effectiveType);
    onChange();
    conn?.addEventListener?.("change", onChange);

    void check();

    const timer =
      intervalMs > 0
        ? setInterval(() => {
            // 画面が見えていないときに確かめても意味が無い
            if (typeof document === "undefined" || document.visibilityState === "visible") {
              void check();
            }
          }, intervalMs)
        : null;

    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
      conn?.removeEventListener?.("change", onChange);
      if (timer !== null) clearInterval(timer);
    };
  }, [check, intervalMs]);

  const quality: NetworkQuality = !online || !reachable
    ? "offline"
    : effectiveType === "2g" || effectiveType === "slow-2g"
      ? "poor"
      : "good";

  return {
    online,
    reachable,
    quality,
    ...(effectiveType ? { effectiveType: effectiveType as "4g" | "3g" | "2g" | "slow-2g" } : {}),
    lastCheckedAt,
    recheck: check,
  };
}
