import { compressImage } from "../image/compress.js";
import type { CompressedImage, CompressImageOptions } from "../image/types.js";
import { deleteOrphanBlobs, getBlob, toStoredBlob } from "../db/blobs.repo.js";
import {
  findSucceededBefore,
  getCounts,
  getJob,
  listJobs,
  listRunnable,
  recoverStaleActive,
  updateJob,
  updateJobAndDropBlobs,
} from "../db/jobs.repo.js";
import { openFieldDB, type FieldDB } from "../db/open.js";
import {
  assertCanEnqueue,
  DEFAULT_QUOTA,
  DEFAULT_RETENTION,
  ensurePersistence,
  getStorageHealth,
  type QuotaLimits,
  type RetentionLimits,
  type StorageHealth,
} from "../db/quota.js";
import {
  DEFAULT_JOB_TOKEN_TTL_MS,
  defaultDbName,
  type StoredBlob,
  type StoredJob,
} from "../db/schema.js";
import {
  clearSentinel,
  describeEviction,
  detectEviction,
  readSentinel,
  writeSentinel,
} from "../db/eviction.js";
import {
  deleteAllJobTokens,
  deleteExpiredJobTokens,
  deleteOrphanJobTokens,
  deleteJobToken,
  getJobToken,
  putJobToken,
} from "../db/tokens.repo.js";
import type { JobTokenIssue } from "../config.js";
import { createEmitter } from "../shared/emitter.js";
import { now } from "../shared/clock.js";
import { FieldCoreError } from "../shared/errors.js";
import { createLogger, noopLogger, type FieldLogger } from "../shared/logger.js";
import { uuid } from "../shared/uuid.js";
import type { StoredObjectRef } from "../storage/types.js";
import { DEFAULT_BACKOFF, DEFAULT_MAX_ATTEMPTS, type BackoffOptions } from "./backoff.js";
import { acquireRunnerLock } from "./lock.js";
import type { JobProcessor, ProcessContext } from "./processor.js";
import {
  markActive,
  markAttachmentUploaded,
  markCanceled,
  markFailed,
  markForRetry,
  markSucceeded,
  releaseToPending,
  setPhase,
  setProgress,
} from "./state.js";
import { createTriggers, type TriggerReason } from "./triggers.js";
import type {
  FlushResult,
  OfflineQueue,
  QueueAttachment,
  QueueAttachmentInput,
  QueueError,
  QueueFilter,
  QueueJob,
  QueueJobInput,
  QueueSnapshot,
} from "./types.js";

export type CompressFn = (blob: Blob, options?: CompressImageOptions) => Promise<CompressedImage>;

export interface OfflineQueueOptions {
  appId: string;
  dbName?: string;
  /** 既に開いてある接続を使う（テストや Service Worker との共有用） */
  db?: FieldDB;

  /** 送信の実体。未指定なら flush は何もしない（M3 で差し込む） */
  processor?: JobProcessor;

  /** 送信前の到達性確認。false を返すと今回は何もしない（M3 で差し込む） */
  precheck?: () => Promise<boolean>;

  /**
   * ジョブ単位の送信トークンを発行する。
   *
   * 認証が生きているうち（＝投入時）に受け取って端末に預かる。Cookie ではないので、
   * 無操作ログアウトやセッション期限で認証が切れても、預かった写真は送れる。
   */
  issueJobToken?: (job: { jobId: string; type: string }) => Promise<JobTokenIssue>;
  /** 送信トークンの既定の有効期限。既定26時間 */
  jobTokenTtlMs?: number;

  /**
   * 全リクエスト共通で足すヘッダ。
   * ジョブ単位の送信トークン（Authorization: Bearer）はキューが自分で足すので、
   * ここに書くのはそれ以外（テナント識別子など）。
   */
  authHeaders?: () => Promise<Record<string, string>>;

  /** 画像圧縮。テストから差し替えるためのフック */
  compress?: CompressFn;
  imageOptions?: CompressImageOptions;

  maxAttempts?: number;
  backoff?: Partial<BackoffOptions>;
  /** 同時に処理するジョブ数。既定 1 */
  concurrency?: number;
  pollIntervalMs?: number;
  autoStart?: boolean;

  retention?: Partial<RetentionLimits>;
  quota?: Partial<QuotaLimits>;

  /** active のまま取り残されたジョブを回収するまでの時間。既定 5分 */
  staleActiveAfterMs?: number;

  logger?: FieldLogger;
  onEvent?: (event: { type: string; at: number; data?: Record<string, unknown> }) => void;

  /** 多タブを見分けるための識別子。省略時は UUID */
  instanceId?: string;
  /** Web Locks を使わず IndexedDB のリースを使う（テスト用） */
  forceIdbLease?: boolean;
}

interface QueueEvents extends Record<string, unknown> {
  change: QueueSnapshot;
}

/** ストレージ状態の再計算を抑える間隔（estimate と走査が入るため） */
const HEALTH_CACHE_MS = 5_000;

export async function createOfflineQueue(options: OfflineQueueOptions): Promise<OfflineQueue> {
  const logger = options.logger ?? (options.logger === null ? noopLogger : createLogger("warn"));
  const instanceId = options.instanceId ?? uuid();
  const db = options.db ?? (await openFieldDB(options.dbName ?? defaultDbName(options.appId)));

  const retention: RetentionLimits = { ...DEFAULT_RETENTION, ...options.retention };
  const quota: QuotaLimits = { ...DEFAULT_QUOTA, ...options.quota };
  const backoff: Partial<BackoffOptions> = { ...DEFAULT_BACKOFF, ...options.backoff };
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const concurrency = Math.max(1, options.concurrency ?? 1);
  const compress = options.compress ?? compressImage;
  const staleActiveAfterMs = options.staleActiveAfterMs ?? 5 * 60_000;

  const emitter = createEmitter<QueueEvents>();
  const abortControllers = new Map<string, AbortController>();

  let persisted = false;
  let started = false;
  let syncing = false;
  let lastSyncAt: number | null = null;
  let lastError: QueueError | null = null;
  let cachedHealth: { at: number; value: StorageHealth } | null = null;
  let destroyed = false;
  let evictionSuspected = false;

  const triggers = createTriggers({
    onTrigger: (reason) => {
      void flushForTrigger(reason);
    },
    ...(options.pollIntervalMs !== undefined ? { pollIntervalMs: options.pollIntervalMs } : {}),
    shouldPoll: () => (cachedHealth?.value.unsent.jobs ?? 1) > 0,
  });

  function emitEvent(type: string, data?: Record<string, unknown>): void {
    options.onEvent?.({ type, at: now(), ...(data ? { data } : {}) });
  }

  async function health(force = false): Promise<StorageHealth> {
    const at = now();
    if (!force && cachedHealth && at - cachedHealth.at < HEALTH_CACHE_MS) {
      return cachedHealth.value;
    }
    const value = await getStorageHealth(db, { quota, retention }, { persisted, evictionSuspected });
    cachedHealth = { at, value };
    return value;
  }

  async function snapshot(): Promise<QueueSnapshot> {
    return {
      counts: await getCounts(db),
      isSyncing: syncing,
      lastSyncAt,
      lastError,
      storage: cachedHealth?.value ?? null,
    };
  }

  async function notify(): Promise<void> {
    if (destroyed) return;
    const current = await snapshot();
    // 消失検知の目印。IndexedDB だけが消えたときに気づけるようにする
    writeSentinel(options.appId, {
      unsent: current.counts.unsent,
      at: now(),
      dbName: options.dbName ?? defaultDbName(options.appId),
    });
    emitter.emit("change", current);
  }

  // ---------------------------------------------------------------- enqueue

  async function prepareAttachments(
    jobId: string,
    inputs: QueueAttachmentInput[],
  ): Promise<{ attachments: QueueAttachment[]; records: StoredBlob[] }> {
    const attachments: QueueAttachment[] = [];
    const records: StoredBlob[] = [];

    for (const input of inputs) {
      const attachmentId = input.attachmentId ?? uuid();
      const contentType = input.contentType ?? input.blob.type ?? "application/octet-stream";

      let blob: Blob = input.blob;
      let compression: Omit<CompressedImage, "blob"> | undefined;

      const shouldCompress = input.compress !== false && contentType.startsWith("image/");
      if (shouldCompress) {
        const merged = { ...options.imageOptions, ...(input.compress || {}) };
        const result = await compress(input.blob, merged);
        blob = result.blob;
        const { blob: _discarded, ...meta } = result;
        void _discarded;
        compression = meta;
      }

      attachments.push({
        attachmentId,
        fileName: input.fileName,
        contentType: shouldCompress ? blob.type || contentType : contentType,
        bytes: blob.size,
        status: "pending",
        ...(input.role !== undefined ? { role: input.role } : {}),
        ...(compression ? { compression } : {}),
        ...(input.meta ? { meta: input.meta } : {}),
      });
      // バイト列への変換はここで済ませる。書き込みトランザクションの内側で
      // 待つと、Safari ではその時点でトランザクションが確定してしまう
      records.push(await toStoredBlob(jobId, attachmentId, blob));
    }

    return { attachments, records };
  }

  async function enqueue<P>(input: QueueJobInput<P>): Promise<QueueJob<P>> {
    if (destroyed) throw new FieldCoreError("invalid_argument", "キューは破棄されています");
    if (!input.type) throw new FieldCoreError("invalid_argument", "type は必須です");

    const jobId = input.jobId ?? uuid();
    if (await getJob(db, jobId)) {
      throw new FieldCoreError("invalid_argument", `同じ jobId が既に存在します: ${jobId}`);
    }

    // 圧縮は enqueue のここで済ませる。送信時にはもう触らない
    // （署名付きURLの期限内に重い処理を挟まないため）
    const { attachments, records } = await prepareAttachments(jobId, input.attachments ?? []);
    const totalBytes = attachments.reduce((sum, a) => sum + a.bytes, 0);

    // 容量の確認は書き込みの直前に。ここで断れば、撮った直後に利用者へ伝えられる
    let current = await health(true);

    /*
     * 逼迫していたら、断る前に送信済みのジョブを古い順に片付ける。
     *
     * ただし期待しすぎないこと: 添付の実体は送信成功の時点で既に消しているので、
     * ここで解放できるのはジョブのレコードぶんだけで、多くはない。
     * 端末の空きを本当に空けられるのは「未送信を送り切る」ことだけで、
     * 未送信を自動で捨てる選択肢は無い（端末にしか無いデータのため）。
     */
    if (current.level !== "ok") {
      const purged = await purgeSucceeded(0);
      if (purged > 0) {
        logger.info("容量が逼迫していたため送信済みジョブを片付けました", { purged });
        current = await health(true);
      }
    }

    assertCanEnqueue(current, { attachments: attachments.length, bytes: totalBytes }, {
      quota,
      retention,
    });

    const at = now();
    const job: StoredJob = {
      jobId,
      type: input.type,
      status: "pending",
      payload: input.payload,
      attachments,
      attempts: 0,
      maxAttempts: input.maxAttempts ?? maxAttempts,
      priority: input.priority ?? 0,
      nextAttemptAt: null,
      progress: {
        uploadedBytes: 0,
        totalBytes,
        uploadedCount: 0,
        totalCount: attachments.length,
      },
      createdAt: at,
      updatedAt: at,
      ...(input.label !== undefined ? { label: input.label } : {}),
      ...(input.submitUrl !== undefined ? { submitUrl: input.submitUrl } : {}),
      ...(input.meta ? { meta: input.meta } : {}),
    };

    // ジョブと添付を1つのトランザクションで書く。
    // 分けると「ジョブはあるが画像が無い」「画像はあるがジョブが無い」が起きうる
    const tx = db.transaction(["jobs", "blobs"], "readwrite");
    await tx.objectStore("jobs").put(job);
    const blobStore = tx.objectStore("blobs");
    for (const record of records) {
      await blobStore.put(record);
    }
    await tx.done;

    // 認証が生きているのは「今」だけ。ここでトークンを取っておかないと、
    // 圏外から戻ったときには Cookie が消えていて送れない
    if (options.issueJobToken) {
      try {
        const issued = await options.issueJobToken({ jobId, type: job.type });
        await putJobToken(db, {
          jobId,
          token: issued.token,
          expiresAt: issued.expiresAt ?? at + (options.jobTokenTtlMs ?? DEFAULT_JOB_TOKEN_TTL_MS),
          createdAt: at,
        });
      } catch (error) {
        // トークンが取れなければ送れない。ジョブごと取り消して、
        // 「預かったのに送れない」状態を作らない
        await remove(jobId);
        throw new FieldCoreError(
          "invalid_argument",
          "送信用の認証情報を取得できませんでした。電波の届く場所でログインし直してください",
          { cause: error },
        );
      }
    }

    cachedHealth = null;
    emitEvent("job.enqueued", { jobId, type: job.type, attachments: attachments.length, totalBytes });
    await notify();

    // オンラインなら待たせない
    void flushForTrigger("enqueue");

    return job as QueueJob<P>;
  }

  // ------------------------------------------------------------------ 読み取り

  async function getAttachmentBlob(jobId: string, attachmentId: string): Promise<Blob | undefined> {
    return getBlob(db, jobId, attachmentId);
  }

  // ------------------------------------------------------------------ 状態操作

  async function retry(jobId: string): Promise<void> {
    const updated = await updateJob(db, jobId, (job) => {
      if (job.status !== "failed" && job.status !== "blocked") return undefined;
      return markForRetry(job);
    });
    if (updated) {
      emitEvent("job.retried", { jobId });
      await notify();
      void flushForTrigger("manual");
    }
  }

  async function retryAll(o?: { includeBlocked?: boolean }): Promise<void> {
    const statuses: QueueJob["status"][] = o?.includeBlocked
      ? ["failed", "blocked"]
      : ["failed"];
    const jobs = await listJobs(db, { status: statuses });
    for (const job of jobs) {
      await updateJob(db, job.jobId, (current) =>
        current.status === "failed" || current.status === "blocked"
          ? markForRetry(current)
          : undefined,
      );
    }
    if (jobs.length > 0) {
      emitEvent("job.retried-all", { count: jobs.length, includeBlocked: o?.includeBlocked === true });
      await notify();
      void flushForTrigger("manual");
    }
  }

  async function cancel(jobId: string): Promise<void> {
    abortControllers.get(jobId)?.abort();
    // 状態変更と添付の削除を分けると、その隙間で端末が落ちたときに孤児 Blob が残る
    const updated = await updateJobAndDropBlobs(db, jobId, (job) =>
      job.status === "succeeded" || job.status === "canceled" ? undefined : markCanceled(job),
    );
    if (updated) {
      await deleteJobToken(db, jobId);
      cachedHealth = null;
      emitEvent("job.canceled", { jobId });
      await notify();
    }
  }

  async function remove(jobId: string): Promise<void> {
    abortControllers.get(jobId)?.abort();
    const tx = db.transaction(["jobs", "blobs"], "readwrite");
    await tx.objectStore("jobs").delete(jobId);
    const index = tx.objectStore("blobs").index("by-job");
    for await (const cursor of index.iterate(jobId)) {
      await cursor.delete();
    }
    await tx.done;
    await deleteJobToken(db, jobId);
    cachedHealth = null;
    emitEvent("job.removed", { jobId });
    await notify();
  }

  async function purgeSucceeded(olderThanMs?: number): Promise<number> {
    const before = now() - (olderThanMs ?? retention.succeededMaxAgeMs);
    const ids = await findSucceededBefore(db, before);
    for (const jobId of ids) {
      const tx = db.transaction(["jobs", "blobs"], "readwrite");
      await tx.objectStore("jobs").delete(jobId);
      for await (const cursor of tx.objectStore("blobs").index("by-job").iterate(jobId)) {
        await cursor.delete();
      }
      await tx.done;
    }
    for (const jobId of ids) await deleteJobToken(db, jobId);
    if (ids.length > 0) {
      cachedHealth = null;
      emitEvent("job.purged", { count: ids.length });
      await notify();
    }
    return ids.length;
  }

  // -------------------------------------------------------------------- 送信

  function processContext(job: StoredJob, signal: AbortSignal): ProcessContext {
    return {
      signal,
      authHeaders: async () => {
        const base = (await options.authHeaders?.()) ?? {};
        // トークン方式を使っていない構成（Cookie のみ等）では tokenMissing を立てない。
        // 「使うと決めたのに無い」ときだけ、送る前に止める
        if (!options.issueJobToken) return { headers: base, tokenMissing: false };

        const token = await getJobToken(db, job.jobId);
        if (!token) return { headers: base, tokenMissing: true };

        return {
          headers: { ...base, Authorization: `Bearer ${token.token}` },
          tokenMissing: false,
        };
      },
      attachmentBlob: (attachmentId) => getBlob(db, job.jobId, attachmentId),
      reloadJob: () => getJob(db, job.jobId),
      onAttachmentUploaded: async (attachmentId: string, ref: StoredObjectRef) => {
        await updateJob(db, job.jobId, (current) =>
          markAttachmentUploaded(current, attachmentId, ref),
        );
        await notify();
      },
      onProgress: async (progress) => {
        await updateJob(db, job.jobId, (current) => setProgress(current, progress));
        await notify();
      },
      setPhase: async (phase) => {
        await updateJob(db, job.jobId, (current) => setPhase(current, phase));
        await notify();
      },
    };
  }

  async function processOne(job: StoredJob, processor: JobProcessor): Promise<"succeeded" | "failed"> {
    const claimed = await updateJob(db, job.jobId, (current) =>
      current.status === "pending" ? markActive(current, instanceId) : undefined,
    );
    // 他のタブに先を越された、または取り消された
    if (!claimed) return "failed";

    const controller = new AbortController();
    abortControllers.set(job.jobId, controller);
    await notify();

    try {
      const outcome = await processor.process(claimed, processContext(claimed, controller.signal));

      if (outcome.ok) {
        // 送信済みの画像を端末に残す理由はない。ここが容量回復の主役。
        // 状態変更と同じトランザクションで消し、隙間で落ちても孤児を作らない
        await updateJobAndDropBlobs(db, job.jobId, (current) =>
          current.status === "active" ? markSucceeded(current) : undefined,
        );
        await deleteJobToken(db, job.jobId);
        cachedHealth = null;
        lastError = null;
        emitEvent("job.succeeded", { jobId: job.jobId, ...(outcome.serverId ? { serverId: outcome.serverId } : {}) });
        return "succeeded";
      }

      await applyFailure(job.jobId, outcome.error);
      return "failed";
    } catch (error) {
      // processor が例外を投げた場合も失敗として扱う（キューは止めない）
      const queueError: QueueError = {
        kind: "unknown",
        retryable: true,
        message: error instanceof Error ? error.message : String(error),
        at: now(),
      };
      await applyFailure(job.jobId, queueError);
      return "failed";
    } finally {
      abortControllers.delete(job.jobId);
    }
  }

  async function applyFailure(jobId: string, error: QueueError): Promise<void> {
    lastError = error;
    const updated = await updateJob(db, jobId, (current) => {
      if (current.status !== "active") return undefined;
      return markFailed(current, error, { backoff }).job;
    });
    emitEvent("job.failed", {
      jobId,
      kind: error.kind,
      retryable: error.retryable,
      status: updated?.status ?? "unknown",
    });
    logger.warn(`ジョブの送信に失敗しました (${error.kind})`, { jobId, message: error.message });
  }

  async function flush(o?: {
    force?: boolean;
    jobIds?: string[];
    signal?: AbortSignal;
  }): Promise<FlushResult> {
    const empty: FlushResult = { attempted: 0, succeeded: 0, failed: 0, skipped: 0 };
    if (destroyed) return { ...empty, reason: "stopped" };

    const processor = options.processor;
    if (!processor) {
      // M3 で差し込むまではここに来る。状態は一切変えない
      return { ...empty, reason: "stopped" };
    }

    const lock = await acquireRunnerLock(db, instanceId, {
      ...(options.forceIdbLease !== undefined ? { forceIdbLease: options.forceIdbLease } : {}),
    });
    if (!lock) return { ...empty, reason: "locked" };

    syncing = true;
    await notify();

    try {
      // 落ちた WebView が残した「送信中」を回収する
      const recovered = await recoverStaleActive(db, { staleAfterMs: staleActiveAfterMs, instanceId });
      if (recovered.length > 0) {
        logger.info("取り残されていたジョブを回収しました", { count: recovered.length });
        emitEvent("job.recovered", { count: recovered.length });
      }

      if (!o?.force && options.precheck && !(await options.precheck())) {
        return { ...empty, reason: "unreachable" };
      }

      const result: FlushResult = { attempted: 0, succeeded: 0, failed: 0, skipped: 0 };
      // 1回の flush で同じジョブを2度試さない。
      // バックオフが 0 に振れたジョブで無限に回り続けるのを防ぐ
      const attempted = new Set<string>();

      for (;;) {
        if (destroyed || o?.signal?.aborted) break;

        const runnable = (
          await listRunnable(db, {
            ...(o?.jobIds ? { jobIds: o.jobIds } : {}),
            // 「いま送信する」を押したときは、バックオフの残り時間を待たない
            ...(o?.force ? { ignoreBackoff: true } : {}),
          })
        ).filter((job) => !attempted.has(job.jobId));
        if (runnable.length === 0) break;

        const batch = runnable.slice(0, concurrency);
        for (const job of batch) attempted.add(job.jobId);

        const outcomes = await Promise.all(
          batch.map((job) => processOne(job, processor)),
        );
        result.attempted += batch.length;
        for (const outcome of outcomes) {
          if (outcome === "succeeded") result.succeeded++;
          else result.failed++;
        }
      }

      if (result.attempted === 0) result.reason = "empty";
      lastSyncAt = now();

      if (result.succeeded > 0) await purgeSucceeded();

      // 未送信が無くなったら、預かっていた送信トークンを持ち続ける理由が無い
      if ((await getCounts(db)).unsent === 0) {
        const dropped = await deleteAllJobTokens(db);
        if (dropped > 0) emitEvent("token.cleared", { count: dropped });
      }

      return result;
    } finally {
      syncing = false;
      await lock.release();
      await notify();
    }
  }

  async function flushForTrigger(reason: TriggerReason): Promise<void> {
    if (!started || destroyed) return;
    try {
      const result = await flush();
      if (result.attempted > 0) {
        logger.debug("送信しました", { reason, ...result });
      }
    } catch (error) {
      logger.error("送信中に想定外のエラーが発生しました", {
        reason,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // ------------------------------------------------------------- 起動・停止

  function start(): void {
    if (started || destroyed) return;
    started = true;
    triggers.start();
    void (async () => {
      // 起動時の後片付け: 取り残された「送信中」、孤児 Blob、期限切れの成功ジョブ
      const recovered = await recoverStaleActive(db, {
        staleAfterMs: staleActiveAfterMs,
        instanceId,
      });
      const orphans = await deleteOrphanBlobs(db);
      const purged = await purgeSucceeded();
      const expiredTokens = await deleteExpiredJobTokens(db);
      const orphanTokens = await deleteOrphanJobTokens(db);

      /*
       * IndexedDB が消えていないかを確かめる。
       * iOS Safari は7日使わないと消す。利用者には「未送信バッジが0になった」
       * としか見えないので、送れたのか消えたのかを区別して伝える必要がある。
       */
      const totalJobs = (await getCounts(db)).total;
      const eviction = detectEviction(readSentinel(options.appId), totalJobs);
      if (eviction) {
        evictionSuspected = true;
        const message = describeEviction(eviction);
        logger.error(message, { lostJobs: eviction.lostJobs, lastSeenAt: eviction.lastSeenAt });
        emitEvent("storage.evicted", {
          lostJobs: eviction.lostJobs,
          lastSeenAt: eviction.lastSeenAt,
          message,
        });
        clearSentinel(options.appId);
      }
      if (recovered.length > 0 || orphans > 0 || purged > 0 || expiredTokens > 0 || orphanTokens > 0) {
        logger.info("起動時の後片付けを行いました", {
          recovered: recovered.length,
          orphanBlobs: orphans,
          purged,
          expiredTokens,
          orphanTokens,
        });
      }
      await health(true);
      await notify();
      void flushForTrigger("manual");
    })();
  }

  function stop(): void {
    started = false;
    triggers.stop();
    for (const controller of abortControllers.values()) controller.abort();
    abortControllers.clear();
  }

  async function destroy(): Promise<void> {
    stop();
    destroyed = true;
    emitter.clear();
    if (!options.db) db.close();
  }

  // 端末が容量を減らしても IndexedDB を勝手に捨てられないようにする
  persisted = await ensurePersistence();
  if (!persisted) {
    logger.warn(
      "ストレージの永続化が許可されていません。端末の空きが減ると未送信データが失われる可能性があります",
    );
    emitEvent("storage.not-persisted");
  }

  const queue: OfflineQueue = {
    enqueue,
    get: (jobId) => getJob(db, jobId) as Promise<QueueJob | undefined>,
    list: (filter?: QueueFilter) => listJobs(db, filter) as Promise<QueueJob[]>,
    counts: () => getCounts(db),
    flush,
    retry,
    retryAll,
    cancel,
    remove,
    purgeSucceeded,
    getAttachmentBlob,
    health: () => health(true),
    start,
    stop,
    subscribe: (listener) => {
      const off = emitter.on("change", listener);
      void snapshot().then(listener);
      return off;
    },
    destroy,
  };

  if (options.autoStart !== false) start();

  return queue;
}

/** 実行中のジョブを中断して pending へ戻す（試行回数は増やさない）。 */
export async function releaseJob(db: FieldDB, jobId: string): Promise<void> {
  await updateJob(db, jobId, (job) => (job.status === "active" ? releaseToPending(job) : undefined));
}
