import { now } from "../shared/clock.js";
import type { StoredJob } from "../db/schema.js";
import type { QueueError, QueueJobPhase, QueueJobProgress, QueueJobStatus } from "./types.js";
import { nextAttemptAt, type BackoffOptions } from "./backoff.js";

/**
 * ジョブの状態遷移。
 *
 * すべて純関数にしてある。状態機械の正しさは、IndexedDB や通信を持ち込まずに
 * ここだけで確かめられるようにしたい（そこが一番間違えやすいため）。
 */

/** どの状態からどの状態へ移ってよいか */
const ALLOWED: Record<QueueJobStatus, QueueJobStatus[]> = {
  pending: ["active", "canceled"],
  active: ["succeeded", "pending", "failed", "blocked", "canceled"],
  succeeded: [],
  // 手動再送で pending に戻せる
  failed: ["pending", "canceled"],
  blocked: ["pending", "canceled"],
  canceled: [],
};

export function canTransition(from: QueueJobStatus, to: QueueJobStatus): boolean {
  return ALLOWED[from].includes(to);
}

export class InvalidTransitionError extends Error {
  constructor(
    readonly from: QueueJobStatus,
    readonly to: QueueJobStatus,
  ) {
    super(`ジョブの状態を ${from} から ${to} へ変更できません`);
    this.name = "InvalidTransitionError";
  }
}

function touch(job: StoredJob, at: number): StoredJob {
  return { ...job, updatedAt: at };
}

/** 送信ランナーが処理を開始する。 */
export function markActive(job: StoredJob, instanceId: string, at = now()): StoredJob {
  if (!canTransition(job.status, "active")) throw new InvalidTransitionError(job.status, "active");
  return {
    ...touch(job, at),
    status: "active",
    activeSince: at,
    activeBy: instanceId,
    phase: "signing",
  };
}

export function setPhase(job: StoredJob, phase: QueueJobPhase, at = now()): StoredJob {
  return { ...touch(job, at), phase };
}

export function setProgress(
  job: StoredJob,
  progress: Partial<QueueJobProgress>,
  at = now(),
): StoredJob {
  return { ...touch(job, at), progress: { ...job.progress, ...progress } };
}

export function markSucceeded(job: StoredJob, at = now()): StoredJob {
  if (!canTransition(job.status, "succeeded")) {
    throw new InvalidTransitionError(job.status, "succeeded");
  }
  const next: StoredJob = {
    ...touch(job, at),
    status: "succeeded",
    succeededAt: at,
    progress: {
      ...job.progress,
      uploadedCount: job.progress.totalCount,
      uploadedBytes: job.progress.totalBytes,
    },
  };
  delete next.activeSince;
  delete next.activeBy;
  delete next.phase;
  delete next.lastError;
  next.nextAttemptAt = null;
  return next;
}

export interface FailureOutcome {
  job: StoredJob;
  /** 次にどうなるか（ログと通知のため） */
  disposition: "retry" | "give-up" | "blocked";
}

/**
 * 失敗を記録する。
 *
 * 「待てば直る見込みがあるか」で行き先が変わる:
 *   retryable=false → blocked（人手が要る。自動では二度と試さない）
 *   試行回数が上限  → failed（手動再送で復帰できる）
 *   それ以外        → pending（バックオフののち自動で再試行）
 */
export function markFailed(
  job: StoredJob,
  error: QueueError,
  options?: { backoff?: Partial<BackoffOptions>; at?: number; random?: () => number },
): FailureOutcome {
  const at = options?.at ?? now();
  const base: StoredJob = { ...touch(job, at), lastError: error };
  delete base.activeSince;
  delete base.activeBy;
  delete base.phase;

  if (!error.retryable) {
    if (!canTransition(job.status, "blocked")) throw new InvalidTransitionError(job.status, "blocked");
    return {
      job: { ...base, status: "blocked", nextAttemptAt: null },
      disposition: "blocked",
    };
  }

  const attempts = job.attempts + 1;
  if (attempts >= job.maxAttempts) {
    if (!canTransition(job.status, "failed")) throw new InvalidTransitionError(job.status, "failed");
    return {
      job: { ...base, status: "failed", attempts, nextAttemptAt: null },
      disposition: "give-up",
    };
  }

  if (!canTransition(job.status, "pending")) throw new InvalidTransitionError(job.status, "pending");
  return {
    job: {
      ...base,
      status: "pending",
      attempts,
      nextAttemptAt: nextAttemptAt(attempts, at, options?.backoff, options?.random),
    },
    disposition: "retry",
  };
}

/**
 * 実行を中断して pending に戻す（試行回数は増やさない）。
 *
 * 端末が落ちた・タブが閉じられた・ロックを失った、といった
 * 「サーバのせいでも通信のせいでもない」中断に使う。
 * ここで試行回数を増やすと、WebView が何度か kill されただけで
 * ジョブが failed に落ちてしまう。
 */
export function releaseToPending(job: StoredJob, at = now()): StoredJob {
  const next: StoredJob = { ...touch(job, at), status: "pending" };
  delete next.activeSince;
  delete next.activeBy;
  delete next.phase;
  return next;
}

/**
 * 手動再送。試行回数を 0 に戻して即時実行できるようにする。
 *
 * 利用者が明示的に押した以上、前回の失敗の履歴で待たせる理由がない。
 * （多くは「電波の届く場所へ移動した」「再ログインした」直後に押される）
 */
export function markForRetry(job: StoredJob, at = now()): StoredJob {
  if (!canTransition(job.status, "pending")) throw new InvalidTransitionError(job.status, "pending");
  const next: StoredJob = {
    ...touch(job, at),
    status: "pending",
    attempts: 0,
    nextAttemptAt: null,
  };
  delete next.activeSince;
  delete next.activeBy;
  delete next.phase;
  return next;
}

export function markCanceled(job: StoredJob, at = now()): StoredJob {
  if (!canTransition(job.status, "canceled")) {
    throw new InvalidTransitionError(job.status, "canceled");
  }
  const next: StoredJob = { ...touch(job, at), status: "canceled", nextAttemptAt: null };
  delete next.activeSince;
  delete next.activeBy;
  delete next.phase;
  return next;
}

/** 添付1件のアップロード完了を記録する。 */
export function markAttachmentUploaded(
  job: StoredJob,
  attachmentId: string,
  ref: NonNullable<StoredJob["attachments"][number]["ref"]>,
  at = now(),
): StoredJob {
  let uploadedBytes = 0;
  let uploadedCount = 0;

  const attachments = job.attachments.map((attachment) => {
    const updated =
      attachment.attachmentId === attachmentId
        ? { ...attachment, status: "uploaded" as const, ref, uploadedAt: at }
        : attachment;
    if (updated.status === "uploaded") {
      uploadedCount++;
      uploadedBytes += updated.bytes;
    }
    return updated;
  });

  return {
    ...touch(job, at),
    attachments,
    progress: { ...job.progress, uploadedCount, uploadedBytes },
  };
}

/** まだ送っていない添付。途中で切れても残りだけを送るために使う。 */
export function pendingAttachments(job: StoredJob): StoredJob["attachments"] {
  return job.attachments.filter((attachment) => attachment.status !== "uploaded");
}

export function isTerminal(status: QueueJobStatus): boolean {
  return status === "succeeded" || status === "canceled";
}
