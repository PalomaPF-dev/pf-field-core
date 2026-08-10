import { now } from "../shared/clock.js";
import type { QueueCounts, QueueFilter, QueueJobStatus } from "../queue/types.js";
import type { FieldDB } from "./open.js";
import { isUnsent, UNSENT_STATUSES, type StoredJob } from "./schema.js";

const ALL_STATUSES: QueueJobStatus[] = [
  "pending",
  "active",
  "succeeded",
  "failed",
  "blocked",
  "canceled",
];

export async function putJob(db: FieldDB, job: StoredJob): Promise<void> {
  await db.put("jobs", job);
}

export async function getJob(db: FieldDB, jobId: string): Promise<StoredJob | undefined> {
  return db.get("jobs", jobId);
}

export async function deleteJob(db: FieldDB, jobId: string): Promise<void> {
  await db.delete("jobs", jobId);
}

/**
 * ジョブを1件読み、更新関数を適用して書き戻す。
 *
 * 読み込みと書き込みを1つのトランザクションに収めているのが要点。
 * 分けると、送信ランナーと UI 操作（破棄・手動再送）が同時に走ったときに
 * 片方の更新が消える。
 *
 * @returns 更新後のジョブ。ジョブが無い・更新関数が undefined を返した場合は undefined
 */
export async function updateJob(
  db: FieldDB,
  jobId: string,
  update: (job: StoredJob) => StoredJob | undefined,
): Promise<StoredJob | undefined> {
  const tx = db.transaction("jobs", "readwrite");
  const current = await tx.store.get(jobId);
  if (!current) {
    await tx.done;
    return undefined;
  }
  const next = update(current);
  if (next === undefined) {
    await tx.done;
    return undefined;
  }
  await tx.store.put(next);
  await tx.done;
  return next;
}

/**
 * ジョブの更新と、その添付の削除を**1つのトランザクション**で行う。
 *
 * 送信成功時と破棄時に使う。分けて書くと、その隙間で端末が落ちたときに
 * 「ジョブは succeeded なのに画像だけ残る」孤児 Blob ができる。
 * 容量に余裕のない端末では、これが静かに積み上がって効いてくる。
 */
export async function updateJobAndDropBlobs(
  db: FieldDB,
  jobId: string,
  update: (job: StoredJob) => StoredJob | undefined,
): Promise<StoredJob | undefined> {
  const tx = db.transaction(["jobs", "blobs"], "readwrite");
  const jobs = tx.objectStore("jobs");
  const current = await jobs.get(jobId);
  if (!current) {
    await tx.done;
    return undefined;
  }
  const next = update(current);
  if (next === undefined) {
    await tx.done;
    return undefined;
  }
  await jobs.put(next);
  for await (const cursor of tx.objectStore("blobs").index("by-job").iterate(jobId)) {
    await cursor.delete();
  }
  await tx.done;
  return next;
}

export async function listJobs(db: FieldDB, filter?: QueueFilter): Promise<StoredJob[]> {
  let jobs: StoredJob[];

  if (filter?.status && filter.status.length > 0) {
    const index = db.transaction("jobs").store.index("by-status");
    const groups = await Promise.all(filter.status.map((status) => index.getAll(status)));
    jobs = groups.flat();
  } else {
    jobs = await db.getAll("jobs");
  }

  if (filter?.type && filter.type.length > 0) {
    const types = new Set(filter.type);
    jobs = jobs.filter((job) => types.has(job.type));
  }

  jobs.sort(byPriorityThenAge);

  const offset = filter?.offset ?? 0;
  const limit = filter?.limit;
  return limit === undefined ? jobs.slice(offset) : jobs.slice(offset, offset + limit);
}

/**
 * 実行の順番。優先度が高いものが先、同じなら古いものが先。
 * 古い順にしているのは、現場の感覚（先に撮ったものから送られる）に合わせるため。
 */
export function byPriorityThenAge(a: StoredJob, b: StoredJob): number {
  if (a.priority !== b.priority) return b.priority - a.priority;
  return a.createdAt - b.createdAt;
}

/** いま実行してよいジョブ（pending かつ待ち時間を過ぎたもの）を、実行順に返す。 */
export async function listRunnable(
  db: FieldDB,
  options?: { limit?: number; jobIds?: string[]; at?: number; ignoreBackoff?: boolean },
): Promise<StoredJob[]> {
  const at = options?.at ?? now();
  const index = db.transaction("jobs").store.index("by-status");
  let jobs = await index.getAll("pending");

  if (options?.jobIds) {
    const wanted = new Set(options.jobIds);
    jobs = jobs.filter((job) => wanted.has(job.jobId));
  }

  /*
   * バックオフは「自動で殺到させない」ための仕組みであって、
   * 人が電波の良い所まで歩いてきて送信ボタンを押した場面まで止めるものではない。
   * ここで待たせると、押しても何も起きない画面になり、現場では故障と見なされる。
   * だから利用者の明示操作（flush({force:true})）だけは待ち時間を無視する。
   */
  if (!options?.ignoreBackoff) {
    jobs = jobs.filter((job) => job.nextAttemptAt === null || job.nextAttemptAt <= at);
  }
  jobs.sort(byPriorityThenAge);

  return options?.limit === undefined ? jobs : jobs.slice(0, options.limit);
}

export async function countByStatus(db: FieldDB): Promise<Record<QueueJobStatus, number>> {
  const index = db.transaction("jobs").store.index("by-status");
  const entries = await Promise.all(
    ALL_STATUSES.map(async (status) => [status, await index.count(status)] as const),
  );
  return Object.fromEntries(entries) as Record<QueueJobStatus, number>;
}

export async function getCounts(db: FieldDB): Promise<QueueCounts> {
  const byStatus = await countByStatus(db);
  const unsent = UNSENT_STATUSES.reduce((sum, status) => sum + byStatus[status], 0);
  const total = ALL_STATUSES.reduce((sum, status) => sum + byStatus[status], 0);

  return {
    pending: byStatus.pending,
    active: byStatus.active,
    failed: byStatus.failed,
    blocked: byStatus.blocked,
    succeeded: byStatus.succeeded,
    canceled: byStatus.canceled,
    unsent,
    total,
    oldestPendingAt: await oldestUnsentAt(db),
  };
}

/** 最も古い未送信ジョブの作成時刻。「最古 2時間前」の表示に使う。 */
export async function oldestUnsentAt(db: FieldDB): Promise<number | null> {
  let oldest: number | null = null;
  const tx = db.transaction("jobs", "readonly");
  for await (const cursor of tx.store.index("by-created").iterate()) {
    if (isUnsent(cursor.value.status)) {
      oldest = cursor.value.createdAt;
      break; // by-created は昇順なので最初に見つかったものが最古
    }
  }
  await tx.done;
  return oldest;
}

export interface UnsentSummary {
  jobs: number;
  attachments: number;
  bytes: number;
  oldestAt: number | null;
}

/**
 * 未送信の滞留量。滞留上限の判定と UI 表示に使う。
 *
 * `jobs` ストアだけを走査する（Blob は読まない）。ジョブ件数は多くても数百件で、
 * レコードは小さいので、集計値を別に持って整合を崩すより素直に数えるほうが安全。
 */
export async function summarizeUnsent(db: FieldDB): Promise<UnsentSummary> {
  let jobs = 0;
  let attachments = 0;
  let bytes = 0;
  let oldestAt: number | null = null;

  const tx = db.transaction("jobs", "readonly");
  for await (const cursor of tx.store.iterate()) {
    const job = cursor.value;
    if (!isUnsent(job.status)) continue;
    jobs++;
    for (const attachment of job.attachments) {
      // 送信済みの添付は端末から消えているので数えない
      if (attachment.status === "uploaded") continue;
      attachments++;
      bytes += attachment.bytes;
    }
    if (oldestAt === null || job.createdAt < oldestAt) oldestAt = job.createdAt;
  }
  await tx.done;

  return { jobs, attachments, bytes, oldestAt };
}

/** 成功したジョブのうち、指定時刻より前に成功したものの ID。 */
export async function findSucceededBefore(db: FieldDB, before: number): Promise<string[]> {
  const index = db.transaction("jobs").store.index("by-status");
  const succeeded = await index.getAll("succeeded");
  return succeeded
    .filter((job) => (job.succeededAt ?? job.updatedAt) < before)
    .map((job) => job.jobId);
}

/**
 * `active` のまま取り残されたジョブを pending へ戻す。
 *
 * WebView が kill されたり、送信中にアプリが落ちると起きる。
 * 放置すると「送信中」の表示のまま永久に動かないジョブになるので、
 * 起動時と送信の前に回収する。
 *
 * 試行回数は増やさない。端末が落ちたのはサーバのせいでも通信のせいでもないため。
 */
export async function recoverStaleActive(
  db: FieldDB,
  options?: { staleAfterMs?: number; at?: number; instanceId?: string },
): Promise<string[]> {
  const at = options?.at ?? now();
  const staleAfterMs = options?.staleAfterMs ?? 5 * 60_000;
  const recovered: string[] = [];

  const tx = db.transaction("jobs", "readwrite");
  for await (const cursor of tx.store.index("by-status").iterate("active")) {
    const job = cursor.value;
    const mine = options?.instanceId !== undefined && job.activeBy === options.instanceId;
    const stale = (job.activeSince ?? 0) + staleAfterMs <= at;
    // 自分が握っていたものは即回収してよい（自分は今動いていないので）
    if (!mine && !stale) continue;

    const next: StoredJob = { ...job, status: "pending", updatedAt: at };
    delete next.activeSince;
    delete next.activeBy;
    delete next.phase;
    await cursor.update(next);
    recovered.push(job.jobId);
  }
  await tx.done;
  return recovered;
}
