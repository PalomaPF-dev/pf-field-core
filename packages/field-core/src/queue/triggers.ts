export type TriggerReason =
  | "enqueue"
  | "online"
  | "visible"
  | "focus"
  | "interval"
  | "manual"
  | "sync"
  /** bfcache から復帰した（iOS でアプリ間を行き来すると起きる） */
  | "restore";

export interface TriggerOptions {
  onTrigger: (reason: TriggerReason) => void;
  /** 定期ポーリングの間隔。既定 60秒 */
  pollIntervalMs?: number;
  /** false を返す間はポーリングを飛ばす（未送信 0 のときに回さないため） */
  shouldPoll?: () => boolean;
}

export interface Triggers {
  start(): void;
  stop(): void;
  readonly running: boolean;
}

/**
 * 送信のきっかけ。
 *
 * 現場の使われ方に対応している:
 *   online         — 圏外から戻った
 *   visibilitychange / focus — ハンディを胸ポケットから出した、アプリに戻った
 *   interval       — 置きっぱなしのまま電波が回復した
 *
 * Service Worker には window も document も無いので、存在するものだけを購読する。
 */
export function createTriggers(options: TriggerOptions): Triggers {
  const pollIntervalMs = options.pollIntervalMs ?? 60_000;
  const cleanups: (() => void)[] = [];
  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;

  function on(
    target: EventTarget | undefined,
    event: string,
    handler: (event?: Event) => void,
  ): void {
    if (!target || typeof target.addEventListener !== "function") return;
    const listener = (e: Event) => handler(e);
    target.addEventListener(event, listener);
    cleanups.push(() => target.removeEventListener(event, listener));
  }

  return {
    get running() {
      return running;
    },

    start() {
      if (running) return;
      running = true;

      const win = typeof window !== "undefined" ? window : undefined;
      const doc = typeof document !== "undefined" ? document : undefined;

      on(win, "online", () => options.onTrigger("online"));
      on(win, "focus", () => options.onTrigger("focus"));
      on(doc, "visibilitychange", () => {
        if (doc?.visibilityState === "visible") options.onTrigger("visible");
      });
      /**
       * bfcache からの復帰。
       *
       * iOS で他アプリへ切り替えて戻ってくると、ページが bfcache から復元され、
       * visibilitychange が期待どおりに来ないことがある。
       * Background Sync が無い iOS では、ここが数少ない送信の機会になるので必ず拾う。
       */
      on(win, "pageshow", (event) => {
        if ((event as PageTransitionEvent | undefined)?.persisted) options.onTrigger("restore");
      });

      if (pollIntervalMs > 0) {
        timer = setInterval(() => {
          if (options.shouldPoll && !options.shouldPoll()) return;
          options.onTrigger("interval");
        }, pollIntervalMs);
        // Node ではタイマーがプロセスを生かし続けるので、テストが終わらなくなるのを防ぐ
        (timer as unknown as { unref?: () => void }).unref?.();
      }
    },

    stop() {
      running = false;
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
      while (cleanups.length > 0) cleanups.pop()?.();
    },
  };
}
