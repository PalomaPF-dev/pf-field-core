# pf-field-core 設計案（実装前レビュー用）

現場系アプリ4本（pf-setsubi / pf-hinshitsu / pf-zaiko / pf-keisoku）が共通で使う
オフライン・アップロード基盤ライブラリの設計案。**この文書に合意してから実装に入る。**

---

## 0. 前提と設計上の制約

| 項目 | 内容 | 設計への影響 |
|---|---|---|
| 端末 | Zebra Android ハンディ（TC/MC系） | CPU が非力。画像圧縮は Worker に逃がす |
| 回線 | モバイルSIM + 工場Wi-Fi 併用 | ネットワーク切替で TCP が切れる。切替直後の "つながっているが通らない" 状態を扱う |
| 電波 | 建屋内に圏外・弱電界エリア | `navigator.onLine` は当てにならない（lie-fi）。到達性プローブが必須 |
| ブラウザ | Android WebView / Chrome（Chromium ベース） | `createImageBitmap` / `OffscreenCanvas` / `Web Locks` / `Background Sync` すべて利用可 |
| アプリ | Next.js × 4本 | App Router 前提。Service Worker は `public/sw.js` に配置 |
| 配布 | GitHub Packages（プライベート） | スコープは GitHub org 名と一致必須 → `@palomapf-dev/*` |

### 設計の芯になる 3 つの判断

1. **圧縮は enqueue 時、署名URL取得は送信直前。**
   圧縮済み Blob を IndexedDB に入れる。署名付きURLは有効期限（15分）があるため、
   キュー投入時に取ると圏外滞留中に必ず期限切れになる。取得は必ず送信ループの中で。
2. **送信ランナーはページ / Service Worker のどちらでも動く同一コード。**
   IndexedDB 上のジョブを Web Locks で排他しながら進める。Background Sync は SW 側から同じランナーを呼ぶだけ。
3. **エラーを「再試行可」と「人手が要る」に必ず分類する。**
   圏外・5xx はバックオフで自動再試行。認証切れ・バリデーションエラーは `blocked` にして UI に出す。
   ここを分けないと、現場では「いつまでも送信中のまま」になって信頼を失う。

---

## 1. パッケージ構成とディレクトリ設計

### 1.1 パッケージ分割方針

**単一パッケージ + サブパス exports** を推奨する。

```
@palomapf-dev/pf-field-core
├── .            → コア（型・キュー・アップロード・ネットワーク）
├── ./image      → 画像圧縮
├── ./react      → React フック / Provider（"use client"）
├── ./scanner    → DataWedge
├── ./sw         → Service Worker ビルダー（SW コンテキスト専用）
├── ./server     → Next.js Route Handler（署名URL発行）
└── ./cli        → SW ビルド CLI (`pf-field-sw`)
```

4パッケージに分けると、アプリ4本 × パッケージ4個のバージョン組み合わせ地獄になる。
単一パッケージなら「このアプリは 0.4.2」で全部言い切れる。
`sideEffects: false` + サブパス exports なので、`./server`（AWS SDK 依存）が
クライアントバンドルに混ざることはない。AWS SDK は `peerDependencies` +
`peerDependenciesMeta.optional = true` にして、使わないアプリには入れない。

将来 `./server` が肥大したら分離できるよう、リポジトリは最初から pnpm workspace で作る。

### 1.2 ディレクトリ

```
pf-field-core/
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── .changeset/                        # バージョニング
├── .github/workflows/
│   ├── ci.yml                         # typecheck / lint / unit / e2e
│   └── release.yml                    # changesets → GitHub Packages publish
├── docs/
│   ├── DESIGN.md                      # 本書
│   ├── integration-nextjs.md          # アプリ側組み込み手順
│   ├── server-contract.md             # 署名URL・冪等性のサーバ契約
│   └── datawedge-profile.md           # DataWedge プロファイル設定手順
├── packages/
│   └── field-core/
│       ├── package.json               # @palomapf-dev/pf-field-core
│       ├── tsup.config.ts             # ESM + CJS + d.ts、エントリ別
│       └── src/
│           ├── index.ts
│           ├── config.ts              # FieldCoreConfig / configureFieldCore
│           │
│           ├── image/
│           │   ├── compress.ts        # compressImage 本体
│           │   ├── decode.ts          # createImageBitmap / <img> フォールバック
│           │   ├── encode.ts          # OffscreenCanvas / HTMLCanvasElement 抽象
│           │   ├── exif.ts            # Orientation 読取 + 変換行列
│           │   ├── quality-search.ts  # 目標バイト数への品質二分探索
│           │   ├── worker/
│           │   │   ├── compress.worker.ts
│           │   │   └── pool.ts        # 1〜2 並列のワーカープール
│           │   └── types.ts
│           │
│           ├── db/
│           │   ├── schema.ts          # ストア定義とマイグレーション
│           │   ├── open.ts
│           │   ├── jobs.repo.ts
│           │   ├── blobs.repo.ts
│           │   └── storage.ts         # quota 見積 / persist() / 自動purge
│           │
│           ├── queue/
│           │   ├── queue.ts           # 公開 API（enqueue / list / flush ...）
│           │   ├── runner.ts          # 送信ループ（page / SW 共通）
│           │   ├── state.ts           # ジョブ状態遷移
│           │   ├── backoff.ts         # 指数バックオフ + full jitter
│           │   ├── lock.ts            # Web Locks + IDB リース フォールバック
│           │   ├── triggers.ts        # online / visibilitychange / interval
│           │   ├── errors.ts          # retryable / permanent 分類
│           │   └── types.ts
│           │
│           ├── upload/
│           │   ├── presign.client.ts  # 署名URL要求
│           │   ├── put-object.ts      # XHR(進捗あり) / fetch(SW用) 切替
│           │   ├── submit.ts          # レコード本体 POST（Idempotency-Key）
│           │   └── types.ts
│           │
│           ├── net/
│           │   ├── reachability.ts    # 到達性プローブ（lie-fi 検出）
│           │   ├── status.ts          # NetworkStatus ストア
│           │   └── fetch-timeout.ts
│           │
│           ├── scanner/
│           │   ├── keyboard.ts        # キーボードエミュレーション解析
│           │   ├── bridge.ts          # WebView Intent ブリッジ（任意）
│           │   └── types.ts
│           │
│           ├── react/
│           │   ├── FieldCoreProvider.tsx
│           │   ├── useOfflineQueue.ts
│           │   ├── useQueueJob.ts
│           │   ├── useNetworkStatus.ts
│           │   ├── useImageCompress.ts
│           │   ├── useDataWedgeScanner.ts
│           │   └── useServiceWorkerUpdate.ts
│           │
│           ├── sw/
│           │   ├── create.ts          # createFieldServiceWorker()
│           │   ├── strategies.ts      # cacheFirst / networkFirst / SWR
│           │   ├── precache.ts
│           │   └── sync.ts            # sync イベント → runner
│           │
│           ├── server/
│           │   ├── presign-handler.ts # createPresignRouteHandler()
│           │   ├── object-key.ts
│           │   └── types.ts
│           │
│           ├── cli/
│           │   └── build-sw.ts        # esbuild で sw.js + precache manifest 生成
│           │
│           └── shared/
│               ├── uuid.ts, emitter.ts, logger.ts, clock.ts, result.ts
│
├── apps/
│   └── playground/                    # Next.js 検証アプリ（オフライン再現・E2E対象）
└── test/
    ├── unit/                          # vitest + fake-indexeddb
    └── e2e/                           # playwright（offline / throttle / SW）
```

---

## 2. 公開 API インターフェース案

### 2.1 初期化

```ts
import { configureFieldCore } from '@palomapf-dev/pf-field-core';

export interface FieldCoreConfig {
  appId: 'pf-setsubi' | 'pf-hinshitsu' | 'pf-zaiko' | 'pf-keisoku' | (string & {});
  /** IndexedDB 名。既定は `pf-field-${appId}` */
  dbName?: string;

  endpoints: {
    /** 署名URL発行。既定 '/api/uploads/presign' */
    presign?: string;
    /** 到達性プローブ。既定 '/api/health' */
    health?: string;
    /** ジョブ種別 → レコード送信先 */
    submit: Record<string, string> | ((job: QueueJob) => string);
  };

  /** 送信直前に呼ばれる。認証ヘッダ付与・トークン更新はここで行う */
  auth?: {
    getHeaders: () => Promise<Record<string, string>>;
    /** 401/403 のとき呼ばれる。true を返せば 1 回だけ再試行 */
    onUnauthorized?: () => Promise<boolean>;
  };

  queue?: {
    maxAttempts?: number;          // 既定 8
    backoff?: BackoffOptions;      // 既定 { baseMs: 2000, factor: 2, maxMs: 300_000, jitter: 'full' }
    concurrency?: number;          // 同時実行ジョブ数。既定 1
    attachmentConcurrency?: number;// 1ジョブ内の画像同時アップロード数。既定 2（弱電界時は自動で 1）
    pollIntervalMs?: number;       // 既定 60_000
    autoStart?: boolean;           // 既定 true
    purgeSucceededAfterMs?: number;// 既定 7日
  };

  image?: CompressImageOptions;    // アプリ既定の圧縮設定
  logger?: FieldLogger;            // 既定は console（level: 'warn'）
  onEvent?: (e: FieldCoreEvent) => void; // 監視・計測フック
}

export function configureFieldCore(config: FieldCoreConfig): FieldCore;
export function getFieldCore(): FieldCore;   // 未初期化なら throw

export interface FieldCore {
  queue: OfflineQueue;
  network: NetworkStatusStore;
  storage: StorageInfo;
  destroy(): Promise<void>;
}
```

### 2.2 画像圧縮 — `@palomapf-dev/pf-field-core/image`

```ts
export interface CompressImageOptions {
  /** 長辺の最大 px。既定 1440（1280〜1600 の中央値） */
  maxEdge?: number;
  /** 初期 JPEG 品質。既定 0.75 */
  quality?: number;
  /** 目標バイト数レンジ。既定 { min: 200_000, max: 400_000 } */
  targetBytes?: { min: number; max: number } | false;
  /** 目標到達のための品質再探索の下限/上限。既定 0.45 / 0.85 */
  qualityRange?: { min: number; max: number };
  /** 再エンコード試行回数の上限。既定 4 */
  maxPasses?: number;
  /** 既定 'image/jpeg'。WebP は端末互換を確認してから */
  mimeType?: 'image/jpeg' | 'image/webp';
  /** Worker で処理する。既定 true（不可なら自動でメインスレッド） */
  useWorker?: boolean;
  signal?: AbortSignal;
  onProgress?: (p: { phase: 'decode' | 'resize' | 'encode'; pass: number }) => void;
}

export interface CompressedImage {
  blob: Blob;
  width: number; height: number; bytes: number;
  quality: number;                 // 最終的に採用した品質
  passes: number;                  // 実際のエンコード回数
  original: { bytes: number; width: number; height: number; type: string };
  orientation: number;             // 検出した EXIF Orientation (1..8)
  /** EXIF から拾えた撮影時刻。撮影日時の証跡に使う */
  capturedAt?: number;
  renderer: 'offscreen-worker' | 'offscreen-main' | 'canvas';
  durationMs: number;
}

export function compressImage(input: Blob | File, options?: CompressImageOptions): Promise<CompressedImage>;
export function compressImages(inputs: (Blob | File)[], options?: CompressImageOptions): Promise<CompressedImage[]>;
export function readExifOrientation(input: Blob): Promise<number>;
export function getImageCapabilities(): {
  createImageBitmap: boolean; imageOrientationFromImage: boolean;
  offscreenCanvas: boolean; worker: boolean; webp: boolean;
};
```

**アルゴリズム**

1. `createImageBitmap(blob, { imageOrientation: 'from-image' })` で回転込みデコード。
   これに対応していない場合のみ `exif.ts` で Orientation を読み、canvas の transform で自前補正する。
   さらに `createImageBitmap` 自体が無い場合は `<img>` + `URL.createObjectURL` にフォールバック。
2. 長辺 `maxEdge` に合わせて縮小（拡大はしない）。縮小率が 1/2 を大きく下回るときは
   2段階縮小してモアレを抑える。
3. `OffscreenCanvas.convertToBlob({ type, quality })` でエンコード。
   OffscreenCanvas が無ければ `HTMLCanvasElement.toBlob`。
4. 出力が `targetBytes` レンジ外なら品質を二分探索（最大 `maxPasses` 回）。
   下限品質でも `max` を超える場合は長辺を 0.85 倍して 1 回だけ再試行し、それでも駄目なら
   「品質下限で出せたサイズ」をそのまま返す（失敗にはしない）。
5. Worker 実行時は Blob を transfer し、メインスレッドを止めない。

**EXIF の扱い**: canvas 再エンコードで EXIF は落ちる。位置情報を残さない点はむしろ望ましいが、
撮影時刻は証跡に要るので `capturedAt` として構造化データ側に持ち上げてサーバへ送る。

### 2.3 オフラインキュー — `@palomapf-dev/pf-field-core`

```ts
export type QueueJobStatus =
  | 'pending'    // 待機中（nextAttemptAt 到来で実行可能）
  | 'active'     // 実行中
  | 'succeeded'
  | 'failed'     // 再試行上限に到達。手動再送で pending に戻せる
  | 'blocked'    // 恒久エラー（認証切れ / バリデーション）。人手が要る
  | 'canceled';

export type QueueJobPhase = 'presigning' | 'uploading' | 'submitting';

export interface QueueAttachmentInput {
  attachmentId?: string;           // 省略時 UUID
  blob: Blob | File;
  fileName: string;
  contentType?: string;            // 既定は blob.type
  role?: string;                   // 'before' | 'after' | 'defect' などアプリ定義
  /** false で圧縮スキップ（PDF・署名画像など） */
  compress?: CompressImageOptions | false;
  meta?: Record<string, unknown>;
}

export interface QueueJobInput<P = unknown> {
  /** クライアント発行 UUID。冪等キーそのもの。省略時 crypto.randomUUID() */
  jobId?: string;
  type: string;                    // 'setsubi.inspection' 等
  payload: P;                      // JSON 直列化可能なレコード本体
  attachments?: QueueAttachmentInput[];
  submitUrl?: string;              // config.endpoints.submit を上書き
  maxAttempts?: number;
  priority?: number;               // 大きいほど先。既定 0
  /** UI 表示用（一覧に「設備No.1234 点検」等を出すため） */
  label?: string;
  meta?: Record<string, unknown>;
}

export interface QueueAttachment {
  attachmentId: string;
  fileName: string; contentType: string; bytes: number;
  role?: string;
  status: 'pending' | 'uploaded' | 'failed';
  objectKey?: string;              // アップロード完了後に確定
  uploadedAt?: number;
  compression?: Omit<CompressedImage, 'blob'>;
}

export interface QueueJob<P = unknown> {
  jobId: string; type: string; label?: string;
  status: QueueJobStatus; phase?: QueueJobPhase;
  payload: P;
  attachments: QueueAttachment[];
  attempts: number; maxAttempts: number;
  nextAttemptAt: number | null;
  lastError?: QueueError;
  progress: { uploadedBytes: number; totalBytes: number; uploadedCount: number; totalCount: number };
  createdAt: number; updatedAt: number; succeededAt?: number;
}

export interface QueueError {
  kind: 'network' | 'timeout' | 'server' | 'auth' | 'validation' | 'quota' | 'expired' | 'aborted' | 'unknown';
  retryable: boolean;
  message: string;
  httpStatus?: number;
  at: number;
}

export interface QueueCounts {
  pending: number; active: number; failed: number; blocked: number; succeeded: number;
  /** 未送信バッジに出す数 = pending + active + failed + blocked */
  unsent: number;
  total: number;
  oldestPendingAt: number | null;   // 「最古 2時間前」の表示に使う
}

export interface OfflineQueue {
  enqueue<P>(input: QueueJobInput<P>): Promise<QueueJob<P>>;

  get(jobId: string): Promise<QueueJob | undefined>;
  list(filter?: { status?: QueueJobStatus[]; type?: string[]; limit?: number; offset?: number }): Promise<QueueJob[]>;
  counts(): Promise<QueueCounts>;

  /** 手動再送。到達性を確認してからランナーを 1 周回す */
  flush(opts?: { force?: boolean; jobIds?: string[]; signal?: AbortSignal }): Promise<FlushResult>;
  /** failed / blocked を pending に戻して即実行 */
  retry(jobId: string): Promise<void>;
  retryAll(opts?: { includeBlocked?: boolean }): Promise<void>;

  cancel(jobId: string): Promise<void>;
  remove(jobId: string): Promise<void>;
  purgeSucceeded(olderThanMs?: number): Promise<number>;

  /** 画像 Blob を取り出す（未送信一覧のサムネイル表示用） */
  getAttachmentBlob(jobId: string, attachmentId: string): Promise<Blob | undefined>;

  start(): void;
  stop(): void;
  subscribe(listener: (snapshot: QueueSnapshot) => void): () => void;
}

export interface FlushResult {
  attempted: number; succeeded: number; failed: number; skipped: number;
  reason?: 'offline' | 'unreachable' | 'locked' | 'empty';
}

export interface QueueSnapshot {
  counts: QueueCounts;
  isSyncing: boolean;
  lastSyncAt: number | null;
  lastError: QueueError | null;
}
```

**送信ランナーの流れ（1ジョブあたり）**

```
pending
  └─ ロック取得（Web Locks: 'pf-field-runner'）
  └─ 到達性プローブ OK?  ── NG → 何もせず終了（状態は pending のまま）
  └─ auth.getHeaders()
  └─ phase='presigning'  未アップロードの attachment だけ署名URLを要求
  └─ phase='uploading'   PUT。成功した attachment は即 objectKey を保存
  │                      （途中で圏外になっても、次回は残りだけ送る）
  └─ phase='submitting'  POST payload + objectKeys, Idempotency-Key: jobId
  └─ 2xx → succeeded / 409(既存) → succeeded 扱い
     5xx・ネットワーク → attempts++、nextAttemptAt = backoff() → pending
     401/403 → onUnauthorized() で1回だけ再試行、駄目なら blocked(auth)
     400/422 → blocked(validation)
     attempts >= maxAttempts → failed
```

**バックオフ**: `delay = random(0, min(maxMs, baseMs * factor^(attempts-1)))`（full jitter）。
既定で 2s → 4s → 8s → … → 上限 5分、8回で打ち切り。
端末が何十台も同時に復帰したときサーバを殴らないよう jitter は必須。

**排他制御**: `navigator.locks.request('pf-field-runner', { ifAvailable: true })`。
ページ複数タブ + Service Worker が同時に走っても 1 つだけが動く。
Web Locks が無い環境向けに IndexedDB のリースレコード（TTL 30秒）でフォールバック。

**トリガ**:
| トリガ | 実装 | 備考 |
|---|---|---|
| enqueue 直後 | 即 `flush()` | オンラインなら待たせない |
| `online` イベント | リスナ | 到達性プローブを挟む |
| `visibilitychange`（visible） | リスナ | ハンディを胸ポケットから出した瞬間 |
| `focus` | リスナ | WebView 復帰時 |
| 定期ポーリング | `setInterval` 60秒 | 未送信 0 のときは止める |
| Background Sync | SW `sync` イベント（tag `pf-field-queue`） | アプリを閉じても送る |
| Periodic Background Sync | 任意（tag `pf-field-queue-periodic`） | PWA インストール＋利用実績が要るので保険扱い |

**冪等性**: `jobId`（クライアント UUID）を `Idempotency-Key` ヘッダと body 両方に入れる。
サーバは `client_job_id` に UNIQUE 制約を張り、重複時は既存レコードを 200/409 で返す。
「送信は成功したがレスポンスが届かなかった」ケースは弱電界では日常的に起きるので、ここは必須。

**ストレージ**: object store は `jobs` / `blobs` / `meta` の 3 本。
Blob を job レコードから分離することで、一覧表示のたびに数MBを読まずに済む。
`navigator.storage.persist()` を初期化時に要求し、`estimate()` で残量を監視。
enqueue 時に残量不足なら `QuotaExceededError` を投げて UI に出す（黙って落とさない）。
成功ジョブは既定 7日後に自動 purge。

### 2.4 S3 署名付きURL直送 — サーバ契約

**クライアント → サーバ**
```http
POST /api/uploads/presign
Content-Type: application/json

{ "jobId": "...", "jobType": "setsubi.inspection",
  "files": [{ "attachmentId": "...", "fileName": "IMG_0001.jpg",
              "contentType": "image/jpeg", "bytes": 312044, "role": "before" }] }
```
**サーバ → クライアント**
```json
{ "targets": [{ "attachmentId": "...", "method": "PUT",
                "uploadUrl": "https://bucket.s3.ap-northeast-1.amazonaws.com/...",
                "headers": { "Content-Type": "image/jpeg" },
                "objectKey": "setsubi/2026/08/<jobId>/<attachmentId>.jpg",
                "expiresAt": 1770000000000 }] }
```

```ts
// @palomapf-dev/pf-field-core/server
export interface PresignRouteOptions {
  bucket: string;
  region?: string;
  client?: S3Client;                          // 未指定なら環境変数から生成
  expiresInSec?: number;                      // 既定 900
  maxBytes?: number;                          // 既定 8 * 1024 * 1024
  allowedContentTypes?: string[];             // 既定 ['image/jpeg','image/webp','image/png','application/pdf']
  maxFilesPerRequest?: number;                // 既定 20
  buildObjectKey?(ctx: ObjectKeyContext): string;
  /** 認証はアプリ側の責務。throw すれば 401 を返す */
  authorize(req: Request): Promise<{ userId: string; tenantId?: string }>;
}
export function createPresignRouteHandler(o: PresignRouteOptions): (req: Request) => Promise<Response>;
```

アプリ側は 5 行:
```ts
// app/api/uploads/presign/route.ts
import { createPresignRouteHandler } from '@palomapf-dev/pf-field-core/server';
import { requireSession } from '@/lib/auth';
export const POST = createPresignRouteHandler({
  bucket: process.env.S3_BUCKET!,
  authorize: async (req) => { const s = await requireSession(req); return { userId: s.userId }; },
});
```

**注意点**
- 署名時に含めたヘッダ（`Content-Type`）は、クライアント PUT でも寸分違わず送る必要がある。
  transport 側でサーバが返した `headers` をそのまま使う設計にして、齟齬を構造的に防ぐ。
- **バケットの CORS 設定が必要**（`PUT` / `AllowedOrigin` にアプリ4本のオリジン / `ExposeHeaders: ETag`）。
  Terraform / CDK 側の変更事項として起票する。
- 403 が返ったら「期限切れ」とみなし、**1回だけ**署名を取り直して再試行する。
- 進捗表示のためページ内では `XMLHttpRequest`（`upload.onprogress`）を使う。
  Service Worker には XHR が無いので `fetch` を使う（SW 実行時は進捗なし＝件数単位の進捗のみ）。
  この切替は `put-object.ts` が実行コンテキストを見て自動で行う。
- 200〜400KB × 数枚なので multipart upload は不要。今回のスコープ外とする。

### 2.5 Service Worker — `@palomapf-dev/pf-field-core/sw`

アプリ側は薄い `worker/sw.ts` を置くだけ:
```ts
import { createFieldServiceWorker } from '@palomapf-dev/pf-field-core/sw';

createFieldServiceWorker({
  appId: 'pf-setsubi',
  version: process.env.NEXT_PUBLIC_BUILD_ID!,   // ビルドごとに変わる値
  precache: self.__PF_PRECACHE__,               // CLI が注入
  appShell: {
    strategy: 'cache-first',
    routes: ['/', '/inspections', '/offline'],
    navigationFallback: '/offline',
  },
  api: {
    strategy: 'network-first',
    timeoutMs: 3000,
    include: [/^\/api\//],
    /** マスタ系だけキャッシュを残す。更新系は絶対にキャッシュしない */
    cacheable: [/^\/api\/master\//, /^\/api\/equipments/],
    exclude: [/^\/api\/uploads\//, /^\/api\/auth\//],
    maxAgeMs: 24 * 60 * 60 * 1000,
  },
  queue: { syncTag: 'pf-field-queue', enablePeriodicSync: false },
  skipWaiting: false,   // 更新は useServiceWorkerUpdate() でユーザーに確認してから
});
```

```ts
export interface FieldServiceWorkerOptions { /* 上記のとおり */ }
export function createFieldServiceWorker(o: FieldServiceWorkerOptions): void;
// 個別に使いたい場合向けの下位 API
export function cacheFirst(o): (e: FetchEvent) => Promise<Response>;
export function networkFirst(o): (e: FetchEvent) => Promise<Response>;
```

**キャッシュ戦略の中身**
| 対象 | 戦略 | 理由 |
|---|---|---|
| `/_next/static/**`（ハッシュ付き） | Cache First（永続） | 内容不変。ネットワークに触る意味がない |
| プリキャッシュ済みナビゲーション | Cache First + バージョン更新時に一括入替 | 圏外でも起動する。App Shell の要件 |
| 未プリキャッシュのナビゲーション | Network First → キャッシュ → `/offline` | SSR ページを古いまま出さない |
| `/api/master/**` 等の参照系 | Network First（3秒タイムアウト）→ キャッシュ | 弱電界で 30 秒待たされるのを防ぐ |
| `/api/uploads/**`, `/api/auth/**`, 更新系 | キャッシュしない | 署名URL・認証をキャッシュしてはいけない |

**ビルド**: `pf-field-sw build` CLI（esbuild）を各アプリの `prebuild` で回し、
`worker/sw.ts` → `public/sw.js` と precache manifest を生成する。
`@serwist/next` を使う案もあるが、キュー実行を SW に同居させる都合上、自前の薄い CLI のほうが
制御しやすいと判断した（実装量 100 行程度）。

**注意**: `skipWaiting: false` を既定にする。点検入力の途中で SW が入れ替わって
ページがリロードされる事故を防ぐ。更新は UI で明示的に促す。

### 2.6 DataWedge 連携 — `@palomapf-dev/pf-field-core/scanner`

```ts
export interface ScanEvent {
  data: string;                 // normalize 後
  raw: string;                  // prefix/suffix 込みの生データ
  source: 'keyboard' | 'bridge' | 'manual';
  symbology?: string;           // DataWedge の suffix で symbology を送る設定にした場合
  receivedAt: number;
  durationMs: number;           // 入力に要した時間（人手入力との判別根拠）
}

export interface ScannerOptions {
  enabled?: boolean;                       // 既定 true
  minLength?: number;                      // 既定 4
  /** キー間隔がこれ以下ならスキャナ由来とみなす。既定 40ms */
  maxIntervalMs?: number;
  terminator?: 'Enter' | 'Tab' | RegExp;   // 既定 'Enter'
  prefix?: string;                         // DataWedge プロファイルで付与した接頭辞
  suffix?: string;
  /** input/textarea にフォーカスがあるときは無視。既定 true */
  ignoreWhileTyping?: boolean;
  /** 対象要素。既定は document */
  target?: RefObject<HTMLElement> | Document;
  normalize?(raw: string): string;
  validate?(data: string): boolean;        // false ならイベントを発火しない
  onInvalid?(raw: string): void;
}

// フレームワーク非依存
export function createScannerListener(
  o: ScannerOptions & { onScan(e: ScanEvent): void }
): { start(): void; stop(): void; simulate(data: string): void };

// React
export function useDataWedgeScanner(
  o: ScannerOptions & { onScan(e: ScanEvent): void }
): { lastScan: ScanEvent | null; isListening: boolean; simulate(data: string): void };
```

**判別ロジック**: `keydown` を蓄積し、(a) 連続キーの間隔がすべて `maxIntervalMs` 以下、
(b) 長さが `minLength` 以上、(c) `terminator` で終端 — の 3 条件でスキャンと判定。
`prefix`/`suffix` が設定されていればそちらを優先（決定的なので誤検知ゼロ）。
**運用としては DataWedge プロファイルで prefix/suffix を付ける設定を推奨**し、
その手順を `docs/datawedge-profile.md` に書く。ヒューリスティックはあくまで保険。

**拡張点**: WebView ラッパーが Intent 出力を JS に橋渡しする構成（`window.__PF_SCAN_BRIDGE__`）に
対応するアダプタ口を用意しておく。今回は実装せず、インターフェースだけ切る。

### 2.7 React バインディング — `@palomapf-dev/pf-field-core/react`

内部は `useSyncExternalStore` で実装。React 18/19・Next.js App Router で安全に動く。

```tsx
export function FieldCoreProvider(props: { config: FieldCoreConfig; children: ReactNode }): JSX.Element;

export function useOfflineQueue(filter?: QueueFilter): {
  counts: QueueCounts;
  jobs: QueueJob[];
  isSyncing: boolean;
  lastSyncAt: number | null;
  lastError: QueueError | null;
  enqueue<P>(input: QueueJobInput<P>): Promise<QueueJob<P>>;
  flush(): Promise<FlushResult>;
  retry(jobId: string): Promise<void>;
  retryAll(): Promise<void>;
  cancel(jobId: string): Promise<void>;
};

export function useQueueJob(jobId: string): { job: QueueJob | undefined; retry(): Promise<void>; cancel(): Promise<void> };

export function useNetworkStatus(): {
  online: boolean;          // navigator.onLine
  reachable: boolean;       // 実際にサーバへ届くか（lie-fi 検出）
  quality: 'good' | 'poor' | 'offline';
  effectiveType?: '4g' | '3g' | '2g' | 'slow-2g';
  lastCheckedAt: number;
  recheck(): Promise<boolean>;
};

export function useImageCompress(options?: CompressImageOptions): {
  compress(files: (File | Blob)[]): Promise<CompressedImage[]>;
  isCompressing: boolean;
  progress: { done: number; total: number };
  error: Error | null;
};

export function useServiceWorkerUpdate(): {
  registration: ServiceWorkerRegistration | null;
  updateAvailable: boolean;
  applyUpdate(): Promise<void>;   // skipWaiting → reload
};
```

想定される使い方:
```tsx
const { counts, flush, isSyncing } = useOfflineQueue();
const { reachable } = useNetworkStatus();

<button onClick={flush} disabled={isSyncing || !reachable}>
  未送信 {counts.unsent} 件を送信
</button>
```

---

## 3. 各アプリ側で必要になる変更点

### 3.1 全アプリ共通（4本すべて）

| # | 変更対象 | 内容 |
|---|---|---|
| 1 | `.npmrc` | `@palomapf-dev:registry=https://npm.pkg.github.com` + トークン参照 |
| 2 | `package.json` | 依存追加 / `"prebuild": "pf-field-sw build"` |
| 3 | CI・Vercel等の環境変数 | GitHub Packages 読み取り用トークンを追加 |
| 4 | `app/providers.tsx`（新規） | `"use client"` + `<FieldCoreProvider config={...}>` |
| 5 | `app/layout.tsx` | Provider で包む / `manifest` リンク / SW 登録コンポーネント配置 |
| 6 | `worker/sw.ts`（新規） | `createFieldServiceWorker({...})` 数行 |
| 7 | `next.config.js` | `/sw.js` に `Cache-Control: no-cache` + `Service-Worker-Allowed: /` ヘッダ |
| 8 | `public/manifest.webmanifest` + アイコン（新規） | PWA 化。Background Sync / persist の前提 |
| 9 | `app/offline/page.tsx`（新規） | 圏外フォールバック画面 |
| 10 | `app/api/uploads/presign/route.ts`（新規） | `createPresignRouteHandler` を貼るだけ |
| 11 | `app/api/health/route.ts`（新規） | 到達性プローブ用の軽量エンドポイント |
| 12 | **既存の登録系 API** | `Idempotency-Key` を受理し、`client_job_id` UNIQUE で重複を吸収。<br>画像は multipart 受信ではなく **objectKey の配列**を受け取る形に変更 |
| 13 | **DB マイグレーション** | 各レコードテーブルに `client_job_id`（UNIQUE）と `captured_at` を追加 |
| 14 | 送信フォーム | `fetch(...)` 直呼びを `queue.enqueue(...)` に置換。<br>「送信しました」→「送信予約しました（未送信 N 件）」へ文言変更 |
| 15 | ヘッダ / グローバルUI | 未送信バッジ + オフライン表示 + 手動再送ボタン |
| 16 | 未送信一覧画面（新規） | ジョブ一覧・エラー理由・個別再送・破棄。`blocked` の救済導線 |
| 17 | CSP（設定していれば） | `worker-src 'self'` / `connect-src` に S3 エンドポイント追加 |

### 3.2 アプリ横断のインフラ変更

- **S3 バケット**: CORS（PUT / 4オリジン / ExposeHeaders: ETag）、ライフサイクル、
  署名発行用 IAM ポリシー（`s3:PutObject` を `buildObjectKey` のプレフィックスに限定）。
- **HTTPS**: Service Worker は secure context 必須。工場内ホスト名でアクセスする経路がある場合、
  そのホスト名で有効な証明書が要る。ここは**先に確認しておきたい**（設計の前提が崩れる箇所）。
- **認証の有効期限**: ジョブが数時間滞留する前提なので、セッション/JWT の有効期限が
  それより短いと復帰時に全部 `blocked(auth)` になる。リフレッシュトークンの導入か
  有効期限の延長が要るかを、アプリ側の認証実装を見て判断する。

### 3.3 アプリ別に想定される差分

| アプリ | 想定ジョブ種別 | 特記 |
|---|---|---|
| pf-setsubi | 点検結果 + 現場写真（複数枚） | 添付枚数が最多。1ジョブ 5〜10枚を想定した進捗UIが要る |
| pf-hinshitsu | 不良報告 + 不良部位写真 | 不良箇所の判別があるため圧縮を強くしすぎない（`maxEdge: 1600` を検討） |
| pf-zaiko | 棚卸カウント（写真少なめ / 件数多め） | スキャン主体。DataWedge の連続スキャン性能が要件。ジョブ件数が数百単位になる想定 |
| pf-keisoku | 計測値 + 計器写真 | 数値の桁落ち防止でバリデーションを enqueue 前に必ず通す |

---

## 4. 実装順序とマイルストーン

縦切り（1機能を端から端まで通す）を優先し、**M4 の時点で pf-setsubi に実地投入できる**状態を作る。
残り3アプリは M4 以降に並行して着手できる。

| M | 内容 | 主な成果物 | 完了条件 |
|---|---|---|---|
| **M0** | 基盤整備 | pnpm workspace / tsup / vitest / playwright / changesets / CI / GitHub Packages publish / playground アプリ | `0.0.1` が GitHub Packages に publish でき、playground から import できる |
| **M1** | 画像圧縮 | `./image` 一式、Worker、EXIF、品質探索 | 実機の代表写真20枚で 200〜400KB に収まり、Orientation が全パターン正しい。実機で 1枚 1.5秒以内 |
| **M2** | 永続化 + キュー骨格 | `db/`, `queue/`（enqueue / list / counts / subscribe / backoff / lock） | fake-indexeddb の単体テストが通る。ジョブ状態遷移が網羅テスト済み |
| **M3** | 署名URL + 送信 | `upload/`, `net/`, `server/`, ランナー本体 | playground で「圏外 → 復帰 → 自動送信」「途中で切断 → 残り添付だけ再送」「二重送信されない」が E2E で通る |
| **M4** | React バインディング | `react/` 一式、Provider | playground の UI で未送信件数・手動再送・進捗が動く。**ここで pf-setsubi へパイロット投入** |
| **M5** | Service Worker | `sw/`, `cli/`, Background Sync | アプリを閉じた状態から Background Sync で送信完了する。圏外でアプリシェルが起動する |
| **M6** | DataWedge | `scanner/`, プロファイル手順書 | 実機で連続スキャンが取りこぼしなく拾える。手入力と誤認しない |
| **M7** | 堅牢化 | quota / purge / 監視イベント / 多タブ / 障害系テスト / ドキュメント | ストレージ逼迫・認証切れ・時計ずれの各シナリオで UI が正しく破綻を伝える。`1.0.0` |
| **M8** | 横展開 | pf-hinshitsu / pf-zaiko / pf-keisoku 組み込み | 4アプリすべてが同一メジャーバージョンで稼働 |

**並行できる作業**: M1 と M2 は独立なので同時進行可。
サーバ側（既存API の冪等化 + DBマイグレーション + S3 CORS/IAM）は M0 の時点で着手依頼を出しておく
— ここが遅れると M3 が止まる。

**バージョニング**: M7 到達までは `0.x`。changesets で PR ごとに変更点を積み、
`main` マージで自動 publish。破壊的変更は 0.x の間はマイナーで出す。

---

## 5. 確認したい判断ポイント

1. **パッケージ分割** — 単一パッケージ + サブパス exports（推奨）で良いか。
2. **Service Worker のビルド** — 自前の薄い esbuild CLI（推奨）か、`@serwist/next` に乗るか。
3. **投入戦略** — M4 で pf-setsubi にパイロット投入（推奨）か、M7 まで作り切ってから4本同時か。
4. **サーバ側の変更主体** — 既存 API の冪等化・DBマイグレーション・S3 CORS/IAM をこちらでやるか、別チームに依頼するか。

## 6. 先に確認しておきたい前提

- 全アプリが HTTPS（有効な証明書）で提供されているか。Service Worker の可否に直結する。
- 現行の認証方式とセッション有効期限。数時間の滞留に耐えるか。
- Zebra 端末の Android / WebView（Chrome）バージョン。`imageOrientation: 'from-image'` は Chrome 79+。
- S3 バケットは4アプリ共用か、アプリごとに分けるか。オブジェクトキー設計と IAM に影響する。
- 端末1台あたりに許容するオフライン滞留量（写真の枚数・日数）。purge ポリシーとストレージ見積の根拠になる。
