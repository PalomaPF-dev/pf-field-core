import { responseError, safeFetch } from "../net/fetch-safe.js";
import { queueErrorFromThrown } from "../queue/errors.js";
import { uploadFailure } from "../storage/transport.js";
import type { QueueJob } from "../queue/types.js";
import type { AdapterContext, StoredObjectRef } from "../storage/types.js";
import { IDEMPOTENCY_HEADER, type SubmitAdapter, type SubmitResult } from "./types.js";

/**
 * レコード本体をアプリの Route Handler へ POST する既定の実装。
 *
 * ここが送信の最後の一歩で、**成功判定を間違えると点検結果が消える**。
 * だから `res.ok` は使わない。`classifyResponse()` で
 * リダイレクト（＝ログイン画面）→ 2xx →ステータス別、の順に明示的に分類する。
 */

/** 送信の上限。アップロードより短くてよい（本体は小さい） */
export const DEFAULT_SUBMIT_TIMEOUT_MS = 30_000;

export interface HttpSubmitAdapterOptions {
  /**
   * ジョブ種別 → 送信先。ジョブの submitUrl が指定されていればそちらが優先される。
   * 関数を渡せばジョブごとに決められる。
   */
  urls: Record<string, string> | ((job: QueueJob) => string);
  timeoutMs?: number;
}

export function resolveSubmitUrl(job: QueueJob, urls: HttpSubmitAdapterOptions["urls"]): string {
  // ジョブに焼き込まれた宛先が最優先。投入時の設定で送り先が決まる
  if (job.submitUrl) return job.submitUrl;
  if (typeof urls === "function") return urls(job);
  const url = urls[job.type];
  if (!url) {
    throw uploadFailure({
      kind: "validation",
      retryable: false,
      message: `送信先が設定されていません（type: ${job.type}）`,
      at: job.updatedAt,
    });
  }
  return url;
}

export function createHttpSubmitAdapter(options: HttpSubmitAdapterOptions): SubmitAdapter {
  const timeoutMs = options.timeoutMs ?? DEFAULT_SUBMIT_TIMEOUT_MS;

  return {
    name: "http-submit",

    async send(
      job: QueueJob,
      refs: StoredObjectRef[],
      ctx: AdapterContext,
    ): Promise<SubmitResult> {
      const url = resolveSubmitUrl(job, options.urls);

      let response: Response;
      try {
        response = await safeFetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            // 弱電界では「送信は届いたが応答が返らなかった」が日常的に起きる。
            // 再送時にサーバ側で同じものと分かるように、クライアント UUID を必ず載せる
            [IDEMPOTENCY_HEADER]: job.jobId,
            ...ctx.headers,
          },
          body: JSON.stringify({
            jobId: job.jobId,
            type: job.type,
            payload: job.payload,
            attachments: refs,
            ...(job.meta ? { meta: job.meta } : {}),
            clientCreatedAt: job.createdAt,
          }),
          timeoutMs,
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        });
      } catch (error) {
        throw uploadFailure(
          queueErrorFromThrown(error, {
            timedOut: error instanceof Error && error.name === "TimeoutError",
          }),
        );
      }

      /*
       * 409 は「同じ jobId を既に受け付けている」= 前回の送信が実は通っていた。
       * 冪等キーを付けている以上これは成功であり、ここで失敗にすると
       * 同じ点検が永遠に未送信のまま残る。
       */
      if (response.status === 409) {
        return { ok: true, duplicated: true };
      }

      const error = responseError(response, { statusText: response.statusText });
      if (error) throw uploadFailure(error);

      // 本文が無い・JSON でなくても、2xx なら受理されている。serverId が取れなくても成功
      let serverId: string | undefined;
      try {
        const body = (await response.json()) as { id?: string; serverId?: string };
        serverId = body.serverId ?? body.id;
      } catch {
        serverId = undefined;
      }

      return { ok: true, ...(serverId ? { serverId } : {}) };
    },
  };
}
