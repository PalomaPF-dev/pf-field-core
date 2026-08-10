"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useFieldCoreContext } from "./provider.js";

/**
 * 入力中の値を端末に持たせる。
 *
 * Zebra 端末は WebView をバックグラウンドで kill するので、
 * 「圏外で入力を続ける」には書きかけが残っている必要がある。
 *
 * 保存はデバウンスする。1文字ごとに IndexedDB へ書くと、
 * 弱い端末では入力そのものが引っかかる。
 * ただし**画面を離れるときは即座に書く** — そこで落とすと意味が無い。
 */

export interface UseDraftOptions {
  /** 保存を遅らせる時間。既定 800ms */
  debounceMs?: number;
  /** 表示名 */
  label?: string;
  /** 復元が終わるまで保存しない（初期値で上書きしないため）。既定 true */
  waitForRestore?: boolean;
}

export interface UseDraftResult<T> {
  /** 復元された値。まだ読み込み中なら undefined */
  value: T | undefined;
  /** 復元済みか。false の間は初期値を表示してよいが、保存はされない */
  restored: boolean;
  /** 値を更新する。デバウンスして保存される */
  update(next: T): void;
  /** いま書く（デバウンスを待たない） */
  flush(): Promise<void>;
  /** 下書きを破棄する。enqueue に成功したら呼ぶ */
  discard(): Promise<void>;
  savedAt: number | null;
}

export function useDraft<T>(
  draftId: string | undefined,
  type: string,
  options?: UseDraftOptions,
): UseDraftResult<T> {
  const { core } = useFieldCoreContext();
  const debounceMs = options?.debounceMs ?? 800;

  const store = core?.drafts ?? null;
  const [value, setValue] = useState<T | undefined>(undefined);
  const [restored, setRestored] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<T | undefined>(undefined);
  const hasPending = useRef(false);

  // 復元
  useEffect(() => {
    if (!store || !draftId) {
      setRestored(!draftId);
      return;
    }
    let alive = true;

    void store.get<T>(draftId).then((draft) => {
      if (!alive) return;
      if (draft) setValue(draft.value);
      setRestored(true);
    });

    return () => {
      alive = false;
    };
  }, [store, draftId]);

  const write = useCallback(
    async (next: T): Promise<void> => {
      if (!store || !draftId) return;
      await store.save({
        draftId,
        type,
        value: next,
        ...(options?.label !== undefined ? { label: options.label } : {}),
      });
      setSavedAt(Date.now());
    },
    [store, draftId, type, options?.label],
  );

  const flush = useCallback(async (): Promise<void> => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    if (!hasPending.current) return;
    const next = pending.current as T;
    hasPending.current = false;
    await write(next);
  }, [write]);

  const update = useCallback(
    (next: T) => {
      setValue(next);
      // 復元前に書くと、保存済みの内容を初期値で潰す
      if (options?.waitForRestore !== false && !restored) return;

      pending.current = next;
      hasPending.current = true;

      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        timer.current = null;
        hasPending.current = false;
        void write(next);
      }, debounceMs);
    },
    [write, debounceMs, restored, options?.waitForRestore],
  );

  /*
   * 画面を離れるときは待たずに書く。
   * Zebra 端末はバックグラウンドで WebView ごと落とすので、
   * デバウンス待ちの800msがそのまま「消えた入力」になる。
   */
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === "hidden") void flush();
    };
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", onHide);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", onHide);
      void flush();
    };
  }, [flush]);

  const discard = useCallback(async (): Promise<void> => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    hasPending.current = false;
    if (store && draftId) await store.remove(draftId);
    setValue(undefined);
    setSavedAt(null);
  }, [store, draftId]);

  return { value, restored, update, flush, discard, savedAt };
}
