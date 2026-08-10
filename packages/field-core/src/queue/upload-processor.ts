import { queueErrorFromThrown } from "./errors.js";
import { UploadFailure, uploadFailure } from "../storage/transport.js";
import { createHttpSignedStorageAdapter } from "../storage/http-signed.js";
import { now } from "../shared/clock.js";
import { noopLogger, type FieldLogger } from "../shared/logger.js";
import type { StorageAdapter, StoredObjectRef, UploadTarget } from "../storage/types.js";
import type { SubmitAdapter } from "../submit/types.js";
import type { JobProcessor, ProcessContext, ProcessOutcome } from "./processor.js";
import type { QueueAttachment, QueueError, QueueJob } from "./types.js";

/**
 * 送信ランナー（M3）。署名 → アップロード → 本体送信 を1ジョブぶん進める。
 *
 * キュー（M2）との分担:
 *   キュー   … 永続化・状態遷移・実行順・バックオフ・排他
 *   ランナー … 通信のやり方
 *
 * このファイルで守っているのは「送れていないものを送れたことにしない」の一点。
 * 具体的には:
 *   - `res.ok` で成功を判定しない（fetch-safe.ts の classifyResponse を通す）
 *   - リダイレクト（ログイン画面）を成功と誤認しない（redirect: "manual"）
 *   - 401 でもジョブを消さない。blocked(auth) で端末に残す
 *   - 添付は1枚ごとに完了を記録する。3枚中2枚で切れても、次回は残り1枚だけ送る
 */

export interface UploadProcessorOptions {
  /** 省略時は createHttpSignedStorageAdapter() */
  storage?: StorageAdapter;
  submit: SubmitAdapter;

  /**
   * 1ジョブ内の添付の同時アップロード数。既定2。
   * 一度でも通信で失敗しているジョブは自動的に1本に落とす（弱電界で束ねると共倒れするため）。
   */
  attachmentConcurrency?: number;

  /**
   * 認証エラーを受けたときに1回だけ呼ばれる。
   * true を返せばもう一度だけ試す（トークンを取り直せた場合など）。
   * false ならジョブは blocked(auth) として残る。**消さない。**
   */
  onUnauthorized?: (job: { jobId: string; type: string }) => Promise<boolean>;

  logger?: FieldLogger;
}

export function createUploadProcessor(options: UploadProcessorOptions): JobProcessor {
  const storage = options.storage ?? createHttpSignedStorageAdapter();
  const submit = options.submit;
  const logger = options.logger ?? noopLogger;
  const configuredConcurrency = Math.max(1, options.attachmentConcurrency ?? 2);

  async function runOnce(job: QueueJob, ctx: ProcessContext): Promise<void> {
    const auth = await ctx.authHeaders();

    /*
     * トークン方式なのにトークンが無い＝発行から26時間を超えた、または端末から消えた。
     * 送っても 401 になるだけなので、通信する前に auth エラーにする。
     * ジョブは消さない — 再ログインすれば retryAll(includeBlocked) で救える。
     */
    if (auth.tokenMissing) {
      throw uploadFailure({
        kind: "auth",
        retryable: false,
        message: "送信用の認証情報の期限が切れています。ログインし直して再送してください",
        at: now(),
      });
    }

    const headers = auth.headers;
    const pending = job.attachments.filter((a) => a.status !== "uploaded");
    const done = job.attachments.filter((a) => a.status === "uploaded");

    if (pending.length > 0) {
      await uploadPending(job, pending, done, headers, ctx);
    }

    // 送信本体。ここまでで全添付の ref が揃っている
    await ctx.setPhase("submitting");
    const refs = collectRefs(await refreshedAttachments(job, ctx));
    await submit.send(job, refs, { headers, signal: ctx.signal });
  }

  async function uploadPending(
    job: QueueJob,
    pending: QueueAttachment[],
    done: QueueAttachment[],
    headers: Record<string, string>,
    ctx: ProcessContext,
  ): Promise<void> {
    await ctx.setPhase("signing");

    // 実体を先に集める。ここで欠けていたら、署名を取っても送るものが無い
    const blobs = new Map<string, Blob>();
    for (const attachment of pending) {
      const blob = await ctx.attachmentBlob(attachment.attachmentId);
      if (!blob) {
        /*
         * 端末から画像だけが消えた（ストレージ逼迫による退避など）。
         * 待っても戻らないので再試行しない。blocked にして人が気づけるようにする。
         * ここで「無いものを送った」ことにすると、サーバには本文だけが残る。
         */
        throw uploadFailure({
          kind: "validation",
          retryable: false,
          message: `写真が端末から失われています（${attachment.fileName}）。この点検は送信できません`,
          at: now(),
        });
      }
      blobs.set(attachment.attachmentId, blob);
    }

    const targets = await storage.createUploadTargets(
      {
        jobId: job.jobId,
        jobType: job.type,
        files: pending.map((a) => ({
          attachmentId: a.attachmentId,
          fileName: a.fileName,
          contentType: a.contentType,
          bytes: a.bytes,
          ...(a.role !== undefined ? { role: a.role } : {}),
        })),
      },
      { headers, signal: ctx.signal },
    );

    await ctx.setPhase("uploading");

    const byAttachment = new Map(targets.map((t) => [t.attachmentId, t]));
    // 既に送り終えているぶんは進捗の起点として数える
    const baseBytes = done.reduce((sum, a) => sum + a.bytes, 0);
    const inFlight = new Map<string, number>();

    const reportProgress = async (): Promise<void> => {
      let loaded = baseBytes;
      for (const bytes of inFlight.values()) loaded += bytes;
      await ctx.onProgress({ uploadedBytes: loaded });
    };

    // 一度でも通信で転んだジョブは束ねずに1本ずつ送る。
    // 弱電界で並列に流すと、共倒れして全部が最初からやり直しになる
    const concurrency = job.attempts > 0 ? 1 : Math.min(configuredConcurrency, pending.length);

    const queue = [...pending];
    const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
      for (;;) {
        const attachment = queue.shift();
        if (!attachment) return;
        if (ctx.signal.aborted) return;

        const target = byAttachment.get(attachment.attachmentId);
        if (!target) {
          throw uploadFailure({
            kind: "server",
            retryable: false,
            message: `アップロード先が発行されませんでした（${attachment.fileName}）`,
            at: now(),
          });
        }

        const blob = blobs.get(attachment.attachmentId)!;
        const result = await uploadOne(target, blob, attachment, headers, ctx, async (loaded) => {
          inFlight.set(attachment.attachmentId, loaded);
          await reportProgress();
        });

        // **1枚ごとに記録する。** ここが「途中で切れても残りだけ送る」の実体
        inFlight.set(attachment.attachmentId, attachment.bytes);
        await ctx.onAttachmentUploaded(attachment.attachmentId, result);
        await reportProgress();
      }
    });

    /*
     * `Promise.all` ではなく `allSettled`。
     *
     * all は最初の失敗で即座に reject するので、並走している別の添付が
     * 送信途中のまま見捨てられる。そのぶんは完了を記録できないため、
     * 次回また最初から送り直しになる — 弱電界でいちばん払いたくない代償。
     * 全部の決着を待ってから、最初の失敗を投げ直す。
     */
    const settled = await Promise.allSettled(workers);
    const failure = settled.find((r) => r.status === "rejected");
    if (failure) throw (failure as PromiseRejectedResult).reason;
  }

  async function uploadOne(
    target: UploadTarget,
    blob: Blob,
    attachment: QueueAttachment,
    headers: Record<string, string>,
    ctx: ProcessContext,
    onProgress: (loaded: number) => Promise<void>,
  ): Promise<StoredObjectRef> {
    if (!storage.upload) {
      throw uploadFailure({
        kind: "unknown",
        retryable: false,
        message: `${storage.name} アダプタは upload を実装していません`,
        at: now(),
      });
    }

    const result = await storage.upload(target, blob, {
      headers,
      signal: ctx.signal,
      onProgress: (loaded) => {
        void onProgress(loaded);
      },
    });

    logger.debug?.("添付を送信しました", {
      attachmentId: attachment.attachmentId,
      bytes: result.bytes,
      durationMs: result.durationMs,
      ...(result.alreadyExisted ? { alreadyExisted: true } : {}),
    });

    return result.ref;
  }

  /** onAttachmentUploaded で書き込んだ ref を読み直す。DB が正 */
  async function refreshedAttachments(
    job: QueueJob,
    ctx: ProcessContext,
  ): Promise<QueueAttachment[]> {
    const latest = await ctx.reloadJob?.();
    return latest?.attachments ?? job.attachments;
  }

  function collectRefs(attachments: QueueAttachment[]): StoredObjectRef[] {
    return attachments
      .map((a) => a.ref)
      .filter((ref): ref is StoredObjectRef => ref !== undefined);
  }

  return {
    async process(job: QueueJob, ctx: ProcessContext): Promise<ProcessOutcome> {
      try {
        await runOnce(job, ctx);
        return { ok: true };
      } catch (first) {
        const error = toQueueError(first);

        // 認証エラーは1回だけ救済を試みる（トークンを取り直せる構成のため）
        if (error.kind === "auth" && options.onUnauthorized) {
          let recovered = false;
          try {
            recovered = await options.onUnauthorized({ jobId: job.jobId, type: job.type });
          } catch (hookError) {
            logger.warn?.("onUnauthorized が失敗しました", { error: String(hookError) });
          }

          if (recovered) {
            try {
              await runOnce(job, ctx);
              return { ok: true };
            } catch (second) {
              return { ok: false, error: toQueueError(second) };
            }
          }
        }

        return { ok: false, error };
      }
    },
  };
}

function toQueueError(error: unknown): QueueError {
  if (error instanceof UploadFailure) return error.queueError;
  return queueErrorFromThrown(error);
}
