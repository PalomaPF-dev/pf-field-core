/**
 * ストレージ抽象の型定義。
 *
 * ここに書かれた型が「端末側 ⇔ サーバ側」の契約であり、
 * Supabase Storage / S3 / Vercel Blob のいずれであっても、この形に射影できる限り
 * 端末側のコードは一切変わらない。設計の詳細は docs/DESIGN.md §2.4 を参照。
 */

/**
 * 保存先の論理参照。ジョブに永続化され、送信時にサーバへ渡る。
 * **URL は持たない** — 署名付きURLは短命で、保存しても意味が無いため。
 */
export interface StoredObjectRef {
  /** 'supabase' | 's3' | 'vercel-blob' など。移行期は複数 provider が混在する */
  provider: string;
  bucket: string;
  /** バケット内のパス。サーバが組み立てる（クライアント指定は使わない） */
  path: string;
  contentType?: string;
  bytes?: number;
  /** provider 固有の追加情報 */
  extra?: Record<string, unknown>;
}

/**
 * 「この URL へこう投げれば保存される」という転送指示。
 * S3 の PUT / POST policy、Supabase の署名付きアップロード、Azure SAS のいずれも表現できる。
 */
export interface UploadTarget {
  attachmentId: string;
  ref: StoredObjectRef;
  request: UploadRequestSpec;
  /** epoch ms。これを過ぎたら再発行が要る */
  expiresAt: number;
  /** 期限切れ・403 のとき再発行してよいか。既定 true */
  reissuable?: boolean;
}

export interface UploadRequestSpec {
  url: string;
  method: "PUT" | "POST";
  headers?: Record<string, string>;
  /** 'binary' = Blob をそのまま body に / 'form-data' = FormData に包む */
  bodyMode: "binary" | "form-data";
  /** form-data のときに同送するフィールド（S3 POST policy 等） */
  formFields?: Record<string, string>;
  /** form-data のときのファイルフィールド名。既定 'file' */
  fileFieldName?: string;
}

export interface UploadFileDescriptor {
  attachmentId: string;
  fileName: string;
  contentType: string;
  bytes: number;
  role?: string;
}

export interface CreateUploadTargetsRequest {
  jobId: string;
  jobType: string;
  files: UploadFileDescriptor[];
}

export interface AdapterContext {
  /** 認証ヘッダ等。Cookie 認証のみの現構成では空になることが多い */
  headers: Record<string, string>;
  signal?: AbortSignal;
}

export interface UploadContext extends AdapterContext {
  /** ページ内（XHR）でのみ呼ばれる。Service Worker 内では呼ばれない */
  onProgress?: (loaded: number, total: number) => void;
}

export interface UploadResult {
  ref: StoredObjectRef;
  bytes: number;
  durationMs: number;
  /** 既に同じパスに存在した（= 前回の再試行が実は成功していた） */
  alreadyExisted?: boolean;
}

export interface ResolvedUrl {
  ref: StoredObjectRef;
  url: string;
  /** epoch ms */
  expiresAt: number;
}

/**
 * 端末側の継ぎ目。
 * 既定実装（httpSigned）はサーバの /api/uploads/sign を叩くだけで、
 * どのストレージが裏にいるかを知らない。
 */
export interface StorageAdapter {
  readonly name: string;

  /** 送信直前に呼ばれる。アップロード先の記述子を得る */
  createUploadTargets(
    request: CreateUploadTargetsRequest,
    ctx: AdapterContext,
  ): Promise<UploadTarget[]>;

  /**
   * 記述子に従って実際に転送する。
   * 省略した場合は既定の transport（XHR / fetch 自動切替）が使われる。
   */
  upload?(target: UploadTarget, blob: Blob, ctx: UploadContext): Promise<UploadResult>;

  /** 閲覧用URLの都度発行 */
  createViewUrls?(refs: StoredObjectRef[], options?: { ttlSec?: number }): Promise<ResolvedUrl[]>;

  /** ジョブ破棄時の後始末 */
  remove?(refs: StoredObjectRef[]): Promise<void>;
}

/** 閲覧用URLの解決。バッチ + メモリキャッシュを担当する（実体は M4）。 */
export interface FileUrlResolver {
  resolve(ref: StoredObjectRef, options?: { ttlSec?: number }): Promise<string>;
  resolveMany(refs: StoredObjectRef[], options?: { ttlSec?: number }): Promise<ResolvedUrl[]>;
  /** ref 省略で全件破棄 */
  invalidate(ref?: StoredObjectRef): void;
}

/** ref の同一性判定に使う安定キー。Map のキーやキャッシュキーに用いる。 */
export function refKey(ref: StoredObjectRef): string {
  return `${ref.provider}:${ref.bucket}:${ref.path}`;
}
