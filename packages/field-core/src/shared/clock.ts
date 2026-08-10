/**
 * 時刻の取得を1箇所に集約する。
 *
 * ハンディ端末の時計はずれる。バックオフの計算やジョブの nextAttemptAt は
 * 端末時計（相対時間）で足りるが、「いつ撮影したか」「いつ受け付けたか」の記録は
 * サーバ時刻を正とする（サーバは受信時に自分でスタンプする）。
 * ここで扱うのは前者だけ。
 *
 * テストから差し替えられるようにしてあるのは、指数バックオフやリース期限のテストで
 * 実時間を待たないため。
 */
export interface Clock {
  now(): number;
}

const systemClock: Clock = { now: () => Date.now() };

let current: Clock = systemClock;

export function now(): number {
  return current.now();
}

/** テスト専用。戻り値を呼ぶと元に戻る。 */
export function setClock(clock: Clock): () => void {
  const previous = current;
  current = clock;
  return () => {
    current = previous;
  };
}

/** テスト専用。手動で進められる時計。 */
export function createManualClock(startAt = 0): Clock & { advance(ms: number): void; set(ms: number): void } {
  let t = startAt;
  return {
    now: () => t,
    advance: (ms) => {
      t += ms;
    },
    set: (ms) => {
      t = ms;
    },
  };
}
