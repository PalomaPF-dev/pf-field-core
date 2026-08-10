import { now } from "../shared/clock.js";
import { isFieldCoreError } from "../shared/errors.js";
import type { QueueError, QueueErrorKind } from "./types.js";

export interface Classification {
  kind: QueueErrorKind;
  retryable: boolean;
}

/**
 * HTTP ステータスから「待てば直るか」を判定する。
 *
 * 判断の軸は一つだけ:「同じリクエストを後でもう一度投げて、成功する見込みがあるか」。
 * 見込みが無いものを再試行に回すと、現場では未送信バッジが減らないまま数十分居座る。
 *
 * ※ 409（既に存在する）は冪等な成功としてランナーが先に処理するので、ここには来ない想定。
 *   万一来たら「同じ内容を投げ直しても変わらない」ので retryable=false とする。
 */
export function classifyHttpStatus(status: number): Classification {
  // 待てば直る見込みがあるもの
  if (status === 408) return { kind: "timeout", retryable: true };
  if (status === 425) return { kind: "server", retryable: true };
  if (status === 429) return { kind: "server", retryable: true };
  if (status >= 500 && status !== 507) return { kind: "server", retryable: true };

  // 人手が要るもの
  if (status === 401 || status === 403) return { kind: "auth", retryable: false };
  if (status === 400 || status === 413 || status === 415 || status === 422) {
    return { kind: "validation", retryable: false };
  }
  if (status === 409) return { kind: "validation", retryable: false };
  if (status === 507) return { kind: "quota", retryable: false };
  // 404 はエンドポイントの設定ミス・デプロイ漏れ。待っても直らないので黙って再試行しない
  if (status === 404) return { kind: "unknown", retryable: false };

  // その他の 4xx はサーバが明示的に拒否している。再試行しても同じ
  if (status >= 400 && status < 500) return { kind: "unknown", retryable: false };

  return { kind: "unknown", retryable: false };
}

/**
 * 例外オブジェクトから分類する。
 *
 * `timedOut` は呼び出し側から渡す。AbortSignal.timeout() による中断と
 * 利用者のキャンセルはどちらも AbortError になり、例外だけでは区別できないため。
 */
export function classifyThrown(error: unknown, options?: { timedOut?: boolean }): Classification {
  if (isFieldCoreError(error)) {
    if (error.code === "quota_exceeded") return { kind: "quota", retryable: false };
    if (error.code === "unsupported_environment") return { kind: "unknown", retryable: false };
    if (error.code === "invalid_argument") return { kind: "validation", retryable: false };
  }

  const name = error instanceof Error ? error.name : "";

  if (name === "AbortError" || name === "TimeoutError") {
    return options?.timedOut
      ? { kind: "timeout", retryable: true }
      : { kind: "aborted", retryable: false };
  }

  // fetch がネットワーク層で失敗すると TypeError になる（圏外・DNS 不達・接続断）
  if (error instanceof TypeError) return { kind: "network", retryable: true };

  // 想定外の例外は「再試行可」に倒す。maxAttempts で頭打ちになり、
  // 打ち切られても failed（手動再送できる）に落ちるだけで、blocked ほど強い宣言にはならない。
  return { kind: "unknown", retryable: true };
}

export function toQueueError(
  classification: Classification,
  message: string,
  httpStatus?: number,
): QueueError {
  const e: QueueError = {
    kind: classification.kind,
    retryable: classification.retryable,
    message,
    at: now(),
  };
  if (httpStatus !== undefined) e.httpStatus = httpStatus;
  return e;
}

/** HTTP レスポンスから QueueError を作る。 */
export function queueErrorFromResponse(status: number, statusText?: string, body?: string): QueueError {
  const c = classifyHttpStatus(status);
  const detail = [statusText, body?.slice(0, 200)].filter(Boolean).join(" / ");
  return toQueueError(c, detail ? `HTTP ${status}: ${detail}` : `HTTP ${status}`, status);
}

/** 例外から QueueError を作る。 */
export function queueErrorFromThrown(error: unknown, options?: { timedOut?: boolean }): QueueError {
  const c = classifyThrown(error, options);
  const message = error instanceof Error ? error.message : String(error);
  return toQueueError(c, message);
}

/** blocked（人手が要る）に落とすべきか。 */
export function isPermanent(error: QueueError): boolean {
  return !error.retryable;
}
