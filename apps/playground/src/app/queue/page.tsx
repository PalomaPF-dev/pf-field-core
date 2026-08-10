"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  createOfflineQueue,
  isFieldCoreError,
  type JobProcessor,
  type OfflineQueue,
  type QueueJob,
  type QueueSnapshot,
} from "@palomapf-dev/pf-field-core";
import { createSyntheticPhoto } from "@/lib/test-image";

/**
 * オフラインキューの動作確認。
 *
 * 通信はまだ無い（M3）ので、送信は「成功する」「圏外で失敗する」「認証切れ」を
 * 選べるダミーに差し替えてある。ここで確かめたいのは、
 * 未送信件数・容量警告・手動再送・破棄といった**現場に見える振る舞い**。
 */

type Mode = "success" | "offline" | "auth-error";

/** 通信の代わり。M3 で本物の送信ランナーに差し替わる */
function createDemoProcessor(getMode: () => Mode): JobProcessor {
  return {
    async process(job, ctx) {
      await new Promise((r) => setTimeout(r, 300));
      const mode = getMode();
      if (mode === "offline") {
        return { ok: false, error: { kind: "network", retryable: true, message: "圏外です", at: Date.now() } };
      }
      if (mode === "auth-error") {
        return {
          ok: false,
          error: { kind: "auth", retryable: false, message: "ログインが切れています", at: Date.now() },
        };
      }
      for (const attachment of job.attachments) {
        if (attachment.status === "uploaded") continue;
        await new Promise((r) => setTimeout(r, 120));
        await ctx.onAttachmentUploaded(attachment.attachmentId, {
          provider: "supabase",
          bucket: "field-uploads",
          path: `pf-playground/${job.jobId}/${attachment.attachmentId}.jpg`,
        });
      }
      return { ok: true, serverId: `srv-${job.jobId.slice(0, 8)}` };
    },
  };
}

const STATUS_LABEL: Record<QueueJob["status"], string> = {
  pending: "待機中",
  active: "送信中",
  succeeded: "送信済み",
  failed: "失敗（再送できます）",
  blocked: "要対応",
  canceled: "破棄",
};

const STATUS_CLASS: Record<QueueJob["status"], string> = {
  pending: "warn",
  active: "warn",
  succeeded: "ok",
  failed: "ng",
  blocked: "ng",
  canceled: "",
};

function relative(at: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 60) return `${seconds}秒前`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}分前`;
  return `${Math.round(seconds / 3600)}時間前`;
}

function mb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

export default function QueuePage() {
  const queueRef = useRef<OfflineQueue | null>(null);
  const modeRef = useRef<Mode>("success");
  const [mode, setMode] = useState<Mode>("success");
  const [snapshot, setSnapshot] = useState<QueueSnapshot | null>(null);
  const [jobs, setJobs] = useState<QueueJob[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "ng"; text: string } | null>(null);

  modeRef.current = mode;

  const refresh = useCallback(async () => {
    const queue = queueRef.current;
    if (!queue) return;
    setJobs(await queue.list({ limit: 30 }));
  }, []);

  useEffect(() => {
    let disposed = false;
    let off: (() => void) | undefined;

    void (async () => {
      try {
        const queue = await createOfflineQueue({
        appId: "playground",
        processor: createDemoProcessor(() => modeRef.current),
        // 圏外の再現時に何十秒も待たされないよう、検証用に短くしてある
        backoff: { baseMs: 1_000, factor: 2, maxMs: 10_000, jitter: "full" },
        // 上限に当たる様子を見せるため、実運用よりかなり小さくしてある
        retention: { maxUnsentJobs: 8, maxUnsentAttachments: 12, maxUnsentBytes: 8 * 1024 * 1024 },
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
      } catch (error) {
        // 握りつぶすと「ボタンを押しても何も起きない」になり、原因が判らなくなる
        if (!disposed) {
          setMessage({
            kind: "ng",
            text: `キューを初期化できませんでした: ${
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
        // ★ QuotaExceededError（容量・滞留上限）はここに来る。
        //   利用者にその場で伝える経路がこれ
        const text = isFieldCoreError(error) ? error.message : String(error);
        setMessage({ kind: "ng", text });
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  const addJob = useCallback(
    (photos: number) =>
      run(async () => {
        const queue = queueRef.current;
        if (!queue) throw new Error("キューが初期化されていません");
        const attachments = [];
        for (let i = 0; i < photos; i++) {
          const photo = await createSyntheticPhoto(1600, 1200, 1);
          attachments.push({ blob: photo.blob, fileName: photo.name, role: i === 0 ? "before" : "after" });
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

  const counts = snapshot?.counts;
  const storage = snapshot?.storage;

  return (
    <main>
      <h1>オフラインキュー</h1>
      <p className="lead">通信はまだありません（M3）。送信結果を切り替えて振る舞いを確認します。</p>
      <nav>
        <Link href="/">← 戻る</Link>
      </nav>

      <h2>未送信</h2>
      <div className="card">
        <p style={{ fontSize: "1.4rem", margin: 0 }}>
          未送信 <strong>{counts?.unsent ?? 0}</strong> 件
          {counts?.oldestPendingAt ? (
            <span className="lead"> （最古 {relative(counts.oldestPendingAt)}）</span>
          ) : null}
        </p>
        <p className="lead" style={{ margin: "0.25rem 0 0" }}>
          待機 {counts?.pending ?? 0} / 送信中 {counts?.active ?? 0} / 失敗 {counts?.failed ?? 0} / 要対応{" "}
          {counts?.blocked ?? 0} / 送信済み {counts?.succeeded ?? 0}
        </p>
      </div>

      {message && (
        <div className="card" data-testid="message">
          <span className={`badge ${message.kind}`}>{message.kind === "ok" ? "OK" : "エラー"}</span>{" "}
          {message.text}
        </div>
      )}

      {storage && storage.level !== "ok" && (
        <div className="card">
          <span className={`badge ${storage.level === "critical" ? "ng" : "warn"}`}>
            {storage.level === "critical" ? "保存できません" : "容量注意"}
          </span>{" "}
          {storage.reason}
        </div>
      )}

      <h2>操作</h2>
      <div className="card">
        <p>
          送信結果:{" "}
          <select value={mode} onChange={(e) => setMode(e.target.value as Mode)}>
            <option value="success">成功する</option>
            <option value="offline">圏外（自動で再試行）</option>
            <option value="auth-error">認証切れ（要対応になる）</option>
          </select>
        </p>
        <p>
          <button onClick={() => void addJob(1)} disabled={busy}>
            点検を1件追加（写真1枚）
          </button>{" "}
          <button onClick={() => void addJob(3)} disabled={busy}>
            点検を1件追加（写真3枚）
          </button>
        </p>
        <p>
          <button
            onClick={() => void run(async () => void (await queueRef.current?.flush({ force: true })))}
            disabled={busy || snapshot?.isSyncing === true}
          >
            {snapshot?.isSyncing ? "送信中…" : "いま送信する"}
          </button>{" "}
          <button
            onClick={() => void run(async () => queueRef.current?.retryAll({ includeBlocked: true }))}
            disabled={busy}
          >
            要対応も含めて再送
          </button>{" "}
          <button
            onClick={() => void run(async () => void (await queueRef.current?.purgeSucceeded(0)))}
            disabled={busy}
          >
            送信済みを片付ける
          </button>
        </p>
      </div>

      <h2>端末ストレージ</h2>
      <div className="scroll">
        <table>
          <tbody>
            <tr>
              <th>永続化</th>
              <td className="num">
                {storage?.persisted ? (
                  <span className="badge ok">許可</span>
                ) : (
                  <span className="badge warn">未許可</span>
                )}
              </td>
            </tr>
            <tr>
              <th>空き容量</th>
              <td className="num">
                {storage?.availableBytes !== null && storage?.availableBytes !== undefined
                  ? mb(storage.availableBytes)
                  : "取得できません"}
              </td>
            </tr>
            <tr>
              <th>未送信の滞留</th>
              <td className="num">
                {storage ? `${storage.unsent.jobs} 件 / 写真 ${storage.unsent.attachments} 枚 / ${mb(storage.unsent.bytes)}` : "—"}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p className="lead">
        この画面の上限は検証用に小さくしてあります（8件 / 写真12枚 / 8MB）。
        上限に達すると <code>enqueue</code> が <code>QuotaExceededError</code> を投げ、
        上の「エラー」欄にそのまま出ます。未送信のデータは**消しません**。
      </p>

      <h2>一覧</h2>
      {jobs.length === 0 ? (
        <p className="lead">まだ何もありません。</p>
      ) : (
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th>内容</th>
                <th>状態</th>
                <th className="num">写真</th>
                <th className="num">試行</th>
                <th>直近のエラー</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((job) => (
                <tr key={job.jobId}>
                  <td>
                    {job.label ?? job.type}
                    <br />
                    <span className="lead">{relative(job.createdAt)}</span>
                  </td>
                  <td>
                    <span className={`badge ${STATUS_CLASS[job.status]}`}>
                      {STATUS_LABEL[job.status]}
                    </span>
                  </td>
                  <td className="num">
                    {job.progress.uploadedCount} / {job.progress.totalCount}
                  </td>
                  <td className="num">
                    {job.attempts} / {job.maxAttempts}
                  </td>
                  <td>{job.lastError ? `${job.lastError.kind}: ${job.lastError.message}` : "—"}</td>
                  <td>
                    {(job.status === "failed" || job.status === "blocked") && (
                      <button onClick={() => void run(async () => queueRef.current?.retry(job.jobId))}>
                        再送
                      </button>
                    )}{" "}
                    {job.status !== "succeeded" && job.status !== "canceled" && (
                      <button onClick={() => void run(async () => queueRef.current?.cancel(job.jobId))}>
                        破棄
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
