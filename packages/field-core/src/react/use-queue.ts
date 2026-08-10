"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useFieldCoreContext } from "./provider.js";
import type {
  FlushResult,
  QueueCounts,
  QueueError,
  QueueFilter,
  QueueJob,
  QueueJobInput,
  QueueSnapshot,
} from "../queue/types.js";
import type { StorageHealth } from "../db/quota.js";

/**
 * キューの状態を React に繋ぐ。
 *
 * `useSyncExternalStore` を使うのは、キューが React の外で動くため。
 * 送信は Service Worker からも別タブからも進むので、
 * `useState` + `useEffect` で写し取ると「画面の数字だけ古い」が起きる。
 */

const EMPTY_COUNTS: QueueCounts = {
  pending: 0,
  active: 0,
  failed: 0,
  blocked: 0,
  succeeded: 0,
  canceled: 0,
  unsent: 0,
  total: 0,
  oldestPendingAt: null,
};

const INITIAL_SNAPSHOT: QueueSnapshot = {
  counts: EMPTY_COUNTS,
  isSyncing: false,
  lastSyncAt: null,
  lastError: null,
  storage: null,
};

export interface UseOfflineQueueResult {
  counts: QueueCounts;
  jobs: QueueJob[];
  isSyncing: boolean;
  lastSyncAt: number | null;
  lastError: QueueError | null;
  /** 端末ストレージの状態。容量警告の表示に使う */
  storage: StorageHealth | null;
  /** キューがまだ初期化されていない（SSR・初期化中・初期化失敗） */
  ready: boolean;

  enqueue<P>(input: QueueJobInput<P>): Promise<QueueJob<P>>;
  flush(): Promise<FlushResult>;
  retry(jobId: string): Promise<void>;
  retryAll(options?: { includeBlocked?: boolean }): Promise<void>;
  cancel(jobId: string): Promise<void>;
  remove(jobId: string): Promise<void>;
}

export function useOfflineQueue(filter?: QueueFilter): UseOfflineQueueResult {
  const { core } = useFieldCoreContext();
  const queue = core?.queue;

  /*
   * スナップショットは同じ参照を返し続けなければならない。
   * 毎回新しいオブジェクトを作ると useSyncExternalStore が無限に再描画する。
   */
  const cached = useRef<QueueSnapshot>(INITIAL_SNAPSHOT);

  const subscribe = useCallback(
    (onChange: () => void) => {
      if (!queue) return () => {};
      return queue.subscribe((next) => {
        cached.current = next;
        onChange();
      });
    },
    [queue],
  );

  const getSnapshot = useCallback(() => cached.current, []);
  // サーバでは購読できないので、空の状態を返す（ハイドレーション不一致を避ける）
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, () => INITIAL_SNAPSHOT);

  // 一覧はスナップショットに含まれない（重いため）。変化のたびに読み直す
  const [jobs, setJobs] = useState<QueueJob[]>([]);
  const filterKey = JSON.stringify(filter ?? {});

  useEffect(() => {
    if (!queue) {
      setJobs([]);
      return;
    }
    let alive = true;

    const load = () => {
      void queue
        .list(filter)
        .then((next) => {
          if (alive) setJobs(next);
        })
        .catch(() => {
          if (alive) setJobs([]);
        });
    };

    load();
    const off = queue.subscribe(load);
    return () => {
      alive = false;
      off();
    };
    // filter はオブジェクトリテラルで渡されることが多いので中身で比較する
  }, [queue, filterKey, filter]);

  const notReady = useCallback(() => {
    throw new Error("キューがまだ初期化されていません");
  }, []);

  return useMemo(
    () => ({
      counts: snapshot.counts,
      jobs,
      isSyncing: snapshot.isSyncing,
      lastSyncAt: snapshot.lastSyncAt,
      lastError: snapshot.lastError,
      storage: snapshot.storage,
      ready: Boolean(queue),

      enqueue: <P,>(input: QueueJobInput<P>) =>
        queue ? queue.enqueue(input) : (notReady() as never),
      flush: () => (queue ? queue.flush({ force: true }) : (notReady() as never)),
      retry: (jobId: string) => (queue ? queue.retry(jobId) : (notReady() as never)),
      retryAll: (options?: { includeBlocked?: boolean }) =>
        queue ? queue.retryAll(options) : (notReady() as never),
      cancel: (jobId: string) => (queue ? queue.cancel(jobId) : (notReady() as never)),
      remove: (jobId: string) => (queue ? queue.remove(jobId) : (notReady() as never)),
    }),
    [snapshot, jobs, queue, notReady],
  );
}

export interface UseQueueJobResult {
  job: QueueJob | undefined;
  retry(): Promise<void>;
  cancel(): Promise<void>;
}

/** 1件のジョブを追う。詳細画面や送信中の進捗表示に使う */
export function useQueueJob(jobId: string | undefined): UseQueueJobResult {
  const { core } = useFieldCoreContext();
  const queue = core?.queue;
  const [job, setJob] = useState<QueueJob | undefined>(undefined);

  useEffect(() => {
    if (!queue || !jobId) {
      setJob(undefined);
      return;
    }
    let alive = true;

    const load = () => {
      void queue.get(jobId).then((next) => {
        if (alive) setJob(next);
      });
    };

    load();
    const off = queue.subscribe(load);
    return () => {
      alive = false;
      off();
    };
  }, [queue, jobId]);

  return {
    job,
    retry: async () => {
      if (queue && jobId) await queue.retry(jobId);
    },
    cancel: async () => {
      if (queue && jobId) await queue.cancel(jobId);
    },
  };
}
