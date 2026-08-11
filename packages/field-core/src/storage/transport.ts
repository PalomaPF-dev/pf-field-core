import { queueErrorFromResponse, queueErrorFromThrown } from "../queue/errors.js";
import { responseError, safeFetch } from "../net/fetch-safe.js";
import type { QueueError } from "../queue/types.js";
import { now } from "../shared/clock.js";
import type { UploadContext, UploadRequestSpec, UploadResult, UploadTarget } from "./types.js";

/**
 * 記述子（UploadTarget）どおりに1ファイルを転送する既定の実装。
 *
 * 経路が2つあるのは、進捗表示のため。
 * ブラウザの `fetch` はリクエストボディの送信進捗を取れない（レスポンスの受信進捗は取れる）。
 * 弱電界で1枚数百KBを送るとき「何%まで行ったか」が出ないと、
 * 現場では「固まった」と判断してアプリを落とされる。だから既定は XHR を使う。
 *
 * Service Worker の中には XMLHttpRequest が無いので、そこでは fetch に落ちる。
 * 進捗は出ないが、SW 側での送信はそもそも画面に出ないので影響しない。
 */

/** 1ファイルあたりの上限。弱電界での実測（M3）で調整する暫定値 */
export const DEFAULT_UPLOAD_TIMEOUT_MS = 60_000;

export interface TransportOptions {
  timeoutMs?: number;
}

export function canReportProgress(): boolean {
  return typeof XMLHttpRequest !== "undefined";
}

/** 記述子から実際に送る body を組み立てる */
function buildBody(spec: UploadRequestSpec, blob: Blob, fileName: string): XMLHttpRequestBodyInit {
  if (spec.bodyMode === "binary") return blob;

  const form = new FormData();
  for (const [key, value] of Object.entries(spec.formFields ?? {})) {
    form.append(key, value);
  }
  // S3 の POST policy はフィールドの順序に意味があり、file は必ず最後
  form.append(spec.fileFieldName ?? "file", blob, fileName);
  return form;
}

/**
 * XHR は `redirect: "manual"` に相当する指定ができず、リダイレクトを黙って追う。
 * 追った先がログイン画面だと 200 が返り、成功と誤認しうる。
 * 追跡が起きたかどうかは `responseURL` でしか分からないので、ここで突き合わせる。
 */
function detectRedirect(requestUrl: string, responseUrl: string | undefined): boolean {
  if (!responseUrl) return false;

  // `location` は Worker では WorkerLocation、Node では未定義。
  // 素の `location` を書くと未定義環境で ReferenceError になり、
  // 下の catch がそれを飲み込んで「追跡されていない」と誤判定する
  const base = globalThis.location?.href;

  try {
    const from = new URL(requestUrl, base);
    const to = new URL(responseUrl, base);
    // クエリの差（署名の正規化など）は追跡ではない。オリジンとパスだけを見る
    return from.origin !== to.origin || from.pathname !== to.pathname;
  } catch {
    // 解釈できないときは素朴に文字列で比べる。
    // 「判らないから追跡されていない」に倒すと、ログイン画面を成功と誤認しうる
    return !responseUrl.startsWith(requestUrl);
  }
}

function authError(message: string): QueueError {
  return { kind: "auth", retryable: false, message, at: now() };
}

/** 転送に失敗したときは QueueError を throw する。呼び出し側はそのまま分類済みで扱える */
export class UploadFailure extends Error {
  readonly queueError: QueueError;
  constructor(queueError: QueueError) {
    super(queueError.message);
    this.name = "UploadFailure";
    this.queueError = queueError;
  }
}

export function uploadFailure(queueError: QueueError): UploadFailure {
  return new UploadFailure(queueError);
}

async function uploadWithXhr(
  target: UploadTarget,
  blob: Blob,
  fileName: string,
  ctx: UploadContext,
  timeoutMs: number,
): Promise<{ status: number; responseText: string; responseUrl: string }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(target.request.method, target.request.url, true);
    xhr.timeout = timeoutMs;

    for (const [key, value] of Object.entries(target.request.headers ?? {})) {
      xhr.setRequestHeader(key, value);
    }
    for (const [key, value] of Object.entries(ctx.headers)) {
      xhr.setRequestHeader(key, value);
    }

    if (ctx.onProgress) {
      xhr.upload.addEventListener("progress", (event) => {
        if (event.lengthComputable) ctx.onProgress?.(event.loaded, event.total);
      });
    }

    const onAbort = () => xhr.abort();
    ctx.signal?.addEventListener("abort", onAbort, { once: true });

    const cleanup = () => ctx.signal?.removeEventListener("abort", onAbort);

    xhr.addEventListener("load", () => {
      cleanup();
      resolve({ status: xhr.status, responseText: xhr.responseText, responseUrl: xhr.responseURL });
    });
    xhr.addEventListener("error", () => {
      cleanup();
      // XHR は失敗の理由を教えてくれない。圏外・DNS 不達・CORS のいずれか。
      // どれも「待てば直るかもしれない」に倒す
      reject(new TypeError("アップロードに失敗しました（通信エラー）"));
    });
    xhr.addEventListener("timeout", () => {
      cleanup();
      const error = new Error("アップロードがタイムアウトしました");
      error.name = "TimeoutError";
      reject(error);
    });
    xhr.addEventListener("abort", () => {
      cleanup();
      const error = new Error("アップロードを中止しました");
      error.name = "AbortError";
      reject(error);
    });

    xhr.send(buildBody(target.request, blob, fileName));
  });
}

/**
 * 記述子どおりに1ファイル送る。
 *
 * 成功なら UploadResult、失敗なら UploadFailure（分類済み QueueError 入り）を throw する。
 */
export async function uploadToTarget(
  target: UploadTarget,
  blob: Blob,
  fileName: string,
  ctx: UploadContext,
  options?: TransportOptions,
): Promise<UploadResult> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_UPLOAD_TIMEOUT_MS;
  const startedAt = now();

  // 期限切れの記述子は投げるだけ無駄。再発行させる
  if (target.expiresAt <= startedAt) {
    throw uploadFailure({
      kind: "expired",
      // 再発行すれば通るので、待てば直る側に置く
      retryable: true,
      message: "アップロードURLの有効期限が切れています",
      at: startedAt,
    });
  }

  try {
    if (canReportProgress()) {
      const { status, responseText, responseUrl } = await uploadWithXhr(
        target,
        blob,
        fileName,
        ctx,
        timeoutMs,
      );

      if (detectRedirect(target.request.url, responseUrl)) {
        throw uploadFailure(
          authError("アップロード先がログイン画面へリダイレクトされました。ログインし直してください"),
        );
      }

      // 既に同じパスに在る = 前回の再試行が実は成功していた。冪等な成功として扱う
      if (status === 409) {
        return {
          ref: target.ref,
          bytes: blob.size,
          durationMs: now() - startedAt,
          alreadyExisted: true,
        };
      }

      if (status < 200 || status >= 300) {
        // 署名付きURLへの直送。403 は署名の失効がほとんどなので upload 文脈で分類する
        throw uploadFailure(queueErrorFromResponse(status, undefined, responseText, "upload"));
      }
    } else {
      const response = await safeFetch(target.request.url, {
        method: target.request.method,
        headers: { ...target.request.headers, ...ctx.headers },
        body: buildBody(target.request, blob, fileName) as BodyInit,
        timeoutMs,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });

      if (response.status === 409) {
        return {
          ref: target.ref,
          bytes: blob.size,
          durationMs: now() - startedAt,
          alreadyExisted: true,
        };
      }

      const error = responseError(response, {
        statusText: response.statusText,
        context: "upload",
      });
      if (error) throw uploadFailure(error);
    }

    ctx.onProgress?.(blob.size, blob.size);

    return { ref: target.ref, bytes: blob.size, durationMs: now() - startedAt };
  } catch (error) {
    if (error instanceof UploadFailure) throw error;
    throw uploadFailure(queueErrorFromThrown(error, { timedOut: isTimeout(error) }));
  }
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && error.name === "TimeoutError";
}
