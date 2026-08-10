import type { ResolvedUrl, StoredObjectRef, UploadTarget } from "../storage/types.js";
import { defaultObjectPath } from "./path.js";
import {
  DEFAULT_SERVER_LIMITS,
  type PathContext,
  type ServerContext,
  type SignUploadRequest,
  type StorageProvider,
} from "./types.js";

/**
 * Supabase Storage の StorageProvider。
 *
 * **サーバ専用。** 署名鍵（`sb_secret_` 形式）は RLS を迂回するので、
 * 認可の実体はこの手前の `authorize()` であり、保存パスは必ずここで組み立てる。
 * クライアントから来たファイル名・パスは一切使わない。
 *
 * 端末側は `createHttpSignedStorageAdapter` が返した記述子どおりに転送するだけなので、
 * ここを S3 に差し替えても端末のコードは1行も変わらない（それを確かめるのが s3.ts）。
 *
 * ## 署名付きアップロードの流れ（Supabase Storage REST）
 *
 * 1. `POST /storage/v1/object/upload/sign/{bucket}/{path}` → `{ url: "/object/upload/sign/..." }`
 * 2. 端末が `PUT {SUPABASE_URL}/storage/v1{url}` で本体を送る
 *
 * 既定の有効期限は2時間。**送信直前に発行する**ので、この長さは実質問題にならない。
 */

export interface SupabaseStorageOptions {
  /** `SUPABASE_URL`。例: https://xxxx.supabase.co */
  url: string;
  /**
   * `SUPABASE_SECRET_KEY`（`sb_secret_` 形式。旧 service_role key に相当）。
   * **RLS を迂回する**ので、サーバ以外へ渡さないこと。
   */
  secretKey: string;
  /** `SUPABASE_BUCKET`。既定 'field-uploads' */
  bucket?: string;
  /** 保存パスの組み立て。既定は `<companyId>/<appId>/<YYYY>/<MM>/<jobId>/<attachmentId>` */
  buildPath?: (ctx: PathContext) => string;
  /** 閲覧用URLの既定TTL（秒）。既定 300 */
  viewUrlTtlSec?: number;
  /** テストから差し替えるための fetch */
  fetchImpl?: typeof fetch;
}

export const SUPABASE_PROVIDER = "supabase";

/**
 * アップロード時の body の送り方。
 *
 * supabase-js は Blob を渡されると FormData に包むが、
 * `content-type` を添えた生バイナリの PUT も受け付ける。
 * こちらは端末側の記述子をそのまま使えて余計な多重化が無いので `binary` を既定にした。
 *
 * **実エンドポイントでの確認は 3-b（scripts/verify-supabase.mjs）で行う。**
 * 万一 `binary` が通らなければ、ここを 'form-data' にするだけで端末側は変わらない。
 */
const UPLOAD_BODY_MODE = "binary" as const;

interface SignedUploadResponse {
  url?: string;
  token?: string;
  error?: string;
  message?: string;
}

interface SignedViewResponse {
  path?: string;
  signedURL?: string;
  signedUrl?: string;
  error?: string | null;
}

export function createSupabaseStorageProvider(
  options: SupabaseStorageOptions,
): StorageProvider {
  const base = options.url.replace(/\/+$/, "");
  const bucket = options.bucket ?? "field-uploads";
  const buildPath = options.buildPath ?? defaultObjectPath;
  const viewTtl = options.viewUrlTtlSec ?? DEFAULT_SERVER_LIMITS.viewUrlTtlSec;
  const doFetch = options.fetchImpl ?? fetch;

  if (!options.secretKey) {
    throw new Error("SUPABASE_SECRET_KEY が設定されていません");
  }

  function authHeaders(): Record<string, string> {
    return {
      // 新方式の Secret key は Authorization と apikey の両方に載せる。
      // 片方だけだと構成によって 401 になる
      Authorization: `Bearer ${options.secretKey}`,
      apikey: options.secretKey,
    };
  }

  /** パスは `/` 区切りを保ったまま、各セグメントだけをエンコードする */
  function encodePath(path: string): string {
    return path.split("/").map(encodeURIComponent).join("/");
  }

  async function post<T>(path: string, body: unknown): Promise<T> {
    const response = await doFetch(`${base}/storage/v1${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(
        `Supabase Storage の呼び出しに失敗しました (HTTP ${response.status}) ${detail.slice(0, 300)}`,
      );
    }
    return (await response.json()) as T;
  }

  return {
    name: SUPABASE_PROVIDER,

    async createUploadTargets(
      request: SignUploadRequest,
      ctx: ServerContext,
    ): Promise<UploadTarget[]> {
      const at = new Date();

      const targets = await Promise.all(
        request.files.map(async (file) => {
          const path = buildPath({
            appId: ctx.appId,
            jobId: request.jobId,
            jobType: request.jobType,
            attachmentId: file.attachmentId,
            fileName: file.fileName,
            contentType: file.contentType,
            auth: ctx.auth,
            at,
          });

          const signed = await post<SignedUploadResponse>(
            `/object/upload/sign/${bucket}/${encodePath(path)}`,
            {},
          );

          if (!signed.url) {
            throw new Error(
              `署名付きアップロードURLを取得できませんでした: ${signed.error ?? signed.message ?? "不明"}`,
            );
          }

          const ref: StoredObjectRef = {
            provider: SUPABASE_PROVIDER,
            bucket,
            path,
            contentType: file.contentType,
            bytes: file.bytes,
          };

          return {
            attachmentId: file.attachmentId,
            ref,
            request: {
              url: `${base}/storage/v1${signed.url}`,
              method: "PUT" as const,
              headers: {
                "Content-Type": file.contentType,
                // 同じパスへの再送は上書きを許す。
                // 「前回の再試行が実は成功していた」ときに 409 で止めない
                "x-upsert": "true",
              },
              bodyMode: UPLOAD_BODY_MODE,
            },
            // Supabase の署名は既定で2時間。送信直前に発行するので実質問題にならない
            expiresAt: at.getTime() + 2 * 60 * 60 * 1000,
          };
        }),
      );

      return targets;
    },

    async createViewUrls(
      refs: StoredObjectRef[],
      viewOptions: { ttlSec: number },
    ): Promise<ResolvedUrl[]> {
      if (refs.length === 0) return [];

      const ttlSec = viewOptions.ttlSec || viewTtl;
      const at = Date.now();

      // バケットが混在しうるので、バケットごとにまとめて発行する
      const byBucket = new Map<string, StoredObjectRef[]>();
      for (const ref of refs) {
        const list = byBucket.get(ref.bucket) ?? [];
        list.push(ref);
        byBucket.set(ref.bucket, list);
      }

      const resolved: ResolvedUrl[] = [];

      for (const [bucketName, group] of byBucket) {
        const results = await post<SignedViewResponse[]>(`/object/sign/${bucketName}`, {
          expiresIn: ttlSec,
          paths: group.map((ref) => ref.path),
        });

        const byPath = new Map(
          results.map((entry) => [entry.path ?? "", entry.signedURL ?? entry.signedUrl ?? ""]),
        );

        for (const ref of group) {
          const signed = byPath.get(ref.path);
          if (!signed) {
            // 1件の失敗で一覧全体を落とさない。出せるものは出す
            continue;
          }
          resolved.push({
            ref,
            url: `${base}/storage/v1${signed}`,
            expiresAt: at + ttlSec * 1000,
          });
        }
      }

      return resolved;
    },

    async remove(refs: StoredObjectRef[]): Promise<void> {
      const byBucket = new Map<string, string[]>();
      for (const ref of refs) {
        const list = byBucket.get(ref.bucket) ?? [];
        list.push(ref.path);
        byBucket.set(ref.bucket, list);
      }

      for (const [bucketName, prefixes] of byBucket) {
        const response = await doFetch(`${base}/storage/v1/object/${bucketName}`, {
          method: "DELETE",
          headers: { "Content-Type": "application/json", ...authHeaders() },
          body: JSON.stringify({ prefixes }),
        });
        if (!response.ok) {
          const detail = await response.text().catch(() => "");
          throw new Error(`削除に失敗しました (HTTP ${response.status}) ${detail.slice(0, 200)}`);
        }
      }
    },
  };
}

/**
 * 環境変数から組み立てる。
 *
 * 正は `SUPABASE_SECRET_KEY`。`SUPABASE_SERVICE_ROLE_KEY` は移行期の別名として
 * 読むだけ受け付ける（docs/integration-nextjs.md 参照）。
 */
export function supabaseStorageFromEnv(
  env: Record<string, string | undefined> = process.env,
): StorageProvider {
  const url = env.SUPABASE_URL;
  const secretKey = env.SUPABASE_SECRET_KEY ?? env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url) throw new Error("SUPABASE_URL が設定されていません");
  if (!secretKey) throw new Error("SUPABASE_SECRET_KEY が設定されていません");

  return createSupabaseStorageProvider({
    url,
    secretKey,
    ...(env.SUPABASE_BUCKET ? { bucket: env.SUPABASE_BUCKET } : {}),
  });
}
