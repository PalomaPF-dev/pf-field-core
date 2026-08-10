"use client";

import { useEffect, useState } from "react";
import { probeImageCapabilities } from "../image/capabilities.js";
import type { ImageCapabilities } from "../image/types.js";

/**
 * React バインディング。
 *
 * M0 では実機の機能検出フックのみ。
 * useOfflineQueue / useNetworkStatus / useSignedUrl などは M4 で入る。
 */

export interface UseImageCapabilitiesResult {
  /** 検出前は null。SSR と初回描画を一致させるため、検出は effect の中で行う */
  capabilities: ImageCapabilities | null;
  probing: boolean;
}

/**
 * 実行環境の画像処理機能を実際に呼び出して検出する。
 *
 * Zebra 端末の WebView バージョンが未確定のため、実機の画面にこの結果を出して
 * 採取できるようにしてある（playground の /diagnostics がその用途）。
 */
export function useImageCapabilities(): UseImageCapabilitiesResult {
  const [capabilities, setCapabilities] = useState<ImageCapabilities | null>(null);
  const [probing, setProbing] = useState(true);

  useEffect(() => {
    let alive = true;
    setProbing(true);
    probeImageCapabilities()
      .then((caps) => {
        if (alive) setCapabilities(caps);
      })
      .catch(() => {
        if (alive) setCapabilities(null);
      })
      .finally(() => {
        if (alive) setProbing(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  return { capabilities, probing };
}

export type { ImageCapabilities } from "../image/types.js";
