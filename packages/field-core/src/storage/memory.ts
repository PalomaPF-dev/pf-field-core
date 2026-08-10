import { now } from "../shared/clock.js";
import type {
  CreateUploadTargetsRequest,
  StorageAdapter,
  StoredObjectRef,
  UploadContext,
  UploadResult,
  UploadTarget,
} from "./types.js";

/**
 * 通信しないアダプタ。
 *
 * これがある理由は、**送信ランナーの正しさを Supabase 無しで検証するため**。
 * 「圏外→復帰で送られる」「途中で切れたら残りだけ送る」「二重送信しない」は
 * ストレージの実装とは無関係な性質で、そこを実サービス相手に確かめようとすると
 * テストが遅く不安定になり、結局まわらなくなる。
 *
 * 保存したものは取り出せるので、ランナーが「どの添付を何回送ったか」も検査できる。
 */

export interface MemoryStorageOptions {
  bucket?: string;
  /** 記述子の有効期限。既定2時間（Supabase の既定に合わせた） */
  ttlMs?: number;
  /** 添付ごとに失敗させたいときのフック。QueueError を throw する */
  beforeUpload?: (target: UploadTarget, blob: Blob) => void | Promise<void>;
}

export interface MemoryStorage extends StorageAdapter {
  /** 保存されたもの。キーは `${bucket}/${path}` */
  readonly objects: Map<string, { blob: Blob; ref: StoredObjectRef; writes: number }>;
  /** upload が呼ばれた回数（attachmentId ごと）。二重送信の検査に使う */
  readonly uploadCalls: string[];
  /** 署名が要求された回数 */
  readonly signCalls: CreateUploadTargetsRequest[];
  reset(): void;
}

export function createMemoryStorageAdapter(options?: MemoryStorageOptions): MemoryStorage {
  const bucket = options?.bucket ?? "field-uploads";
  const ttlMs = options?.ttlMs ?? 2 * 60 * 60 * 1000;
  const objects = new Map<string, { blob: Blob; ref: StoredObjectRef; writes: number }>();
  const uploadCalls: string[] = [];
  const signCalls: CreateUploadTargetsRequest[] = [];

  return {
    name: "memory",
    objects,
    uploadCalls,
    signCalls,

    reset() {
      objects.clear();
      uploadCalls.length = 0;
      signCalls.length = 0;
    },

    async createUploadTargets(request: CreateUploadTargetsRequest): Promise<UploadTarget[]> {
      signCalls.push(request);
      const at = now();
      return request.files.map((file) => ({
        attachmentId: file.attachmentId,
        // パスはサーバが決める、という本番の性質をここでも守る
        ref: {
          provider: "memory",
          bucket,
          path: `${request.jobType}/${request.jobId}/${file.attachmentId}`,
          contentType: file.contentType,
          bytes: file.bytes,
        },
        request: {
          url: `memory://${bucket}/${request.jobId}/${file.attachmentId}`,
          method: "PUT",
          bodyMode: "binary",
        },
        expiresAt: at + ttlMs,
      }));
    },

    async upload(target: UploadTarget, blob: Blob, ctx: UploadContext): Promise<UploadResult> {
      uploadCalls.push(target.attachmentId);
      await options?.beforeUpload?.(target, blob);

      ctx.onProgress?.(blob.size, blob.size);

      const key = `${target.ref.bucket}/${target.ref.path}`;
      const existing = objects.get(key);
      objects.set(key, {
        blob,
        ref: target.ref,
        writes: (existing?.writes ?? 0) + 1,
      });

      return {
        ref: target.ref,
        bytes: blob.size,
        durationMs: 0,
        ...(existing ? { alreadyExisted: true } : {}),
      };
    },

    async createViewUrls(refs: StoredObjectRef[]) {
      const at = now();
      return refs.map((ref) => ({
        ref,
        url: `memory://${ref.bucket}/${ref.path}`,
        expiresAt: at + 300_000,
      }));
    },

    async remove(refs: StoredObjectRef[]) {
      for (const ref of refs) objects.delete(`${ref.bucket}/${ref.path}`);
    },
  };
}
