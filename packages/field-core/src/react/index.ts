"use client";

import { useEffect, useMemo, useState } from "react";
import { probeImageCapabilities } from "../image/capabilities.js";
import type { ImageCapabilities } from "../image/types.js";
import { describeSyncBehaviour, detectCapabilities, probeCapabilities } from "../capabilities/detect.js";
import type { CapabilityOverrides, FieldCapabilities, ProbedCapabilities } from "../capabilities/types.js";

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

export interface UseCapabilitiesResult {
  /**
   * 同期的に判る能力。SSR と初回描画を一致させるため、
   * サーバ側では「何も無い」扱いの値が入る（描画には使わないこと）。
   */
  capabilities: FieldCapabilities;
  /** 実際に呼び出して確かめた版。検出が終わるまでは null */
  probed: ProbedCapabilities | null;
  probing: boolean;
  /** 送信の振る舞いを説明する一文。そのまま画面に出せる */
  syncDescription: string;
}

/**
 * 端末能力を返す。
 *
 * UI の出し分けに使う。例:
 *
 * ```tsx
 * const { capabilities } = useCapabilities();
 * {capabilities.requiresForegroundToSend && (
 *   <p>送信が終わるまでアプリを開いたままにしてください</p>
 * )}
 * {capabilities.hardwareScanner ? <ScannerInput /> : <ManualInput />}
 * ```
 *
 * `capabilities` はハイドレーション後の初回描画から正しい値になる
 * （`detectCapabilities` は副作用が無いため）。
 * `probed` は `navigator.storage.persist()` の呼び出しを伴うので effect の中で解決する。
 */
export function useCapabilities(overrides?: CapabilityOverrides): UseCapabilitiesResult {
  const overrideKey = JSON.stringify(overrides ?? {});
  // overrides はオブジェクトリテラルで渡されることが多い。
  // 参照ではなく中身で比較しないと、毎描画で作り直してしまう
  const capabilities = useMemo(() => detectCapabilities(overrides), [overrideKey, overrides]);

  const [probed, setProbed] = useState<ProbedCapabilities | null>(null);
  const [probing, setProbing] = useState(true);

  useEffect(() => {
    let alive = true;
    setProbing(true);
    probeCapabilities(overrides)
      .then((result) => {
        if (alive) setProbed(result);
      })
      .catch(() => {
        if (alive) setProbed(null);
      })
      .finally(() => {
        if (alive) setProbing(false);
      });
    return () => {
      alive = false;
    };
  }, [overrideKey, overrides]);

  return {
    capabilities,
    probed,
    probing,
    syncDescription: describeSyncBehaviour(capabilities),
  };
}

export type { ImageCapabilities } from "../image/types.js";
export type {
  CapabilityOverrides,
  FieldCapabilities,
  PlatformKind,
  ProbedCapabilities,
  SyncTrigger,
} from "../capabilities/types.js";
