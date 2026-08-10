"use client";

import { useCallback, useEffect, useState } from "react";
import { useFieldCoreContext } from "./provider.js";
import type { MediaAvailability, PrefetchRequest, PrefetchResult } from "../master/types.js";
import type { StoredObjectRef } from "../storage/types.js";

/**
 * マスタのローカルキャッシュを React に繋ぐ。
 *
 * 目的は「圏外で点検を新規に開始できる」こと。
 */

export interface UseMasterResult<T> {
  items: T[] | undefined;
  /** 読み込み中 */
  loading: boolean;
  /** 端末にまだ無い（オンラインで一度開く必要がある） */
  missing: boolean;
}

export function useMaster<T>(collection: string): UseMasterResult<T> {
  const { core } = useFieldCoreContext();
  const master = core?.master;
  const [items, setItems] = useState<T[] | undefined>(undefined);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!master) return;
    let alive = true;

    const load = () => {
      void master
        .get<T>(collection)
        .then((next) => {
          if (alive) setItems(next);
        })
        .finally(() => {
          if (alive) setLoading(false);
        });
    };

    load();
    // 起動時の取り直しは非同期。画面がその途中で開かれても取り残されないよう購読する
    const off = master.subscribe(load);

    return () => {
      alive = false;
      off();
    };
  }, [master, collection]);

  return { items, loading, missing: !loading && items === undefined };
}

export interface UseMediaResult {
  availability: MediaAvailability;
  /** そのまま `<img src>` に入れられる。出せないときは null */
  url: string | null;
  /**
   * 「オンライン時に表示されます」を出すべきか。
   *
   * **「読み込み失敗」や「画像がありません」と出してはいけない。**
   * 現場では別の問題（データの不備）に見えてしまう。
   */
  showOnlineOnlyNotice: boolean;

  /**
   * 表示に失敗したことを伝える（`<img onError>` に繋ぐ）。
   *
   * `navigator.onLine` は当てにならない。真であっても実際には通らないことがあり、
   * その場合ここだけが「出せなかった」を知っている。
   * 呼ぶと `unavailable` に落として「オンライン時に表示されます」へ切り替える。
   */
  reportUnavailable(): void;
}

/**
 * 正常見本・図面ピンの画像を出す。
 *
 * ```tsx
 * const { url, showOnlineOnlyNotice } = useCachedMedia(ref);
 * {url ? <img src={url} /> : showOnlineOnlyNotice && <p>オンライン時に表示されます</p>}
 * ```
 */
export function useCachedMedia(ref: StoredObjectRef | undefined): UseMediaResult {
  const { core } = useFieldCoreContext();
  const master = core?.master;
  const [availability, setAvailability] = useState<MediaAvailability>({ state: "loading" });

  const key = ref ? `${ref.provider}:${ref.bucket}:${ref.path}` : "";

  useEffect(() => {
    if (!master || !ref) {
      setAvailability({ state: "unavailable", reason: "not-prefetched" });
      return;
    }
    let alive = true;

    const load = () => {
      void master.availability(ref).then((next) => {
        if (alive) setAvailability(next);
      });
    };

    load();
    // 先読みが終わったら unavailable → cached に変わる
    const off = master.subscribe(load);

    /*
     * 圏内・圏外の変化でも見直す。
     *
     * 画面を開いたまま電波が切れたとき、`online` で出していた画像は
     * もう表示できない。見直さないと壊れた画像のまま残り、
     * 「オンライン時に表示されます」に切り替わらない。
     */
    if (typeof window !== "undefined") {
      window.addEventListener("online", load);
      window.addEventListener("offline", load);
    }

    return () => {
      alive = false;
      off();
      if (typeof window !== "undefined") {
        window.removeEventListener("online", load);
        window.removeEventListener("offline", load);
      }
    };
  }, [master, key, ref]);

  const url =
    availability.state === "cached" || availability.state === "online" ? availability.url : null;

  const reportUnavailable = useCallback(() => {
    setAvailability((current) =>
      // 端末にあるものが出せないのは別の問題。ここでは触らない
      current.state === "online" ? { state: "unavailable", reason: "offline" } : current,
    );
  }, []);

  return {
    availability,
    url,
    showOnlineOnlyNotice: availability.state === "unavailable",
    reportUnavailable,
  };
}

export interface UsePrefetchResult {
  /** 点検開始時に、その点検のぶんだけ先読みする */
  prefetch(request: PrefetchRequest): Promise<PrefetchResult | undefined>;
  running: boolean;
  last: PrefetchResult | null;
}

export function usePrefetchMedia(): UsePrefetchResult {
  const { core } = useFieldCoreContext();
  const master = core?.master;
  const [running, setRunning] = useState(false);
  const [last, setLast] = useState<PrefetchResult | null>(null);

  const prefetch = useCallback(
    async (request: PrefetchRequest): Promise<PrefetchResult | undefined> => {
      if (!master) return undefined;
      setRunning(true);
      try {
        const result = await master.prefetch(request);
        setLast(result);
        return result;
      } finally {
        setRunning(false);
      }
    },
    [master],
  );

  return { prefetch, running, last };
}
