import type { FlushResult, QueueErrorKind, QueueJobStatus } from "./queue/types.js";

/**
 * 監視・計測に流すイベント。
 *
 * 型を付けてあるのは、現場から上がってくる報告と突き合わせるため。
 * 「送れないと言われたが、ログを見ても何が起きたか判らない」を無くしたい。
 * `type` で絞り込めば `data` の中身が確定する。
 *
 * ```ts
 * onEvent: (event) => {
 *   if (event.type === "job.failed") {
 *     // event.data.kind は QueueErrorKind に確定している
 *     metrics.increment(`queue.failed.${event.data.kind}`);
 *   }
 * }
 * ```
 *
 * 実行時の形は 0.5.0 までと同じ（`{ type, at, data? }`）。付けたのは型だけなので、
 * 既に onEvent を繋いでいるアプリはそのまま動く。
 */
interface Event<T extends string, D> {
  type: T;
  /** epoch ms（端末時計）。サーバ時刻との突き合わせには clock-skew を使う */
  at: number;
  data: D;
}

interface EventWithoutData<T extends string> {
  type: T;
  at: number;
  data?: undefined;
}

export type FieldCoreEvent =
  // ---------------------------------------------------------------- ジョブ
  | Event<
      "job.enqueued",
      { jobId: string; type: string; attachments: number; totalBytes: number }
    >
  | Event<"job.retried", { jobId: string }>
  | Event<
      "job.retried-all",
      {
        count: number;
        includeBlocked: boolean;
        /** 利用権エラーとして対象から外した件数。再ログインでは戻らないもの */
        skippedEntitlement: number;
      }
    >
  | Event<"job.canceled", { jobId: string }>
  | Event<"job.removed", { jobId: string }>
  | Event<"job.purged", { count: number }>
  | Event<"job.succeeded", { jobId: string; serverId?: string }>
  | Event<
      "job.failed",
      {
        jobId: string;
        kind: QueueErrorKind;
        retryable: boolean;
        /** 失敗後のジョブの状態。blocked なら人手が要る */
        status: QueueJobStatus | "unknown";
      }
    >
  /** 落ちた WebView が active のまま残したジョブを回収した */
  | Event<"job.recovered", { count: number }>

  // -------------------------------------------------------------- 送信の周期
  | Event<"sync.started", { trigger: string; force: boolean }>
  | Event<"sync.finished", FlushResult & { trigger: string; durationMs: number }>
  /**
   * 他のタブ（または Service Worker）が送信中なので、今回は何もしなかった。
   *
   * 正常な動作であって異常ではない。多タブでの二重送信の調査でここを見る。
   */
  | Event<"sync.locked", { trigger: string }>

  // ------------------------------------------------------------ トークン・時計
  | Event<"token.expired", { jobId: string }>
  | Event<"token.cleared", { count: number }>
  /**
   * 端末時計がずれていて、期限切れかどうかを確信を持って判定できなかった。
   * 判定は「止めない」側に倒している（認証の正否を決めるのはサーバ）。
   */
  | Event<"clock.untrusted", { jobId: string }>

  // ------------------------------------------------------------------ 保存
  /** ブラウザに IndexedDB を消された痕跡を見つけた（検知は best-effort） */
  | Event<"storage.evicted", { lostJobs: number; lastSeenAt: number | null; message: string }>
  /** 永続化が拒否された。iOS では珍しくない。7日使わないと消される可能性がある */
  | EventWithoutData<"storage.not-persisted">;

export type FieldCoreEventType = FieldCoreEvent["type"];

export type FieldCoreEventData<T extends FieldCoreEventType> = Extract<
  FieldCoreEvent,
  { type: T }
>["data"];

export type FieldCoreEventListener = (event: FieldCoreEvent) => void;

/**
 * 種別で絞り込むための型ガード。絞り込んだ先で `data` の中身が確定する。
 *
 * ```ts
 * const failures = events.filter(isFieldCoreEvent("job.failed"));
 * failures[0]?.data.kind; // QueueErrorKind
 * ```
 */
export function isFieldCoreEvent<T extends FieldCoreEventType>(
  type: T,
): (event: FieldCoreEvent) => event is Extract<FieldCoreEvent, { type: T }> {
  return (event): event is Extract<FieldCoreEvent, { type: T }> => event.type === type;
}

/**
 * `onEvent` を呼ぶ。data を持たない種別では第2引数を書けない（書くと型で落ちる）。
 *
 * 例外は握りつぶす。監視フックの都合でキューを止めるわけにはいかない。
 */
export function createEventEmitter(
  onEvent: FieldCoreEventListener | undefined,
  clock: () => number,
): <T extends FieldCoreEventType>(
  type: T,
  ...rest: undefined extends FieldCoreEventData<T> ? [] : [FieldCoreEventData<T>]
) => void {
  return (type, ...rest) => {
    if (!onEvent) return;
    const data = rest[0];
    try {
      onEvent({ type, at: clock(), ...(data !== undefined ? { data } : {}) } as FieldCoreEvent);
    } catch {
      // 監視の失敗で送信を止めない
    }
  };
}
