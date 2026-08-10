import type { StoredObjectRef } from "../storage/types.js";
import { companyIdOfPath } from "./path.js";
import {
  DEFAULT_ALLOWED_CONTENT_TYPES,
  DEFAULT_SERVER_LIMITS,
  UnauthorizedError,
  type AuthContext,
  type ServerContext,
  type SignUploadRequest,
  type StorageProvider,
} from "./types.js";

/**
 * 2つの Route Handler。
 *
 * ## ここが認可の実体
 *
 * 署名鍵（`sb_secret_`）は **RLS を迂回する**。つまり Supabase 側のポリシーは
 * この経路の防御にならない。「誰が」「どこへ」書けるかを決めているのは
 * `authorize()` と、サーバ側でのパス生成だけ。
 * したがってここを緩めると、RLS がどうであろうと他社のデータへ届く。
 *
 * 具体的に守っていること:
 *   - 認証されていない要求は 401（`UnauthorizedError`）
 *   - 保存パスはサーバが組み立てる。クライアントのファイル名・パスは使わない
 *   - 閲覧は**自社のプレフィックス配下だけ**に限る
 *   - MIME 型・サイズ・件数を入口で弾く
 */

export interface SignUploadRouteOptions {
  provider: StorageProvider;
  /** このアプリの識別子。保存パスの第2階層になる */
  appId: string;
  /**
   * 認証。各アプリの `requireSession()` 相当。
   * 認証されていなければ `UnauthorizedError` を投げるか undefined を返す。
   */
  authorize: (request: Request) => Promise<AuthContext | undefined>;
  allowedContentTypes?: readonly string[];
  maxBytes?: number;
  maxFilesPerRequest?: number;
}

export interface SignViewRouteOptions {
  provider: StorageProvider;
  appId: string;
  authorize: (request: Request) => Promise<AuthContext | undefined>;
  maxRefsPerRequest?: number;
  defaultTtlSec?: number;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      // 署名付きURLは短命かつ利用者ごとに違う。経路上のどこにも残さない
      "Cache-Control": "private, no-store",
    },
  });
}

async function resolveAuth(
  options: { authorize: (request: Request) => Promise<AuthContext | undefined> },
  request: Request,
): Promise<AuthContext | Response> {
  try {
    const auth = await options.authorize(request);
    if (!auth) return json({ error: "unauthorized" }, 401);
    return auth;
  } catch (error) {
    if (error instanceof UnauthorizedError) return json({ error: "unauthorized" }, 401);
    throw error;
  }
}

/** `POST /api/uploads/sign` */
export function createSignUploadRoute(
  options: SignUploadRouteOptions,
): (request: Request) => Promise<Response> {
  const allowed = options.allowedContentTypes ?? DEFAULT_ALLOWED_CONTENT_TYPES;
  const maxBytes = options.maxBytes ?? DEFAULT_SERVER_LIMITS.maxBytes;
  const maxFiles = options.maxFilesPerRequest ?? DEFAULT_SERVER_LIMITS.maxFilesPerRequest;

  return async function signUpload(request: Request): Promise<Response> {
    const auth = await resolveAuth(options, request);
    if (auth instanceof Response) return auth;

    let body: SignUploadRequest;
    try {
      body = (await request.json()) as SignUploadRequest;
    } catch {
      return json({ error: "invalid_json" }, 400);
    }

    if (!body?.jobId || !body.jobType || !Array.isArray(body.files)) {
      return json({ error: "invalid_request" }, 400);
    }
    if (body.files.length === 0) return json({ targets: [] });
    if (body.files.length > maxFiles) {
      return json({ error: "too_many_files", max: maxFiles }, 413);
    }

    for (const file of body.files) {
      if (!file.attachmentId || !file.contentType) {
        return json({ error: "invalid_file" }, 400);
      }
      if (!allowed.includes(file.contentType)) {
        // バケット側でも MIME を絞っているが、断るのは早いほうがよい。
        // 端末は blocked(validation) にして、無駄な再試行をやめられる
        return json({ error: "unsupported_content_type", contentType: file.contentType }, 415);
      }
      if (typeof file.bytes !== "number" || file.bytes <= 0 || file.bytes > maxBytes) {
        return json({ error: "file_too_large", max: maxBytes }, 413);
      }
    }

    const ctx: ServerContext = { auth, appId: options.appId, request };

    try {
      const targets = await options.provider.createUploadTargets(body, ctx);
      return json({ targets });
    } catch (error) {
      // companyId 欠落など、こちらの構成不備は 500。端末は再試行してよい
      return json(
        { error: "sign_failed", message: error instanceof Error ? error.message : String(error) },
        500,
      );
    }
  };
}

/** `POST /api/files/sign-view` */
export function createSignViewRoute(
  options: SignViewRouteOptions,
): (request: Request) => Promise<Response> {
  const maxRefs = options.maxRefsPerRequest ?? DEFAULT_SERVER_LIMITS.maxRefsPerRequest;
  const defaultTtl = options.defaultTtlSec ?? DEFAULT_SERVER_LIMITS.viewUrlTtlSec;

  return async function signView(request: Request): Promise<Response> {
    const auth = await resolveAuth(options, request);
    if (auth instanceof Response) return auth;

    let body: { refs?: StoredObjectRef[]; ttlSec?: number };
    try {
      body = (await request.json()) as { refs?: StoredObjectRef[]; ttlSec?: number };
    } catch {
      return json({ error: "invalid_json" }, 400);
    }

    const refs = body?.refs;
    if (!Array.isArray(refs)) return json({ error: "invalid_request" }, 400);
    if (refs.length === 0) return json({ urls: [] });
    if (refs.length > maxRefs) return json({ error: "too_many_refs", max: maxRefs }, 413);

    /*
     * ★ 自社のプレフィックス配下だけに限る。
     *
     * 署名鍵は RLS を迂回するので、ここを通せば**どの会社のファイルでも**
     * 閲覧URLが出てしまう。ref は端末から来た値なので、信じてはいけない。
     */
    const companyId = auth.companyId ?? auth.tenantId;
    if (typeof companyId !== "string" || companyId.length === 0) {
      return json({ error: "forbidden" }, 403);
    }

    const foreign = refs.filter((ref) => companyIdOfPath(ref.path) !== companyId);
    if (foreign.length > 0) {
      return json({ error: "forbidden", count: foreign.length }, 403);
    }

    try {
      const urls = await options.provider.createViewUrls(
        refs,
        { ttlSec: body.ttlSec ?? defaultTtl },
        { auth, appId: options.appId, request },
      );
      return json({ urls });
    } catch (error) {
      return json(
        { error: "sign_failed", message: error instanceof Error ? error.message : String(error) },
        500,
      );
    }
  };
}
