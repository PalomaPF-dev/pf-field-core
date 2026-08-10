import type { ResolvedUrl, StoredObjectRef, UploadTarget } from "../storage/types.js";

/**
 * サーバ側の継ぎ目。ストレージを差し替えるときに入れ替わるのはこの実装だけ。
 *
 * ※ 署名の発行は SUPABASE_SECRET_KEY で行うため RLS を迂回する。
 *    したがって認可の実体は Route Handler の authorize() であり、
 *    保存パスは必ずサーバが組み立てる（クライアント指定のパスは使わない）。
 *    詳細は docs/DESIGN.md §2.4.6 と docs/auth-findings.md §4-1。
 */
export interface StorageProvider {
  readonly name: string;
  createUploadTargets(
    request: SignUploadRequest,
    ctx: ServerContext,
  ): Promise<UploadTarget[]>;
  createViewUrls(
    refs: StoredObjectRef[],
    options: { ttlSec: number },
    ctx: ServerContext,
  ): Promise<ResolvedUrl[]>;
  remove?(refs: StoredObjectRef[], ctx: ServerContext): Promise<void>;
}

/** 認証済みの呼び出し元。各アプリの requireSession() 相当が返す。 */
export interface AuthContext {
  userId: string;
  /**
   * 会社のスコープ。**保存パスの第1階層になる**ので、テナント分離の要。
   * 欠けたまま保存すると全社ぶんが同じプレフィックスに落ちるため、
   * 既定のパス生成はここが無ければ例外にする。
   */
  companyId?: string;
  /** `companyId` の旧称。移行期のために読むだけ受け付ける */
  tenantId?: string;
  [key: string]: unknown;
}

export interface ServerContext {
  auth: AuthContext;
  appId: string;
  request: Request;
}

export interface SignUploadFile {
  attachmentId: string;
  fileName: string;
  contentType: string;
  bytes: number;
  role?: string;
}

export interface SignUploadRequest {
  jobId: string;
  jobType: string;
  files: SignUploadFile[];
}

export interface SignUploadResponse {
  targets: UploadTarget[];
}

export interface SignViewRequest {
  refs: StoredObjectRef[];
  ttlSec?: number;
}

export interface SignViewResponse {
  urls: ResolvedUrl[];
}

/** 保存パスを組み立てるときに渡される情報。 */
export interface PathContext {
  appId: string;
  jobId: string;
  jobType: string;
  attachmentId: string;
  fileName: string;
  contentType: string;
  auth: AuthContext;
  /** サーバ時刻。yyyy/mm の分割に使う */
  at: Date;
}

/** 認可に失敗したときに Route Handler が 401 を返すための例外。 */
export class UnauthorizedError extends Error {
  constructor(message = "認証が必要です") {
    super(message);
    this.name = "UnauthorizedError";
  }
}

export const DEFAULT_ALLOWED_CONTENT_TYPES = [
  "image/jpeg",
  "image/webp",
  "image/png",
  "application/pdf",
] as const;

export const DEFAULT_SERVER_LIMITS = {
  maxBytes: 8 * 1024 * 1024,
  maxFilesPerRequest: 20,
  maxRefsPerRequest: 100,
  viewUrlTtlSec: 300,
} as const;
