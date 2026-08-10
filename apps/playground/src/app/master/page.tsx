"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { StoredObjectRef } from "@palomapf-dev/pf-field-core";
import {
  FieldCoreProvider,
  useCachedMedia,
  useMaster,
  usePrefetchMedia,
} from "@palomapf-dev/pf-field-core/react";

/**
 * マスタのローカルキャッシュ（M6）の確認。
 *
 * 現場の要件そのもの:
 *   点検開始時（オンライン）に該当分だけ先読みし、
 *   圏外になっても正常見本・図面ピンが表示できること。
 *   先読みしていなければ「オンライン時に表示されます」と**明示する**こと。
 */

const SAMPLE: StoredObjectRef = {
  provider: "playground",
  bucket: "field-uploads",
  // playground では public 配下の実ファイルを指す（本番は署名付きURLで解決される）
  path: "/master/normal-sample.png",
};
const NOT_PREFETCHED: StoredObjectRef = {
  provider: "playground",
  bucket: "field-uploads",
  path: "/master/never-fetched.png",
};

function Media({ objectRef, label }: { objectRef: StoredObjectRef; label: string }) {
  const { url, availability, showOnlineOnlyNotice, reportUnavailable } = useCachedMedia(objectRef);

  return (
    <div className="card">
      <strong>{label}</strong>{" "}
      <span className="badge" data-testid={`state-${label}`}>
        {availability.state}
      </span>{" "}
      <span className="lead" data-testid={`bytes-${label}`}>
        {availability.state === "cached" ? availability.bytes : "-"}
      </span>
      <div>
        {url ? (
          // 署名付きURLは短命なので next/image は使わない
          <img
            src={url}
            alt=""
            width={80}
            height={60}
            data-testid={`img-${label}`}
            onError={reportUnavailable}
          />
        ) : showOnlineOnlyNotice ? (
          <p className="lead" data-testid={`notice-${label}`}>
            オンライン時に表示されます
          </p>
        ) : (
          <p className="lead">確認中…</p>
        )}
      </div>
    </div>
  );
}

function Screen() {
  const equipment = useMaster<{ id: string; name: string }>("equipment");
  const { prefetch, running, last } = usePrefetchMedia();
  const [message, setMessage] = useState<string | null>(null);

  const start = useCallback(async () => {
    // 点検開始 = その点検のぶんだけ先読みする
    const result = await prefetch({ groupId: "sheet-1", refs: [SAMPLE] });
    setMessage(result ? `先読み ${result.fetched} 件 / 再利用 ${result.reused} 件` : null);
  }, [prefetch]);

  return (
    <main>
      <h1>マスタのローカルキャッシュ</h1>
      <nav>
        <Link href="/">← 戻る</Link>
      </nav>

      <div className="card">
        設備台帳:{" "}
        <span data-testid="equipment-count">
          {equipment.loading ? "…" : `${equipment.items?.length ?? 0} 件`}
        </span>
        {equipment.missing && <span className="badge warn"> 未取得</span>}
      </div>

      <div className="card">
        <button type="button" onClick={() => void start()} disabled={running}>
          点検を開始（該当分を先読み）
        </button>
        {message && <span data-testid="prefetch-message"> {message}</span>}
        {last && <span data-testid="prefetch-failed"> 失敗 {last.failed}</span>}
      </div>

      <Media objectRef={SAMPLE} label="sample" />
      <Media objectRef={NOT_PREFETCHED} label="missing" />
    </main>
  );
}

export default function MasterPage() {
  const [sessionId, setSessionId] = useState("");
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const key = "pf-playground-master-session";
    let id = sessionStorage.getItem(key);
    if (!id) {
      id = `m-${Math.random().toString(36).slice(2)}`;
      sessionStorage.setItem(key, id);
    }
    setSessionId(id);
  }, []);

  const config = useMemo(
    () => ({
      appId: "playground-master",
      dbName: `pf-field-master-${sessionId}`,
      endpoints: { health: "/api/health", submit: {} as Record<string, string> },
      master: {
        scope: "paloma/f1",
        fetchCollections: async () => {
          const response = await fetch("/api/master");
          return (await response.json()) as { collection: string; items: unknown[] }[];
        },
      },
      queue: { autoStart: false, pollIntervalMs: 0 },
    }),
    [sessionId],
  );

  if (!sessionId) {
    return (
      <main>
        <h1>マスタのローカルキャッシュ</h1>
        <p className="lead">準備中…</p>
      </main>
    );
  }

  return (
    <FieldCoreProvider config={config}>
      <Screen />
    </FieldCoreProvider>
  );
}
