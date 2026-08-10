"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { QueueJob, StoredObjectRef } from "@palomapf-dev/pf-field-core";
import {
  FieldCoreProvider,
  useDraft,
  useNetworkStatus,
  useOfflineQueue,
  useSignedUrl,
} from "@palomapf-dev/pf-field-core/react";
import { createSyntheticPhoto } from "@/lib/test-image";

/**
 * M4 の確認画面。**アプリ側が実際に書くコードの見本**でもある。
 *
 * ここで見せているのは4つ:
 *   - 未送信件数と手動再送（useOfflineQueue）
 *   - 通信状態（useNetworkStatus）— navigator.onLine を信じない
 *   - 送信済み写真の表示（useSignedUrl）— 非公開バケットなので都度発行
 *   - 下書きの永続化（useDraft）— 圏外で入力を続けるための土台
 */

function newSessionId(): string {
  return `s-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
}

const STATUS_LABEL: Record<QueueJob["status"], string> = {
  pending: "待機中",
  active: "送信中",
  succeeded: "送信済み",
  failed: "失敗（再送できます）",
  blocked: "要対応",
  canceled: "破棄",
};

/** 送信済みの写真。非公開バケットなので URL は都度発行する */
function Thumb({ objectRef }: { objectRef: StoredObjectRef }) {
  const { url, loading, error } = useSignedUrl(objectRef);

  if (loading) return <span className="lead">読み込み中…</span>;
  if (error || !url) return <span className="badge ng">表示できません</span>;
  // next/image は使わない。署名付きURLは短命で、最適化のキャッシュと噛み合わない
  return <img src={url} alt="" width={64} height={48} style={{ borderRadius: 4 }} />;
}

interface DraftValue {
  equipmentId: string;
  note: string;
}

function Screen({ sessionId }: { sessionId: string }) {
  const queue = useOfflineQueue({ limit: 20 });
  const network = useNetworkStatus({ healthUrl: "/api/health", intervalMs: 0 });
  const draft = useDraft<DraftValue>("draft-1", "playground.inspection", { debounceMs: 200 });

  const [message, setMessage] = useState<string | null>(null);
  const busy = useRef(false);

  const value = draft.value ?? { equipmentId: "", note: "" };

  const add = useCallback(async () => {
    if (busy.current || !queue.ready) return;
    busy.current = true;
    setMessage(null);
    try {
      const photo = await createSyntheticPhoto(800, 600, 1);
      const job = await queue.enqueue({
        type: "playground.inspection",
        payload: { ...value },
        label: value.equipmentId || "設備未指定",
        attachments: [{ attachmentId: "att-1", blob: photo.blob, fileName: photo.name }],
      });
      // 送信を頼んだ時点で下書きは役目を終える
      await draft.discard();
      setMessage(`送信予約しました（${job.attachments.length} 枚）`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      busy.current = false;
    }
  }, [queue, value, draft]);

  const send = useCallback(async () => {
    if (!queue.ready) return;
    const result = await queue.flush();
    setMessage(`送信 ${result.succeeded} 件 / 失敗 ${result.failed} 件`);
  }, [queue]);

  const uploaded = useMemo(
    () =>
      queue.jobs
        .flatMap((job) => job.attachments)
        .filter((a) => a.ref !== undefined)
        .slice(0, 6),
    [queue.jobs],
  );

  return (
    <main>
      <h1>アプリ組み込みの見本</h1>
      <p className="lead">M4: Provider とフックだけで画面を作る</p>
      <nav>
        <Link href="/">← 戻る</Link> / <Link href="/send">送信ランナー</Link>
      </nav>

      <div className="card">
        <strong data-testid="unsent">未送信 {queue.counts.unsent} 件</strong>{" "}
        <span className="lead">
          送信済み {queue.counts.succeeded} / 要対応 {queue.counts.blocked}
        </span>
        <div className="lead">
          通信:{" "}
          <span
            className={`badge ${network.quality === "offline" ? "ng" : "ok"}`}
            data-testid="network"
          >
            {network.quality}
          </span>{" "}
          {network.online ? "オンライン" : "オフライン"} / 実際に到達:{" "}
          {network.reachable ? "はい" : "いいえ"}
        </div>
      </div>

      {message && (
        <div className="card" data-testid="message">
          {message}
        </div>
      )}

      <h2>入力（下書きは自動保存）</h2>
      <div className="card">
        <p className="lead">
          {draft.restored ? "復元済み" : "復元中…"}
          {draft.savedAt !== null && <span data-testid="saved"> / 保存しました</span>}
        </p>
        <label>
          設備No.{" "}
          <input
            data-testid="equipment"
            value={value.equipmentId}
            onChange={(event) => draft.update({ ...value, equipmentId: event.target.value })}
          />
        </label>{" "}
        <label>
          メモ{" "}
          <input
            data-testid="note"
            value={value.note}
            onChange={(event) => draft.update({ ...value, note: event.target.value })}
          />
        </label>
      </div>

      <h2>操作</h2>
      <div className="card">
        <button type="button" onClick={() => void add()} disabled={!queue.ready}>
          写真1枚で送信予約
        </button>{" "}
        <button
          type="button"
          onClick={() => void send()}
          disabled={!queue.ready || queue.isSyncing}
        >
          いま送信する
        </button>{" "}
        <button
          type="button"
          onClick={() => void queue.retryAll({ includeBlocked: true })}
          disabled={!queue.ready}
        >
          要対応も含めて再送
        </button>
      </div>

      <h2>ジョブ</h2>
      <div className="scroll">
        <table>
          <thead>
            <tr>
              <th>ラベル</th>
              <th>状態</th>
              <th>進捗</th>
            </tr>
          </thead>
          <tbody>
            {queue.jobs.map((job) => (
              <tr key={job.jobId}>
                <td>{job.label}</td>
                <td>{STATUS_LABEL[job.status]}</td>
                <td className="num">
                  {job.progress.uploadedCount} / {job.progress.totalCount}
                </td>
              </tr>
            ))}
            {queue.jobs.length === 0 && (
              <tr>
                <td colSpan={3} className="lead">
                  まだ何もありません
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <h2>送信済みの写真</h2>
      <div className="card" data-testid="thumbs">
        {uploaded.length === 0 ? (
          <span className="lead">まだありません</span>
        ) : (
          uploaded.map((attachment) => (
            <Thumb key={attachment.attachmentId + attachment.ref!.path} objectRef={attachment.ref!} />
          ))
        )}
      </div>

      <p className="lead" data-testid="session-id">
        {sessionId}
      </p>
    </main>
  );
}

export default function AppPage() {
  /*
   * セッション識別子は sessionStorage に置く。
   *
   * テストごとに分けたい（並列ワーカーでサーバ状態が混ざらないように）が、
   * 毎マウントで作り直すと DB 名まで変わり、再読み込みで下書きが消える。
   * sessionStorage ならタブの中では安定し、テスト間では別になる。
   */
  const [sessionId, setSessionId] = useState<string>("");

  useEffect(() => {
    const key = "pf-playground-session";
    let id = sessionStorage.getItem(key);
    if (!id) {
      id = newSessionId();
      sessionStorage.setItem(key, id);
    }
    setSessionId(id);
  }, []);

  const config = useMemo(
    () => ({
      appId: "playground-app",
      dbName: `pf-field-app-${sessionId}`,
      endpoints: {
        health: "/api/health",
        signUpload: "/api/uploads/sign",
        signView: "/api/files/sign-view",
        submit: { "playground.inspection": "/api/submit" },
      },
      auth: {
        issueJobToken: async ({ jobId }: { jobId: string }) => {
          const response = await fetch("/api/token", {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-Test-Session": sessionId },
            body: JSON.stringify({ jobId }),
          });
          return (await response.json()) as { token: string; expiresAt: number };
        },
        getHeaders: async () => ({ "X-Test-Session": sessionId }),
      },
      queue: { autoStart: false, pollIntervalMs: 0 },
    }),
    [sessionId],
  );

  if (!sessionId) {
    return (
      <main>
        <h1>アプリ組み込みの見本</h1>
        <p className="lead">準備中…</p>
      </main>
    );
  }

  return (
    <FieldCoreProvider config={config}>
      <Screen sessionId={sessionId} />
    </FieldCoreProvider>
  );
}
