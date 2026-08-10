"use client";

import { useCallback, useEffect, useState } from "react";
import { registerFieldServiceWorker, requestQueueSync } from "../sw/register.js";
import { detectCapabilities } from "../capabilities/detect.js";

/**
 * Service Worker の登録と更新。
 *
 * **更新を勝手に適用しない。** 点検の入力途中で SW が入れ替わって
 * リロードされると、書きかけが消える。`applyUpdate()` を呼ぶまで待たせる。
 */

export interface UseServiceWorkerResult {
  registration: ServiceWorkerRegistration | null;
  updateAvailable: boolean;
  /** 待機中の SW を有効にして再読み込みする */
  applyUpdate(): Promise<void>;
  /** Background Sync が使えるか。false なら前面での送信に頼る（iOS） */
  backgroundSync: boolean;
  /** 「送信完了までアプリを開いたままにしてください」を出す条件 */
  requiresForegroundToSend: boolean;
  /** 登録できなかった理由 */
  reason?: "unsupported" | "insecure" | "failed";
}

export interface UseServiceWorkerOptions {
  url?: string;
  /** false にすると登録しない（開発時など） */
  enabled?: boolean;
  /** 登録後に Background Sync を要求する。既定 true */
  requestSync?: boolean;
  syncTag?: string;
}

export function useServiceWorkerUpdate(
  options?: UseServiceWorkerOptions,
): UseServiceWorkerResult {
  const [registration, setRegistration] = useState<ServiceWorkerRegistration | null>(null);
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [reason, setReason] = useState<UseServiceWorkerResult["reason"]>(undefined);

  const capabilities = detectCapabilities();

  useEffect(() => {
    if (options?.enabled === false) return;
    let alive = true;

    void (async () => {
      const result = await registerFieldServiceWorker({
        ...(options?.url ? { url: options.url } : {}),
        onUpdateFound: (reg) => {
          const installing = reg.installing;
          if (!installing) return;
          installing.addEventListener("statechange", () => {
            // 既に制御中の SW が居る状態で installed = 更新版が待機している
            if (installing.state === "installed" && navigator.serviceWorker.controller) {
              setUpdateAvailable(true);
            }
          });
        },
      });

      if (!alive) return;
      setRegistration(result.registration);
      setReason(result.reason);

      if (result.registration && options?.requestSync !== false) {
        await requestQueueSync(options?.syncTag ?? "pf-field-queue", result.registration);
      }
    })();

    return () => {
      alive = false;
    };
  }, [options?.enabled, options?.url, options?.requestSync, options?.syncTag]);

  const applyUpdate = useCallback(async (): Promise<void> => {
    const waiting = registration?.waiting;
    if (!waiting) return;

    // 入れ替わったら1回だけ再読み込みする
    let reloaded = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (reloaded) return;
      reloaded = true;
      window.location.reload();
    });

    waiting.postMessage({ type: "pf-field-skip-waiting" });
  }, [registration]);

  return {
    registration,
    updateAvailable,
    applyUpdate,
    backgroundSync: capabilities.backgroundSync,
    requiresForegroundToSend: capabilities.requiresForegroundToSend,
    ...(reason ? { reason } : {}),
  };
}
