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
 * S3 互換ストレージの StorageProvider（3-f）。
 *
 * **これが在る理由は「差し替えられる」を口約束にしないこと。**
 * 抽象が効いているかどうかは、2つ目の実装を入れて初めて分かる。
 * 端末側（`createHttpSignedStorageAdapter` / 送信ランナー）を1行も変えずに
 * このプロバイダで E2E が通れば、抽象は本物だと言える。
 *
 * 署名は SigV4 のクエリ署名（presigned URL）を自前で作る。
 * AWS SDK を持ち込まないのは、この用途に必要なのが
 * 「PUT と GET の presign」だけで、SDK を足すと配布物が一気に重くなるため。
 * ハッシュと HMAC は Web Crypto を使うので Node でも Edge でも動く。
 */

export interface S3StorageOptions {
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** MinIO 等の互換ストレージ用。既定は AWS S3 */
  endpoint?: string;
  /** パス形式のURL（MinIO は基本これ）。既定 false = 仮想ホスト形式 */
  forcePathStyle?: boolean;
  buildPath?: (ctx: PathContext) => string;
  uploadUrlTtlSec?: number;
  viewUrlTtlSec?: number;
  /** テスト用。署名の再現性を確かめるために時刻を固定する */
  now?: () => Date;
}

export const S3_PROVIDER = "s3";

const ALGORITHM = "AWS4-HMAC-SHA256";
const UNSIGNED_PAYLOAD = "UNSIGNED-PAYLOAD";

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return toHex(digest);
}

async function hmac(key: ArrayBuffer | Uint8Array, value: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(value));
}

/** S3 は `/` を残したままパスをエンコードする。各セグメントだけを厳密に符号化する */
function encodeS3Path(path: string): string {
  return path
    .split("/")
    .map((segment) =>
      encodeURIComponent(segment).replace(
        /[!'()*]/g,
        (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
      ),
    )
    .join("/");
}

function amzDate(at: Date): { full: string; short: string } {
  const full = at.toISOString().replace(/[:-]|\.\d{3}/g, "");
  return { full, short: full.slice(0, 8) };
}

/**
 * SigV4 のクエリ署名を作る。
 *
 * 署名対象のヘッダは `host` だけにしてある。端末側が余計なヘッダを足しても
 * 署名が壊れないようにするため（`Content-Type` を signed headers に含めると、
 * 送信時の値が1文字でも違えば 403 になる）。
 */
async function presign(
  options: {
    method: "PUT" | "GET";
    host: string;
    canonicalUri: string;
    region: string;
    accessKeyId: string;
    secretAccessKey: string;
    expiresSec: number;
    at: Date;
  },
): Promise<string> {
  const { full, short } = amzDate(options.at);
  const scope = `${short}/${options.region}/s3/aws4_request`;

  const query = new URLSearchParams({
    "X-Amz-Algorithm": ALGORITHM,
    "X-Amz-Credential": `${options.accessKeyId}/${scope}`,
    "X-Amz-Date": full,
    "X-Amz-Expires": String(options.expiresSec),
    "X-Amz-SignedHeaders": "host",
  });

  // クエリはコードポイント順に並べる必要がある
  const canonicalQuery = [...query.entries()]
    .map(([k, v]) => [encodeURIComponent(k), encodeURIComponent(v)] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");

  const canonicalRequest = [
    options.method,
    options.canonicalUri,
    canonicalQuery,
    `host:${options.host}\n`,
    "host",
    UNSIGNED_PAYLOAD,
  ].join("\n");

  const stringToSign = [ALGORITHM, full, scope, await sha256Hex(canonicalRequest)].join("\n");

  const kDate = await hmac(new TextEncoder().encode(`AWS4${options.secretAccessKey}`), short);
  const kRegion = await hmac(kDate, options.region);
  const kService = await hmac(kRegion, "s3");
  const kSigning = await hmac(kService, "aws4_request");
  const signature = toHex(await hmac(kSigning, stringToSign));

  return `${canonicalQuery}&X-Amz-Signature=${signature}`;
}

export function createS3StorageProvider(options: S3StorageOptions): StorageProvider {
  const buildPath = options.buildPath ?? defaultObjectPath;
  const uploadTtl = options.uploadUrlTtlSec ?? 2 * 60 * 60;
  const viewTtl = options.viewUrlTtlSec ?? DEFAULT_SERVER_LIMITS.viewUrlTtlSec;
  const clock = options.now ?? (() => new Date());

  const endpoint = options.endpoint?.replace(/\/+$/, "");
  const host = endpoint
    ? new URL(endpoint).host
    : options.forcePathStyle
      ? `s3.${options.region}.amazonaws.com`
      : `${options.bucket}.s3.${options.region}.amazonaws.com`;
  const scheme = endpoint ? new URL(endpoint).protocol : "https:";
  const pathStyle = options.forcePathStyle ?? Boolean(endpoint);

  async function sign(method: "PUT" | "GET", path: string, expiresSec: number): Promise<string> {
    const canonicalUri = pathStyle
      ? `/${options.bucket}/${encodeS3Path(path)}`
      : `/${encodeS3Path(path)}`;

    const query = await presign({
      method,
      host,
      canonicalUri,
      region: options.region,
      accessKeyId: options.accessKeyId,
      secretAccessKey: options.secretAccessKey,
      expiresSec,
      at: clock(),
    });

    return `${scheme}//${host}${canonicalUri}?${query}`;
  }

  return {
    name: S3_PROVIDER,

    async createUploadTargets(
      request: SignUploadRequest,
      ctx: ServerContext,
    ): Promise<UploadTarget[]> {
      const at = clock();

      return Promise.all(
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

          return {
            attachmentId: file.attachmentId,
            ref: {
              provider: S3_PROVIDER,
              bucket: options.bucket,
              path,
              contentType: file.contentType,
              bytes: file.bytes,
            },
            request: {
              url: await sign("PUT", path, uploadTtl),
              method: "PUT" as const,
              // 署名対象は host のみ。Content-Type は送ってよいが署名には含めない
              headers: { "Content-Type": file.contentType },
              bodyMode: "binary" as const,
            },
            expiresAt: at.getTime() + uploadTtl * 1000,
          };
        }),
      );
    },

    async createViewUrls(
      refs: StoredObjectRef[],
      viewOptions: { ttlSec: number },
    ): Promise<ResolvedUrl[]> {
      const ttlSec = viewOptions.ttlSec || viewTtl;
      const at = clock().getTime();

      return Promise.all(
        refs.map(async (ref) => ({
          ref,
          url: await sign("GET", ref.path, ttlSec),
          expiresAt: at + ttlSec * 1000,
        })),
      );
    },
  };
}
