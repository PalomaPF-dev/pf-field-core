"use client";

import { useEffect, useMemo, useState } from "react";
import { probeImageCapabilities } from "../image/capabilities.js";
import type { ImageCapabilities } from "../image/types.js";
import { describeSyncBehaviour, detectCapabilities, probeCapabilities } from "../capabilities/detect.js";
import type { CapabilityOverrides, FieldCapabilities, ProbedCapabilities } from "../capabilities/types.js";

/**
 * React バインディング。
 *
 * 状態の購読は `useSyncExternalStore`。キューは React の外（別タブ・
 * Service Worker）でも進むので、`useState` で写し取ると画面だけ古くなる。
 */

export { FieldCoreProvider, useFieldCore, useFieldCoreContext } from "./provider.js";
export type { FieldCoreContextValue, FieldCoreProviderProps } from "./provider.js";

export { useOfflineQueue, useQueueJob } from "./use-queue.js";
export type { UseOfflineQueueResult, UseQueueJobResult } from "./use-queue.js";

/** 通信状態。navigator.onLine を信じず、実際に届くかを確かめる */
export { useNetworkStatus } from "./use-network.js";
export type {
  NetworkQuality,
  UseNetworkStatusOptions,
  UseNetworkStatusResult,
} from "./use-network.js";

/** 閲覧用の署名付きURL（バッチ + キャッシュ） */
export { useSignedUrl, useSignedUrls } from "./use-signed-url.js";
export type { UseSignedUrlResult, UseSignedUrlsResult } from "./use-signed-url.js";

/** Service Worker の登録と更新。更新は勝手に適用しない */
export { useServiceWorkerUpdate } from "./use-service-worker.js";
export type { UseServiceWorkerOptions, UseServiceWorkerResult } from "./use-service-worker.js";

/**
 * マスタのローカルキャッシュ。圏外で点検を新規に開始するための土台。
 * `useCachedMedia().showOnlineOnlyNotice` が
 * 「オンライン時に表示されます」を出す条件。
 */
export { useCachedMedia, useMaster, usePrefetchMedia } from "./use-master.js";
export type { UseMasterResult, UseMediaResult, UsePrefetchResult } from "./use-master.js";

/** 下書き。圏外で入力を続けるための土台 */
export { useDraft } from "./use-draft.js";
export type { UseDraftOptions, UseDraftResult } from "./use-draft.js";

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
