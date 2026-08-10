import { responseError, safeFetch } from "../net/fetch-safe.js";
import { queueErrorFromThrown } from "../queue/errors.js";
import { DEFAULT_ENDPOINTS } from "../config.js";
import { now } from "../shared/clock.js";
import { uploadFailure, uploadToTarget, type TransportOptions } from "./transport.js";
import type {
  AdapterContext,
  CreateUploadTargetsRequest,
  ResolvedUrl,
  StorageAdapter,
  StoredObjectRef,
  UploadContext,
  UploadResult,
  UploadTarget,
} from "./types.js";

/**
 * 既定の端末側アダプタ。
 *
 * **裏にどのストレージが居るかを知らない。** サーバの `/api/uploads/sign` が返した
 * 記述子（UploadTarget）どおりに転送するだけ。Supabase から S3 へ移っても、
 * 変わるのはサーバ側の StorageProvider だけで、端末のコードは1行も変わらない。
 *
 * 署名をサーバ側で行うのは、鍵を端末に置かないため。
 * サーバ側の署名鍵は RLS を迂回するので、認可の実体は Route Handler の authorize() であり、
 * 保存パスも必ずサーバが組み立てる（docs/DESIGN.md §2.4.6）。
 * ※ 鍵の名前はここに書かない。クライアント側に文字列として残さないため
 *    （test/packaging.test.ts が機械的に検査している）。
 */

/** 署名要求の上限。ここが長いと「送信中」のまま画面が止まって見える */
export const DEFAULT_SIGN_TIMEOUT_MS = 15_000;

export interface HttpSignedAdapterOptions extends TransportOptions {
  /** 署名発行エンドポイント。既定 '/api/uploads/sign' */
  signUrl?: string;
  /** 閲覧用URL発行エンドポイント。既定 '/api/files/sign-view' */
  signViewUrl?: string;
  /** 署名要求のタイムアウト。既定15秒 */
  signTimeoutMs?: number;
}

export function createHttpSignedStorageAdapter(
  options?: HttpSignedAdapterOptions,
): StorageAdapter {
  const signUrl = options?.signUrl ?? DEFAULT_ENDPOINTS.signUpload;
  const signViewUrl = options?.signViewUrl ?? DEFAULT_ENDPOINTS.signView;
  const signTimeoutMs = options?.signTimeoutMs ?? DEFAULT_SIGN_TIMEOUT_MS;

  async function postJson<T>(url: string, body: unknown, ctx: AdapterContext): Promise<T> {
    let response: Response;
    try {
      response = await safeFetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...ctx.headers },
        body: JSON.stringify(body),
        timeoutMs: signTimeoutMs,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });
    } catch (error) {
      throw uploadFailure(queueErrorFromThrown(error, { timedOut: isTimeout(error) }));
    }

    // res.ok では見ない。ログイン画面への 302 を成功と誤認しないため
    const error = responseError(response, { statusText: response.statusText });
    if (error) throw uploadFailure(error);

    try {
      return (await response.json()) as T;
    } catch {
      // 200 なのに JSON でない = 別物が返っている（プロキシのエラーページ等）。
      // 成功と誤認してジョブを消すより、失敗にして手元へ残す
      throw uploadFailure({
        kind: "server",
        retryable: true,
        message: "サーバの応答を解釈できませんでした",
        at: now(),
      });
    }
  }

  return {
    name: "http-signed",

    async createUploadTargets(
      request: CreateUploadTargetsRequest,
      ctx: AdapterContext,
    ): Promise<UploadTarget[]> {
      const body = await postJson<{ targets?: UploadTarget[] }>(signUrl, request, ctx);
      const targets = body.targets ?? [];

      // 要求した添付ぶんの記述子が揃っていないと、送ったつもりで欠落する。
      // ここで気づけば blocked になり、写真は端末に残る
      const missing = request.files
        .map((file) => file.attachmentId)
        .filter((id) => !targets.some((target) => target.attachmentId === id));
      if (missing.length > 0) {
        throw uploadFailure({
          kind: "server",
          retryable: false,
          message: `アップロード先が発行されませんでした（${missing.length}件）`,
          at: now(),
        });
      }

      return targets;
    },

    async upload(target: UploadTarget, blob: Blob, ctx: UploadContext): Promise<UploadResult> {
      const fileName = String(target.ref.path.split("/").pop() ?? "upload.bin");
      return uploadToTarget(target, blob, fileName, ctx, {
        ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      });
    },

    async createViewUrls(
      refs: StoredObjectRef[],
      viewOptions?: { ttlSec?: number },
    ): Promise<ResolvedUrl[]> {
      const body = await postJson<{ urls?: ResolvedUrl[] }>(
        signViewUrl,
        { refs, ...(viewOptions?.ttlSec !== undefined ? { ttlSec: viewOptions.ttlSec } : {}) },
        { headers: {} },
      );
      return body.urls ?? [];
    },
  };
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
}
