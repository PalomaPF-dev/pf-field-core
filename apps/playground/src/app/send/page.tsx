"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  createHttpSubmitAdapter,
  createOfflineQueue,
  createUploadProcessor,
  isFieldCoreError,
  type OfflineQueue,
  type QueueJob,
  type QueueSnapshot,
} from "@palomapf-dev/pf-field-core";
import { createHttpSignedStorageAdapter } from "@palomapf-dev/pf-field-core/storage";
import { createSyntheticPhoto } from "@/lib/test-image";

/**
 * 送信ランナー（M3）を**実 HTTP** で動かす画面。
 *
 * /queue はキューの振る舞い（滞留・容量・破棄）を見るためのもので、通信はダミー。
 * こちらは署名 → アップロード → 本体送信を本物の fetch と XHR で通す。
 * 相手は playground 内の Route Handler なので Supabase は要らないが、
 * 端末側のコードは本番とまったく同じものが走る。
 */

type Mode =
  | "ok"
  | "upload-network"
  | "upload-partial"
  | "submit-401"
  | "submit-redirect"
  | "submit-503";

const MODE_LABEL: Record<Mode, string> = {
  ok: "正常",
  "upload-network": "アップロードが圏外",
  "upload-partial": "2枚目以降だけ切断",
  "submit-401": "本体送信が認証切れ(401)",
  "submit-redirect": "本体送信がログイン画面へリダイレクト",
  "submit-503": "本体送信が 503",
};

const STATUS_LABEL: Record<QueueJob["status"], string> = {
  pending: "待機中",
  active: "送信中",
  succeeded: "送信済み",
  failed: "失敗（再送できます）",
  blocked: "要対応",
  canceled: "破棄",
};

/** ワーカー並列でもサーバ側の状態が混ざらないよう、画面ごとに識別子を持つ */
function newSessionId(): string {
  return `s-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
}

export default function SendPage() {
  const queueRef = useRef<OfflineQueue | null>(null);
  const sessionIdRef = useRef<string>("");
  if (!sessionIdRef.current) sessionIdRef.current = newSessionId();

  const [mode, setMode] = useState<Mode>("ok");
  /**
   * サーバが実際に受け付けた応答モード。E2E はこれが確定するのを待ってから送信する。
   * 切り替え中は "…" にする — 初期値と目的値が同じだと「待ったつもり」で素通りするため
   */
  const [serverMode, setServerMode] = useState<Mode | "…">("ok");
  const [snapshot, setSnapshot] = useState<QueueSnapshot | null>(null);
  const [jobs, setJobs] = useState<QueueJob[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "ng"; text: string } | null>(null);

  const refresh = useCallback(async () => {
    const queue = queueRef.current;
    if (!queue) return;
    setJobs(await queue.list({ limit: 30 }));
  }, []);

  useEffect(() => {
    let disposed = false;
    let off: (() => void) | undefined;
    const sessionId = sessionIdRef.current;
    const testHeaders = { "X-Test-Session": sessionId };

    void (async () => {
      try {
        const queue = await createOfflineQueue({
          appId: "playground-send",
          dbName: `pf-field-send-${sessionId}`,

          // ★ 本番と同じ組み合わせ。差し替えているのは宛先だけ
          processor: createUploadProcessor({
            storage: createHttpSignedStorageAdapter({ signUrl: "/api/uploads/sign" }),
            submit: createHttpSubmitAdapter({ urls: { "playground.inspection": "/api/submit" } }),
          }),

          // 認証が生きているうちに、そのジョブ専用の送信トークンを受け取る
          issueJobToken: async ({ jobId }) => {
            const response = await fetch("/api/token", {
              method: "POST",
              headers: { "Content-Type": "application/json", ...testHeaders },
              body: JSON.stringify({ jobId }),
            });
            if (!response.ok) throw new Error(`トークンを取得できません (${response.status})`);
            return (await response.json()) as { token: string; expiresAt: number };
          },

          authHeaders: async () => testHeaders,

          // 圏外の再現で何十秒も待たされないよう、検証用に短くしてある
          backoff: { baseMs: 300, factor: 2, maxMs: 2_000, jitter: "none" },
          autoStart: false,
        });

        if (disposed) {
          void queue.destroy();
          return;
        }
        queueRef.current = queue;
        off = queue.subscribe((s) => {
          setSnapshot(s);
          void refresh();
        });
        await refresh();
      } catch (error) {
        if (!disposed) {
          setMessage({
            kind: "ng",
            text: `初期化できませんでした: ${
              error instanceof Error ? `${error.name}: ${error.message}` : String(error)
            }`,
          });
        }
      }
    })();

    return () => {
      disposed = true;
      off?.();
      void queueRef.current?.destroy();
      queueRef.current = null;
    };
  }, [refresh]);

  const run = useCallback(
    async (fn: () => Promise<void>) => {
      setBusy(true);
      setMessage(null);
      try {
        await fn();
        await refresh();
      } catch (error) {
        setMessage({ kind: "ng", text: isFieldCoreError(error) ? error.message : String(error) });
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  const changeMode = useCallback(
    (next: Mode) =>
      run(async () => {
        setMode(next);
        setServerMode("…");
        const response = await fetch("/api/test-mode", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Test-Session": sessionIdRef.current },
          body: JSON.stringify({ mode: next }),
        });
        // サーバが実際に受け付けた値を表示する。
        // 選択しただけの状態で送信を始めると、切り替わる前の応答を掴んでしまう
        const applied = (await response.json()) as { mode: Mode };
        setServerMode(applied.mode);
      }),
    [run],
  );

  const addJob = useCallback(
    (photos: number) =>
      run(async () => {
        const queue = queueRef.current;
        if (!queue) throw new Error("キューが初期化されていません");
        const attachments = [];
        for (let i = 0; i < photos; i++) {
          const photo = await createSyntheticPhoto(800, 600, 1);
          attachments.push({
            // 「2枚目以降だけ落とす」を作れるよう、添付の識別子を決め打ちにする
            attachmentId: `att-${i + 1}`,
            blob: photo.blob,
            fileName: photo.name,
            role: i === 0 ? "before" : "after",
          });
        }
        const job = await queue.enqueue({
          type: "playground.inspection",
          payload: { at: new Date().toISOString() },
          label: `点検 ${new Date().toLocaleTimeString("ja-JP")}`,
          attachments,
        });
        setMessage({ kind: "ok", text: `送信予約しました（写真 ${job.attachments.length} 枚）` });
      }),
    [run],
  );

  const send = useCallback(
    () =>
      run(async () => {
        const queue = queueRef.current;
        if (!queue) throw new Error("キューが初期化されていません");
        const result = await queue.flush({ force: true });
        setMessage({
          kind: result.failed > 0 ? "ng" : "ok",
          text: `送信 ${result.succeeded} 件 / 失敗 ${result.failed} 件`,
        });
      }),
    [run],
  );

  const counts = snapshot?.counts;

  return (
    <main>
      <h1>送信ランナー</h1>
      <p className="lead">
        署名 → アップロード → 本体送信を、実際の HTTP で通します。
      </p>
      <nav>
        <Link href="/">← 戻る</Link> / <Link href="/queue">キュー（通信なし）</Link>
      </nav>

      <div className="card">
        <strong data-testid="unsent">未送信 {counts?.unsent ?? 0} 件</strong>
        <div className="lead">
          待機 {counts?.pending ?? 0} / 送信中 {counts?.active ?? 0} / 失敗 {counts?.failed ?? 0} /
          要対応 {counts?.blocked ?? 0} / 送信済み {counts?.succeeded ?? 0}
        </div>
      </div>

      {message && (
        <div className="card" data-testid="message">
          <span className={`badge ${message.kind}`}>{message.kind === "ok" ? "OK" : "エラー"}</span>{" "}
          {message.text}
        </div>
      )}

      <h2>サーバの状態</h2>
      <div className="card">
        <label>
          応答:{" "}
          <select
            value={mode}
            onChange={(event) => void changeMode(event.target.value as Mode)}
            disabled={busy}
          >
            {(Object.keys(MODE_LABEL) as Mode[]).map((key) => (
              <option key={key} value={key}>
                {MODE_LABEL[key]}
              </option>
            ))}
          </select>
        </label>{" "}
        <span className="badge" data-testid="server-mode">
          {serverMode}
        </span>
      </div>

      <h2>操作</h2>
      <div className="card">
        <button type="button" onClick={() => void addJob(1)} disabled={busy}>
          点検を1件追加（写真1枚）
        </button>{" "}
        <button type="button" onClick={() => void addJob(3)} disabled={busy}>
          点検を1件追加（写真3枚）
        </button>{" "}
        <button type="button" onClick={() => void send()} disabled={busy}>
          いま送信する
        </button>{" "}
        <button
          type="button"
          onClick={() => void run(async () => queueRef.current?.retryAll({ includeBlocked: true }))}
          disabled={busy}
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
              <th>添付</th>
              <th>試行</th>
              <th>直近のエラー</th>
            </tr>
          </thead>
          <tbody>
            {jobs.map((job) => (
              <tr key={job.jobId}>
                <td>{job.label}</td>
                <td>{STATUS_LABEL[job.status]}</td>
                <td className="num">
                  {job.attachments.filter((a) => a.status === "uploaded").length} /{" "}
                  {job.attachments.length}
                </td>
                <td className="num">{job.attempts}</td>
                <td>{job.lastError?.message ?? "—"}</td>
              </tr>
            ))}
            {jobs.length === 0 && (
              <tr>
                <td colSpan={5} className="lead">
                  まだ何もありません
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <p className="lead" data-testid="session-id">
        {sessionIdRef.current}
      </p>
    </main>
  );
}
