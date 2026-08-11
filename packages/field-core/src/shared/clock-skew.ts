import { now } from "./clock.js";

/**
 * 端末時計とサーバ時刻のずれ。
 *
 * **ハンディ端末の時計はずれる。** 数分どころか、電池切れ後の再起動で
 * 数時間〜数日ずれた状態で使われることが現実にある。
 *
 * ここが効いてくるのは送信トークンの有効期限。トークンの `expiresAt` は
 * **サーバ時刻**で発行されるのに、端末はそれを**端末時計**と比べている。
 * 端末が3時間進んでいれば、まだ有効なトークンを「期限切れ」と判断し、
 * M3 の最適化（期限切れなら通信せず止める）と噛み合って
 * **一度も送信を試みないまま blocked(auth) に落ちる**。
 * 写真は端末に残るが、利用者には「認証エラー」としか見えない。
 *
 * 対策は2段構え:
 *   1. サーバ応答の `Date` ヘッダからずれを測り、判定に補正を入れる
 *   2. **測れていないうちは、期限切れを理由に送信を止めない。**
 *      認証の正否を決めるのはサーバであって端末時計ではない。
 */

/** これ以上ずれていたら「時計が信用できない」とみなす。既定5分 */
export const DEFAULT_SKEW_TOLERANCE_MS = 5 * 60_000;

export interface ClockSkew {
  /** サーバ時刻 − 端末時計。正なら端末が遅れている */
  skewMs: number;
  measuredAt: number;
}

let current: ClockSkew | null = null;

/**
 * サーバ応答の `Date` ヘッダからずれを測る。
 * 送信経路のどの応答からでも測れるので、専用の往復は要らない。
 */
export function recordServerDate(dateHeader: string | null | undefined): ClockSkew | null {
  if (!dateHeader) return null;

  const serverMs = Date.parse(dateHeader);
  if (Number.isNaN(serverMs)) return null;

  const at = now();
  /*
   * `Date` ヘッダは秒精度なので、最大1秒ぶんは常にずれて見える。
   * ここで見たいのは分〜時間の単位のずれなので、その粗さは問題にならない。
   */
  current = { skewMs: serverMs - at, measuredAt: at };
  return current;
}

export function getClockSkew(): ClockSkew | null {
  return current;
}

/** テスト用。測定結果を捨てる */
export function resetClockSkew(): void {
  current = null;
}

/** 端末時計をサーバ時刻に寄せた「いま」 */
export function serverNow(): number {
  return now() + (current?.skewMs ?? 0);
}

export type ExpiryVerdict =
  /** 期限内。送ってよい */
  | { expired: false; confident: true }
  /** 期限切れが確か。通信せずに止めてよい */
  | { expired: true; confident: true; skewMs: number }
  /**
   * 期限切れに見えるが、端末時計が信用できない。
   * **止めずに送る** — 認証の正否はサーバが決める。
   */
  | { expired: true; confident: false; reason: "no-measurement" | "large-skew" };

/**
 * 有効期限を判定する。
 *
 * 「期限切れかどうか」だけでなく「その判断を信じてよいか」も返す。
 * 端末時計だけを根拠に送信を止めると、時計がずれた端末で
 * 送れるはずのものが送れなくなる。
 */
export function judgeExpiry(
  expiresAt: number,
  options?: { toleranceMs?: number; skew?: ClockSkew | null },
): ExpiryVerdict {
  const tolerance = options?.toleranceMs ?? DEFAULT_SKEW_TOLERANCE_MS;
  const skew = options?.skew === undefined ? current : options.skew;

  const deviceNow = now();

  // 補正込みで見ても期限内なら、それ以上考えることはない
  const adjustedNow = deviceNow + (skew?.skewMs ?? 0);
  if (adjustedNow < expiresAt) return { expired: false, confident: true };

  // ずれを一度も測れていない = 端末時計しか根拠が無い
  if (!skew) return { expired: true, confident: false, reason: "no-measurement" };

  // 測れてはいるが大きくずれている端末は、そもそも時計が当てにならない
  if (Math.abs(skew.skewMs) > tolerance) {
    return { expired: true, confident: false, reason: "large-skew" };
  }

  return { expired: true, confident: true, skewMs: skew.skewMs };
}

/** 画面に出せる説明。原因が時計だと分かるようにする */
export function describeClockSkew(skew: ClockSkew | null): string | null {
  if (!skew) return null;
  const minutes = Math.round(skew.skewMs / 60_000);
  if (Math.abs(minutes) < 5) return null;

  return minutes > 0
    ? `端末の時計が約${minutes}分遅れています。時刻を合わせてください`
    : `端末の時計が約${Math.abs(minutes)}分進んでいます。時刻を合わせてください`;
}
