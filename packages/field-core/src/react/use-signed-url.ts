"use client";

import { useEffect, useMemo, useState } from "react";
import { useFieldCoreContext } from "./provider.js";
import { refKey, type StoredObjectRef } from "../storage/types.js";

/**
 * 閲覧用の署名付きURL。
 *
 * バケットが非公開なので、`<img src>` に入れる URL は都度発行する必要がある。
 * 発行のバッチ化とキャッシュは `FileUrlResolver` が持つので、
 * ここは「描画に繋ぐ」だけを担当する。
 */

export interface UseSignedUrlResult {
  url: string | null;
  loading: boolean;
  error: Error | null;
}

export function useSignedUrl(ref: StoredObjectRef | undefined): UseSignedUrlResult {
  const { core } = useFieldCoreContext();
  const files = core?.files;
  const [state, setState] = useState<UseSignedUrlResult>({
    url: null,
    loading: Boolean(ref),
    error: null,
  });

  // ref はオブジェクトリテラルで渡されることが多い。参照ではなく中身で追う
  const key = ref ? refKey(ref) : "";

  useEffect(() => {
    if (!files || !ref) {
      setState({ url: null, loading: false, error: null });
      return;
    }

    let alive = true;
    setState((prev) => ({ ...prev, loading: true, error: null }));

    files
      .resolve(ref)
      .then((url) => {
        if (alive) setState({ url, loading: false, error: null });
      })
      .catch((cause: unknown) => {
        if (alive) {
          setState({
            url: null,
            loading: false,
            error: cause instanceof Error ? cause : new Error(String(cause)),
          });
        }
      });

    return () => {
      alive = false;
    };
  }, [files, key, ref]);

  return state;
}

export interface UseSignedUrlsResult {
  /** refKey(ref) → URL。取れなかったものは入らない */
  urls: Map<string, string>;
  loading: boolean;
}

/**
 * まとめて発行する。一覧に写真が並ぶ画面はこちらを使うこと。
 *
 * `useSignedUrl` を並べても resolver 側でまとまるが、
 * 「何枚ぶん待っているか」を1つの loading で扱えるほうが画面を書きやすい。
 */
export function useSignedUrls(refs: StoredObjectRef[]): UseSignedUrlsResult {
  const { core } = useFieldCoreContext();
  const files = core?.files;
  const [urls, setUrls] = useState<Map<string, string>>(new Map());
  const [loading, setLoading] = useState(refs.length > 0);

  const key = useMemo(() => refs.map(refKey).join("|"), [refs]);

  useEffect(() => {
    if (!files || refs.length === 0) {
      setUrls(new Map());
      setLoading(false);
      return;
    }

    let alive = true;
    setLoading(true);

    files
      .resolveMany(refs)
      .then((resolved) => {
        if (!alive) return;
        setUrls(new Map(resolved.map((entry) => [refKey(entry.ref), entry.url])));
      })
      .catch(() => {
        if (alive) setUrls(new Map());
      })
      .finally(() => {
        if (alive) setLoading(false);
      });

    return () => {
      alive = false;
    };
  }, [files, key, refs]);

  return { urls, loading };
}
