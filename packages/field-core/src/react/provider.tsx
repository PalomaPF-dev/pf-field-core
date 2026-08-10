"use client";

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { configureFieldCore } from "../core.js";
import type { FieldCore, FieldCoreConfig } from "../config.js";

/**
 * キュー一式を1回だけ作り、木の下でどこからでも使えるようにする。
 *
 * **1回だけ**が要点。IndexedDB の接続・送信ランナーのリース・イベント購読は
 * どれも重複させたくない。React 18 の StrictMode は effect を2回走らせるので、
 * 素朴に書くとキューが2つできて、同じジョブを2重に送りかねない。
 */

export interface FieldCoreContextValue {
  core: FieldCore | null;
  /** 初期化中。false になるまで core は null */
  loading: boolean;
  /** 初期化に失敗した理由。握りつぶすと「押しても何も起きない」画面になる */
  error: Error | null;
}

const FieldCoreContext = createContext<FieldCoreContextValue | null>(null);

export interface FieldCoreProviderProps {
  config: FieldCoreConfig;
  children: ReactNode;
  /** 初期化中に出すもの。省略時は children をそのまま描く */
  fallback?: ReactNode;
}

export function FieldCoreProvider({
  config,
  children,
  fallback,
}: FieldCoreProviderProps): React.JSX.Element {
  const [state, setState] = useState<FieldCoreContextValue>({
    core: null,
    loading: true,
    error: null,
  });

  /*
   * config はオブジェクトリテラルで渡されることが多く、毎描画で参照が変わる。
   * 依存に入れるとキューを作り直し続けるので、appId と dbName だけを見る。
   * 実行中にアダプタを差し替える用途は想定しない（差し替えたいならマウントし直す）。
   */
  const identity = `${config.appId}:${config.dbName ?? ""}`;
  const configRef = useRef(config);
  configRef.current = config;

  useEffect(() => {
    let disposed = false;
    let created: FieldCore | null = null;

    setState({ core: null, loading: true, error: null });

    void (async () => {
      try {
        const core = await configureFieldCore(configRef.current);
        created = core;
        if (disposed) {
          // StrictMode の2周目、またはアンマウント済み。作ったものは必ず閉じる
          void core.destroy();
          return;
        }
        setState({ core, loading: false, error: null });
      } catch (cause) {
        if (disposed) return;
        setState({
          core: null,
          loading: false,
          error: cause instanceof Error ? cause : new Error(String(cause)),
        });
      }
    })();

    return () => {
      disposed = true;
      void created?.destroy();
    };
  }, [identity]);

  const value = useMemo(() => state, [state]);

  return (
    <FieldCoreContext.Provider value={value}>
      {state.loading && fallback !== undefined ? fallback : children}
    </FieldCoreContext.Provider>
  );
}

/**
 * Provider の値。まだ初期化中なら `core` は null。
 *
 * Provider の外で呼ばれた場合は**例外にする**。null を返すと、
 * 置き忘れが「なぜか送信されない」という形で現れて原因に辿り着けない。
 */
export function useFieldCoreContext(): FieldCoreContextValue {
  const value = useContext(FieldCoreContext);
  if (!value) {
    throw new Error(
      "FieldCoreProvider の中で使ってください（app/providers.tsx に置くのが定位置です）",
    );
  }
  return value;
}

/** 初期化が済んだ core。まだなら null */
export function useFieldCore(): FieldCore | null {
  return useFieldCoreContext().core;
}
