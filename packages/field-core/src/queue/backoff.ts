export interface BackoffOptions {
  /** 1回目の失敗後の基準待ち時間 */
  baseMs: number;
  /** 失敗のたびに何倍にするか */
  factor: number;
  /** 待ち時間の上限 */
  maxMs: number;
  /**
   * 'full' = random(0, 上限) に散らす。
   * 端末が何十台も同時に圏内へ復帰したとき、jitter が無いと全台が同じ秒に殺到する。
   * 'none' はテストと表示用。
   */
  jitter: "full" | "none";
}

export const DEFAULT_BACKOFF: Readonly<BackoffOptions> = Object.freeze({
  baseMs: 2_000,
  factor: 2,
  maxMs: 300_000, // 5分
  jitter: "full",
});

/**
 * 再試行の上限。
 *
 * 2s から倍々に伸ばすと、上限 5分（maxMs）に届くのは9回目。
 * ここを 8 にすると maxMs に一度も到達せず、設定が死ぬ。
 * 10 回にして「上限まで伸びきってから諦める」形にした（合計およそ18分半）。
 *
 * なお**圏外は試行回数を消費しない**。送信ランナーは到達性を先に確かめ、
 * 届かないときはジョブに触れず pending のまま戻る。
 * つまりこの18分半は「サーバには届くが失敗し続けている」時間であり、
 * 建屋の奥に長時間いたことでジョブが failed に落ちることはない。
 */
export const DEFAULT_MAX_ATTEMPTS = 10;

/**
 * `attempt` 回目の失敗の後に待つミリ秒を返す。
 *
 * @param attempt 直前に失敗した試行の回数（1 始まり）
 * @param random  テストから差し替えるための乱数源
 */
export function backoffDelay(
  attempt: number,
  options?: Partial<BackoffOptions>,
  random: () => number = Math.random,
): number {
  const o = { ...DEFAULT_BACKOFF, ...options };
  if (!(o.baseMs >= 0) || !(o.factor >= 1) || !(o.maxMs >= 0)) {
    throw new RangeError(
      `不正なバックオフ設定です: baseMs=${o.baseMs}, factor=${o.factor}, maxMs=${o.maxMs}`,
    );
  }

  const n = Math.max(1, Math.floor(attempt));
  const raw = o.baseMs * Math.pow(o.factor, n - 1);
  // factor^n は簡単に Infinity になるので、先に上限で丸めてから jitter をかける
  const capped = Math.min(o.maxMs, Number.isFinite(raw) ? raw : o.maxMs);

  if (o.jitter === "none") return Math.round(capped);
  return Math.round(random() * capped);
}

/** 次に実行してよい時刻（epoch ms）。 */
export function nextAttemptAt(
  attempt: number,
  from: number,
  options?: Partial<BackoffOptions>,
  random?: () => number,
): number {
  return from + backoffDelay(attempt, options, random);
}

/**
 * jitter を掛ける前の待ち時間の列。設定の妥当性を目で確かめる用
 * （playground の表示とドキュメント生成に使う）。
 */
export function backoffSchedule(
  maxAttempts: number = DEFAULT_MAX_ATTEMPTS,
  options?: Partial<BackoffOptions>,
): number[] {
  const out: number[] = [];
  for (let i = 1; i <= maxAttempts; i++) {
    out.push(backoffDelay(i, { ...options, jitter: "none" }));
  }
  return out;
}
