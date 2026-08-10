import {
  classifyErrorCode,
  classifyHttpStatus,
  extractErrorCode,
  toQueueError,
  type Classification,
  type ResponseContext,
} from "../queue/errors.js";
import type { QueueError } from "../queue/types.js";

/**
 * 送信で使う fetch の共通設定。
 *
 * **`redirect: "manual"` が要点。**
 * セッションが切れた状態で API を叩くと、サーバはログイン画面へ 302 を返すことがある。
 * 既定の `redirect: "follow"` だとブラウザがそれを追いかけ、
 * **ログイン画面の HTML が 200 で返る**。`res.ok` はそこで true になり、
 * 送信に成功したと誤認してジョブを消してしまう。点検結果の消失に直結する。
 *
 * `redirect: "manual"` にすると、同一オリジンのリダイレクトは
 * `type: "opaqueredirect"` / `status: 0` の応答になる。追いかけないので誤認しない。
 */
export const SAFE_FETCH_INIT = {
  redirect: "manual",
  credentials: "same-origin",
} as const satisfies RequestInit;

/** レスポンスのうち、分類に必要な部分だけ（テストしやすくするため） */
export interface ClassifiableResponse {
  status: number;
  type?: string;
  redirected?: boolean;
}

/**
 * レスポンスを分類する。成功なら null。
 *
 * **`res.ok` だけで判断しないこと。** 判定の順序に意味がある:
 *   1. リダイレクト（= ログイン画面）→ 認証切れ。ジョブは消さず blocked(auth) に残す
 *   2. 2xx → 成功
 *   3. それ以外 → ステータスごとの分類（401 は再ログイン、403 は経路しだい、5xx は再試行 …）
 */
export function classifyResponse(
  response: ClassifiableResponse,
  context: ResponseContext = "api",
): Classification | null {
  // redirect: "manual" の下では、リダイレクトはこの形で返る
  if (response.type === "opaqueredirect") {
    return { kind: "auth", retryable: false };
  }
  // redirect: "follow" のまま叩いてしまった場合の保険
  if (response.redirected === true) {
    return { kind: "auth", retryable: false };
  }
  if (response.status >= 300 && response.status < 400) {
    return { kind: "auth", retryable: false };
  }

  if (response.status >= 200 && response.status < 300) return null;

  // status 0 で opaqueredirect でもない場合は通信自体の失敗とみなす
  if (response.status === 0) return { kind: "network", retryable: true };

  return classifyHttpStatus(response.status, context);
}

/**
 * 成功でなければ QueueError を返す（成功なら null）。
 * 呼び出し側はこれを見て、ジョブを消さずに pending / blocked へ振り分ける。
 */
export function responseError(
  response: ClassifiableResponse,
  detail?: { statusText?: string; body?: string; context?: ResponseContext },
): QueueError | null {
  const context = detail?.context ?? "api";

  // 本文に明示のコードがあればそれを正とする（ステータスより具体的なため）
  const byCode = classifyErrorCode(extractErrorCode(detail?.body));
  const classification = byCode ?? classifyResponse(response, context);
  if (classification === null) return null;

  if (classification.kind === "entitlement") {
    return toQueueError(
      classification,
      "この操作の利用権がありません。管理者に連絡してください（再ログインでは解決しません）",
      response.status || undefined,
    );
  }

  if (classification.kind === "auth") {
    const reason =
      response.type === "opaqueredirect" || response.redirected === true
        ? "ログイン画面へリダイレクトされました。ログインし直してください"
        : `認証エラー（HTTP ${response.status}）。ログインし直してください`;
    return toQueueError(classification, reason, response.status || undefined);
  }

  const parts = [detail?.statusText, detail?.body?.slice(0, 200)].filter(Boolean).join(" / ");
  return toQueueError(
    classification,
    parts ? `HTTP ${response.status}: ${parts}` : `HTTP ${response.status}`,
    response.status || undefined,
  );
}

export interface SafeFetchOptions extends Omit<RequestInit, "redirect"> {
  /** これを過ぎたら中断する。弱電界で固まらせないため */
  timeoutMs?: number;
}

/**
 * `redirect: "manual"` を必ず付ける fetch。
 *
 * 送信経路ではこれだけを使う。素の fetch を直接呼ぶと
 * `redirect` の指定を忘れてログイン画面の HTML を成功と誤認しうる。
 */
export async function safeFetch(
  input: string | URL | Request,
  options?: SafeFetchOptions,
): Promise<Response> {
  const { timeoutMs, signal, ...rest } = options ?? {};

  let timeoutSignal: AbortSignal | undefined;
  if (timeoutMs !== undefined && typeof AbortSignal?.timeout === "function") {
    timeoutSignal = AbortSignal.timeout(timeoutMs);
  }

  const signals = [signal, timeoutSignal].filter((s): s is AbortSignal => Boolean(s));
  const combined =
    signals.length === 0
      ? undefined
      : signals.length === 1
        ? signals[0]
        : typeof AbortSignal?.any === "function"
          ? AbortSignal.any(signals)
          : signals[0];

  return fetch(input, {
    ...rest,
    ...SAFE_FETCH_INIT,
    ...(combined ? { signal: combined } : {}),
  });
}
