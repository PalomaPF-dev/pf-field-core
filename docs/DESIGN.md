# pf-field-core 設計案（実装前レビュー用）

現場系アプリ4本（pf-setsubi / pf-hinshitsu / pf-zaiko / pf-keisoku）が共通で使う
オフライン・アップロード基盤ライブラリの設計案。**この文書に合意してから実装に入る。**

> **改訂履歴**
> - rev.5 — M1（画像圧縮）完了。§5-8 の3件を決定（§5-9）。実測にもとづき
>   Worker へのオフロードを **M1b へ延期**（メインスレッドの詰まりが実測 0ms のため）。
>   「圧縮したほうが太る」写真を元のまま送る判断を追加。
> - rev.4 — M0 完了。実装で判明した2点を反映:
>   既定の再試行回数を 8 → **10**（8回だと上限5分に到達せず `maxMs` が死ぬ）、
>   App Shell の Cache First を取りやめ（`private, no-store` と衝突するため）。
> - rev.3 — 判断ポイント7件と前提確認への回答を反映し、**方針確定**（§5）。
>   署名は `SUPABASE_SERVICE_ROLE_KEY` を用いたサーバ側発行に確定（§2.4.4 / §2.4.6）。
> - rev.2 — ストレージを S3 → **Supabase Storage** に変更。あわせてアップロード処理を
>   `StorageAdapter` / `StorageProvider` の2つの継ぎ目の背後に置き、実装を差し替え可能にした（§2.4）。
> - rev.1 — 初版。

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
| ストレージ | **Supabase Storage（東京リージョン）／非公開バケット** | 権限は RLS に集約。バケットの CORS 設定は不要（Supabase 側で処理） |
| DB | **Supabase Postgres（移行予定）** | 送信先（submit）も差し替わりうるので継ぎ目を用意しておく |

### 設計の芯になる 4 つの判断

1. **圧縮は enqueue 時、署名URL取得は送信直前。**
   圧縮済み Blob を IndexedDB に入れる。Supabase の署名付きアップロードURLの有効期限は既定で約2時間。
   S3 の15分よりは長いが、圏外滞留は数時間〜数日になりうるので「送信直前に発行」の原則は変わらない。
2. **プロバイダ依存はサーバ側の 1 ファイルに閉じる。**
   端末側の既定アダプタは「自アプリの `/api/uploads/sign` から受け取った記述子どおりに転送するだけ」で、
   Supabase を知らない。ストレージを差し替えるとき端末側のコードは 1 行も変わらない（§2.4）。
3. **送信ランナーはページ / Service Worker のどちらでも動く同一コード。**
   IndexedDB 上のジョブを Web Locks で排他しながら進める。Background Sync は SW 側から同じランナーを呼ぶだけ。
4. **エラーを「再試行可」と「人手が要る」に必ず分類する。**
   圏外・5xx はバックオフで自動再試行。認証切れ・バリデーションエラーは `blocked` にして UI に出す。
   ここを分けないと、現場では「いつまでも送信中のまま」になって信頼を失う。

---

## 1. パッケージ構成とディレクトリ設計

### 1.1 パッケージ分割方針

**単一パッケージ + サブパス exports** を推奨する。

```
@palomapf-dev/pf-field-core
├── .            → コア（型・キュー・ネットワーク）
├── ./image      → 画像圧縮
├── ./storage    → StorageAdapter インターフェースと端末側実装
├── ./react      → React フック / Provider（"use client"）
├── ./scanner    → DataWedge
├── ./sw         → Service Worker ビルダー（SW コンテキスト専用）
├── ./server     → Next.js Route Handler + StorageProvider 実装（サーバ専用）
└── ./cli        → SW ビルド CLI (`pf-field-sw`)
```

4パッケージに分けると、アプリ4本 × パッケージ4個のバージョン組み合わせ地獄になる。
単一パッケージなら「このアプリは 0.4.2」で全部言い切れる。
`sideEffects: false` + サブパス exports なので、`./server`（`@supabase/supabase-js` 依存）が
クライアントバンドルに混ざることはない。`@supabase/supabase-js` は `peerDependencies` +
`peerDependenciesMeta.optional = true` にする。

将来 `./server` が肥大したら分離できるよう、リポジトリは最初から pnpm workspace で作る。

### 1.2 ディレクトリ

```
pf-field-core/
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── .changeset/
├── .github/workflows/{ci.yml, release.yml}
├── docs/
│   ├── DESIGN.md                      # 本書
│   ├── auth-findings.md               # pf-portal / pf-setsubi の認証実装 調査結果
│   ├── integration-nextjs.md          # アプリ側組み込み手順
│   ├── storage-contract.md            # sign/view エンドポイントの契約（プロバイダ非依存）
│   ├── supabase-setup.md              # バケット作成・RLS 確認・環境変数
│   └── datawedge-profile.md           # DataWedge プロファイル設定手順
├── packages/
│   └── field-core/
│       ├── package.json               # @palomapf-dev/pf-field-core
│       ├── tsup.config.ts
│       └── src/
│           ├── index.ts
│           ├── config.ts
│           │
│           ├── image/
│           │   ├── compress.ts        # compressImage 本体
│           │   ├── decode.ts          # createImageBitmap / <img> フォールバック
│           │   ├── encode.ts          # OffscreenCanvas / HTMLCanvasElement 抽象
│           │   ├── exif.ts            # Orientation 読取 + 変換行列
│           │   ├── quality-search.ts  # 目標バイト数への品質二分探索
│           │   ├── worker/{compress.worker.ts, pool.ts}
│           │   └── types.ts
│           │
│           ├── db/
│           │   ├── schema.ts          # ストア定義とマイグレーション
│           │   ├── open.ts
│           │   ├── jobs.repo.ts
│           │   ├── blobs.repo.ts
│           │   └── storage-quota.ts   # quota 見積 / persist() / 自動purge
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
│           ├── storage/               # ★ 差し替え可能な継ぎ目（端末側）
│           │   ├── adapter.ts         # StorageAdapter インターフェース定義
│           │   ├── http-signed.ts     # 既定実装：プロバイダ非依存（/api/uploads/sign 経由）
│           │   ├── supabase-direct.ts # 変種：端末から supabase-js で直接発行（任意）
│           │   ├── memory.ts          # テスト用のインメモリ実装
│           │   ├── transport.ts       # UploadTarget を実行（XHR=進捗あり / fetch=SW用）
│           │   └── types.ts           # UploadTarget / StoredObjectRef ほか
│           │
│           ├── submit/                # ★ 差し替え可能な継ぎ目（レコード送信先）
│           │   ├── adapter.ts         # SubmitAdapter インターフェース
│           │   ├── http.ts            # 既定：Next.js Route Handler へ POST
│           │   └── supabase-rpc.ts    # 将来：Supabase RPC へ直接（DB移行後）
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
│           │   ├── useSignedUrl.ts    # 閲覧用URLの都度発行 + キャッシュ
│           │   ├── useDataWedgeScanner.ts
│           │   └── useServiceWorkerUpdate.ts
│           │
│           ├── sw/
│           │   ├── create.ts          # createFieldServiceWorker()
│           │   ├── strategies.ts      # cacheFirst / networkFirst / SWR
│           │   ├── precache.ts
│           │   ├── cache-key.ts       # 署名付きURLの正規化キャッシュキー
│           │   └── sync.ts            # sync イベント → runner
│           │
│           ├── server/                # ★ 差し替え可能な継ぎ目（サーバ側）
│           │   ├── sign-upload-handler.ts  # POST /api/uploads/sign
│           │   ├── sign-view-handler.ts    # POST /api/files/sign-view
│           │   ├── providers/
│           │   │   ├── supabase.ts    # supabaseStorageProvider()
│           │   │   ├── s3.ts          # s3StorageProvider()（差し替え可能性の実証・任意）
│           │   │   └── types.ts       # StorageProvider インターフェース
│           │   ├── object-path.ts     # パス生成規約（クライアント入力を信用しない）
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
import { createHttpSignedStorageAdapter } from '@palomapf-dev/pf-field-core/storage';

export interface FieldCoreConfig {
  appId: 'pf-setsubi' | 'pf-hinshitsu' | 'pf-zaiko' | 'pf-keisoku' | (string & {});
  /** IndexedDB 名。既定は `pf-field-${appId}` */
  dbName?: string;

  /**
   * アップロード先の抽象。省略時は createHttpSignedStorageAdapter() が使われる
   * （= /api/uploads/sign と /api/files/sign-view を叩く、プロバイダ非依存の既定実装）
   */
  storage?: StorageAdapter;

  /** レコード本体の送信先の抽象。省略時は httpSubmitAdapter */
  submit?: SubmitAdapter;

  endpoints: {
    /** 到達性プローブ。既定 '/api/health' */
    health?: string;
    /** ジョブ種別 → レコード送信先（httpSubmitAdapter 使用時） */
    submit: Record<string, string> | ((job: QueueJob) => string);
  };

  /** 送信直前に呼ばれる。認証ヘッダ付与・トークン更新はここで行う */
  auth?: {
    getHeaders: () => Promise<Record<string, string>>;
    /** 401/403 のとき呼ばれる。true を返せば 1 回だけ再試行 */
    onUnauthorized?: () => Promise<boolean>;
  };

  queue?: {
    maxAttempts?: number;          // 既定 10（上限5分に到達してから打ち切る回数）
    backoff?: BackoffOptions;      // 既定 { baseMs: 2000, factor: 2, maxMs: 300_000, jitter: 'full' }
    concurrency?: number;          // 同時実行ジョブ数。既定 1
    attachmentConcurrency?: number;// 1ジョブ内の画像同時アップロード数。既定 2（弱電界時は自動で 1）
    pollIntervalMs?: number;       // 既定 60_000
    autoStart?: boolean;           // 既定 true
    purgeSucceededAfterMs?: number;// 既定 7日
  };

  image?: CompressImageOptions;    // アプリ既定の圧縮設定
  logger?: FieldLogger;
  onEvent?: (e: FieldCoreEvent) => void; // 監視・計測フック
}

export function configureFieldCore(config: FieldCoreConfig): FieldCore;
export function getFieldCore(): FieldCore;

export interface FieldCore {
  queue: OfflineQueue;
  network: NetworkStatusStore;
  files: FileUrlResolver;   // 閲覧用URLの都度発行（§2.4.5）
  storage: StorageInfo;     // IndexedDB 使用量
  destroy(): Promise<void>;
}
```

アプリ側は Supabase を意識せずに初期化できる:
```tsx
configureFieldCore({
  appId: 'pf-setsubi',
  endpoints: { submit: { 'setsubi.inspection': '/api/inspections' } },
  auth: { getHeaders: async () => ({ Authorization: `Bearer ${await getAccessToken()}` }) },
});
```

### 2.2 画像圧縮 — `@palomapf-dev/pf-field-core/image`

（rev.1 から変更なし）

```ts
export interface CompressImageOptions {
  maxEdge?: number;                 // 既定 1440（1280〜1600 の中央値）
  quality?: number;                 // 既定 0.75
  targetBytes?: { min: number; max: number } | false;  // 既定 { min: 200_000, max: 400_000 }
  qualityRange?: { min: number; max: number };         // 既定 0.45 / 0.85
  maxPasses?: number;               // 既定 4
  mimeType?: 'image/jpeg' | 'image/webp';
  useWorker?: boolean;              // 既定 true
  signal?: AbortSignal;
  onProgress?: (p: { phase: 'decode' | 'resize' | 'encode'; pass: number }) => void;
}

export interface CompressedImage {
  blob: Blob;
  width: number; height: number; bytes: number;
  quality: number; passes: number;
  original: { bytes: number; width: number; height: number; type: string };
  orientation: number;              // 検出した EXIF Orientation (1..8)
  capturedAt?: number;              // EXIF DateTimeOriginal（撮影時刻の証跡）
  renderer: 'offscreen-worker' | 'offscreen-main' | 'canvas';
  durationMs: number;
}

export function compressImage(input: Blob | File, options?: CompressImageOptions): Promise<CompressedImage>;
export function compressImages(inputs: (Blob | File)[], options?: CompressImageOptions): Promise<CompressedImage[]>;
export function readExifOrientation(input: Blob): Promise<number>;
export function getImageCapabilities(): { /* ... */ };
```

**アルゴリズム**

1. `createImageBitmap(blob, { imageOrientation: 'from-image' })` で回転込みデコード。
   非対応時のみ `exif.ts` で Orientation を読み、canvas の transform で自前補正。
   `createImageBitmap` 自体が無ければ `<img>` + `URL.createObjectURL` にフォールバック。
2. 長辺 `maxEdge` に合わせて縮小（拡大はしない）。縮小率が 1/2 を大きく下回るときは2段階縮小。
3. `OffscreenCanvas.convertToBlob({ type, quality })`。無ければ `HTMLCanvasElement.toBlob`。
4. `targetBytes` レンジ外なら品質を二分探索（最大 `maxPasses` 回）。
   下限品質でも超える場合は長辺を 0.85 倍して 1 回だけ再試行。それでも駄目なら
   「品質下限で出せたサイズ」をそのまま返す（失敗にはしない）。
5. Worker 実行時は Blob を transfer し、メインスレッドを止めない。

**EXIF の扱い**: canvas 再エンコードで EXIF は落ちる（位置情報が残らない点はむしろ望ましい）。
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

export type QueueJobPhase = 'signing' | 'uploading' | 'submitting';

export interface QueueAttachmentInput {
  attachmentId?: string;           // 省略時 UUID
  blob: Blob | File;
  fileName: string;
  contentType?: string;            // 既定は blob.type
  role?: string;                   // 'before' | 'after' | 'defect' などアプリ定義
  compress?: CompressImageOptions | false;
  meta?: Record<string, unknown>;
}

export interface QueueJobInput<P = unknown> {
  jobId?: string;                  // クライアント発行 UUID = 冪等キー
  type: string;                    // 'setsubi.inspection' 等
  payload: P;
  attachments?: QueueAttachmentInput[];
  submitUrl?: string;
  maxAttempts?: number;
  priority?: number;               // 大きいほど先。既定 0
  label?: string;                  // UI 一覧用の表示名
  meta?: Record<string, unknown>;
}

export interface QueueAttachment {
  attachmentId: string;
  fileName: string; contentType: string; bytes: number;
  role?: string;
  status: 'pending' | 'uploaded' | 'failed';
  /** アップロード完了後に確定する、保存先の論理参照（プロバイダ非依存） */
  ref?: StoredObjectRef;
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
  unsent: number;                  // 未送信バッジの数 = pending + active + failed + blocked
  total: number;
  oldestPendingAt: number | null;  // 「最古 2時間前」の表示に使う
}

export interface OfflineQueue {
  enqueue<P>(input: QueueJobInput<P>): Promise<QueueJob<P>>;
  get(jobId: string): Promise<QueueJob | undefined>;
  list(filter?: { status?: QueueJobStatus[]; type?: string[]; limit?: number; offset?: number }): Promise<QueueJob[]>;
  counts(): Promise<QueueCounts>;
  flush(opts?: { force?: boolean; jobIds?: string[]; signal?: AbortSignal }): Promise<FlushResult>;
  retry(jobId: string): Promise<void>;
  retryAll(opts?: { includeBlocked?: boolean }): Promise<void>;
  cancel(jobId: string): Promise<void>;
  remove(jobId: string): Promise<void>;
  purgeSucceeded(olderThanMs?: number): Promise<number>;
  /** 未送信一覧のサムネイル表示用（ローカルの Blob を返す） */
  getAttachmentBlob(jobId: string, attachmentId: string): Promise<Blob | undefined>;
  start(): void;
  stop(): void;
  subscribe(listener: (snapshot: QueueSnapshot) => void): () => void;
}
```

**送信ランナーの流れ（1ジョブあたり）**

```
pending
  └─ ロック取得（Web Locks: 'pf-field-runner'）
  └─ 到達性プローブ OK?  ── NG → 何もせず終了（状態は pending のまま）
  └─ auth.getHeaders()
  └─ phase='signing'     storage.createUploadTargets() — 未アップロードの添付ぶんだけ
  └─ phase='uploading'   storage.upload() を順に。成功した添付は即 ref を保存
  │                      （途中で圏外になっても、次回は残りだけ送る）
  └─ phase='submitting'  submit.send(job, refs) — Idempotency-Key: jobId
  └─ 2xx → succeeded / 409(既存) → succeeded 扱い
     5xx・ネットワーク → attempts++、nextAttemptAt = backoff() → pending
     401/403 → onUnauthorized() で1回だけ再試行、駄目なら blocked(auth)
     400/422 → blocked(validation)
     attempts >= maxAttempts → failed
```

**バックオフ**: `delay = random(0, min(maxMs, baseMs * factor^(attempts-1)))`（full jitter）。
既定で 2s → 4s → 8s → … → 上限 5分、**10回**で打ち切り（合計およそ18分半）。
端末が何十台も同時に復帰したときサーバを殴らないよう jitter は必須。

回数を 10 にしているのは、**上限まで伸びきってから諦めさせる**ため。
2秒から倍々だと 5分に届くのは9回目なので、8回で切ると `maxMs` に一度も到達せず設定が死ぬ。

**圏外は試行回数を消費しない。** 送信ランナーは到達性を先に確かめ、届かないときは
ジョブに触れず `pending` のまま戻る。したがってこの18分半は
「サーバには届くが失敗し続けている」時間であり、建屋の奥に長時間いたことで
ジョブが `failed` に落ちることはない。

**排他制御**: `navigator.locks.request('pf-field-runner', { ifAvailable: true })`。
複数タブ + Service Worker が同時に走っても 1 つだけが動く。
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
| Periodic Background Sync | 任意 | PWA インストール＋利用実績が要るので保険扱い |

**冪等性**: `jobId`（クライアント UUID）を `Idempotency-Key` ヘッダと body 両方に入れる。
サーバは `client_job_id` に UNIQUE 制約を張り、重複時は既存レコードを 200/409 で返す。
「送信は成功したがレスポンスが届かなかった」ケースは弱電界では日常的に起きるので必須。

**ストレージ**: object store は `jobs` / `blobs` / `meta` の 3 本。
Blob を job レコードから分離することで、一覧表示のたびに数MBを読まずに済む。
`navigator.storage.persist()` を初期化時に要求し、`estimate()` で残量を監視。
enqueue 時に残量不足なら `QuotaExceededError` を投げて UI に出す（黙って落とさない）。
成功ジョブは既定 7日後に自動 purge。

---

### 2.4 ストレージ抽象 — `@palomapf-dev/pf-field-core/storage`

ストレージは**将来また差し替わる前提**で、2つの継ぎ目に分ける。

```
端末（ブラウザ / Service Worker）        サーバ（Next.js Route Handler）
┌──────────────────────────┐        ┌──────────────────────────────┐
│ 送信ランナー               │        │ createSignUploadRouteHandler │
│   ↓                       │  HTTP  │   ↓                          │
│ StorageAdapter ◄──────────┼───────►│ StorageProvider              │
│  ├ httpSigned (既定)       │        │  ├ supabaseStorageProvider   │ ← ここだけ
│  ├ supabaseDirect (任意)   │        │  ├ s3StorageProvider         │   差し替える
│  └ memory (テスト用)       │        │  └ (将来の実装)               │
└──────────────────────────┘        └──────────────────────────────┘
```

**既定構成では、端末側は Supabase を一切知らない。**
`httpSigned` アダプタは「サーバから受け取った `UploadTarget` 記述子どおりに HTTP 転送する」だけ。
Supabase → 別プロバイダの差し替えは、サーバ側の `providers/*.ts` を1つ入れ替えるだけで完了する。
副次的な利点として、`@supabase/supabase-js` を端末バンドルにも Service Worker にも入れずに済む。

#### 2.4.1 共通の型

```ts
/** 保存先の論理参照。ジョブに永続化され、submit でサーバへ渡る */
export interface StoredObjectRef {
  provider: string;                  // 'supabase' | 's3' | ...
  bucket: string;
  path: string;                      // バケット内のパス
  contentType?: string;
  bytes?: number;
  extra?: Record<string, unknown>;   // プロバイダ固有の追加情報
}

/** 「この URL へこう投げれば保存される」という転送指示。プロバイダ非依存 */
export interface UploadTarget {
  attachmentId: string;
  ref: StoredObjectRef;
  request: {
    url: string;
    method: 'PUT' | 'POST';
    headers?: Record<string, string>;
    /** 'binary' = Blob をそのまま body に / 'form-data' = FormData に包む */
    bodyMode: 'binary' | 'form-data';
    formFields?: Record<string, string>;  // S3 POST policy / Supabase の互換用
    fileFieldName?: string;               // form-data 時のフィールド名。既定 'file'
  };
  expiresAt: number;
  /** 期限切れ・403 のとき再発行してよいか。既定 true */
  reissuable?: boolean;
}
```

この記述子は S3 の PUT / POST policy、Supabase の署名付きアップロード、
Azure SAS、GCS の resumable いずれも表現できる粒度にしてある。

#### 2.4.2 StorageAdapter（端末側の継ぎ目）

```ts
export interface StorageAdapter {
  readonly name: string;

  /** 送信直前に呼ばれる。アップロード先の記述子を得る */
  createUploadTargets(
    req: { jobId: string; jobType: string; files: UploadFileDescriptor[] },
    ctx: AdapterContext,
  ): Promise<UploadTarget[]>;

  /**
   * 記述子に従って実際に転送する。
   * 省略すると既定 transport（XHR / fetch 自動切替）が使われるので、
   * 通常のプロバイダはここを実装しなくてよい。
   */
  upload?(target: UploadTarget, blob: Blob, ctx: UploadContext): Promise<UploadResult>;

  /** 閲覧用URLの都度発行 */
  createViewUrls?(refs: StoredObjectRef[], opts?: { ttlSec?: number }): Promise<ResolvedUrl[]>;

  /** ジョブ破棄時の後始末（任意） */
  remove?(refs: StoredObjectRef[]): Promise<void>;
}

export interface UploadFileDescriptor {
  attachmentId: string; fileName: string; contentType: string; bytes: number; role?: string;
}
export interface AdapterContext { headers: Record<string, string>; signal?: AbortSignal }
export interface UploadContext extends AdapterContext { onProgress?(loaded: number, total: number): void }
export interface UploadResult { ref: StoredObjectRef; bytes: number; durationMs: number }
export interface ResolvedUrl { ref: StoredObjectRef; url: string; expiresAt: number }
```

**組み込み実装**

```ts
/** 既定。プロバイダ非依存。SW でも動く（supabase-js 不要） */
export function createHttpSignedStorageAdapter(o?: {
  signEndpoint?: string;      // 既定 '/api/uploads/sign'
  viewEndpoint?: string;      // 既定 '/api/files/sign-view'
}): StorageAdapter;

/** 変種。端末から supabase-js で直接 createSignedUploadUrl() を呼ぶ */
export function createSupabaseStorageAdapter(o: {
  client: SupabaseClient;
  bucket: string;
  buildPath?(ctx: PathContext): string;
}): StorageAdapter;

/** テスト用 */
export function createMemoryStorageAdapter(): StorageAdapter & { objects: Map<string, Blob> };
```

`createSupabaseStorageAdapter` は「差し替えられること」の実証と、
Route Handler を置きたくないアプリ向けの逃げ道として用意する。ただし
**既定は `httpSigned` を推奨**する — パス命名規約・拡張子/サイズ検証・監査ログを
サーバ1箇所に集約でき、端末バンドルと SW を軽く保てるため。

#### 2.4.3 転送レイヤ（`transport.ts`）

`UploadTarget.request` を実行するだけの共通実装。

- **ページ内**: `XMLHttpRequest` を使い `upload.onprogress` でバイト単位の進捗を取る。
- **Service Worker 内**: XHR が存在しないので `fetch`。進捗はファイル単位に落ちる。
- この切替は実行コンテキストを見て自動。呼び出し側は意識しない。
- タイムアウト（既定 60秒）、`AbortSignal`、`reissuable` な 403/期限切れ時の**1回だけ再署名**を担当。

> **M3 で必ず確定させること**: Supabase の署名付きアップロードエンドポイント
> （`PUT /storage/v1/object/upload/sign/{bucket}/{path}?token=...`）が要求する
> ボディ形式（生バイナリ / multipart FormData）と必須ヘッダを、実エンドポイントと
> `supabase-js` の実装に突き合わせて `bodyMode` を確定する。
> 想定が外れる場合は `StorageAdapter.upload` を実装して `uploadToSignedUrl()` に委譲し、
> **進捗をファイル単位に落として機能自体は成立させる**（フォールバック経路を先に用意しておく）。

#### 2.4.4 StorageProvider（サーバ側の継ぎ目）— `@palomapf-dev/pf-field-core/server`

```ts
export interface StorageProvider {
  readonly name: string;
  createUploadTargets(req: SignUploadRequest, ctx: ServerContext): Promise<UploadTarget[]>;
  createViewUrls(refs: StoredObjectRef[], opts: { ttlSec: number }, ctx: ServerContext): Promise<ResolvedUrl[]>;
  remove?(refs: StoredObjectRef[], ctx: ServerContext): Promise<void>;
}

export function supabaseStorageProvider(o: {
  bucket: string;               // 4アプリ共用 'field-uploads'
  /** 既定は env の SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY から生成 */
  client?: SupabaseClient | ((ctx: ServerContext) => Promise<SupabaseClient>);
  /** 既定 `${appId}/${jobType}/${yyyy}/${mm}/${jobId}/${attachmentId}.${ext}` */
  buildPath?(ctx: PathContext): string;
  viewUrlTtlSec?: number;      // 既定 300
  upsert?: boolean;            // 既定 false（§2.4.6 の 409 扱いとセット）
  /** createSignedUrl の画像変換。プラン要件があるので既定は無効 */
  transform?: { width?: number; height?: number; quality?: number };
}): StorageProvider;

export function s3StorageProvider(o: { /* bucket, region, client, expiresInSec ... */ }): StorageProvider;
```

**Route Handler**

```ts
export function createSignUploadRouteHandler(o: {
  provider: StorageProvider;
  authorize(req: Request): Promise<AuthContext>;    // throw すれば 401
  maxBytes?: number;             // 既定 8 * 1024 * 1024
  maxFilesPerRequest?: number;   // 既定 20
  allowedContentTypes?: string[];// 既定 ['image/jpeg','image/webp','image/png','application/pdf']
}): (req: Request) => Promise<Response>;

export function createSignViewRouteHandler(o: {
  provider: StorageProvider;
  authorize(req: Request): Promise<AuthContext>;
  ttlSec?: number;               // 既定 300
  maxRefsPerRequest?: number;    // 既定 100
}): (req: Request) => Promise<Response>;
```

アプリ側の実装:
```ts
// app/api/uploads/sign/route.ts
import { createSignUploadRouteHandler, supabaseStorageProvider } from '@palomapf-dev/pf-field-core/server';
import { getSessionWithRole } from '@/lib/session';   // 既存の next-auth セッション

export const POST = createSignUploadRouteHandler({
  // SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY から自動でクライアントを作る
  provider: supabaseStorageProvider({ bucket: 'field-uploads' }),
  // ★ 認可の実体はここ。service_role は RLS を迂回するため、この関数が唯一の防壁になる
  authorize: async () => {
    const s = await getSessionWithRole();
    if (!s) throw new UnauthorizedError();
    return { userId: s.userId, tenantId: s.companyId };
  },
});
```
**ストレージを差し替えるときに変わるのは、この `supabaseStorageProvider(...)` の1行だけ。**
将来 S3 に戻すなら `s3StorageProvider({ bucket, region })` に置き換えるだけで、
端末側のコードも `authorize` も変わらない。

#### 2.4.5 閲覧用URL（`createSignedUrl` の都度発行）

バケットは非公開なので、表示のたびに短命な署名付きURLを発行する。

```ts
// コア
export interface FileUrlResolver {
  resolve(ref: StoredObjectRef, opts?: { ttlSec?: number }): Promise<string>;
  resolveMany(refs: StoredObjectRef[], opts?: { ttlSec?: number }): Promise<ResolvedUrl[]>;
  invalidate(ref?: StoredObjectRef): void;
}

// React
export function useSignedUrl(ref: StoredObjectRef | undefined): { url: string | null; loading: boolean; error: Error | null };
export function useSignedUrls(refs: StoredObjectRef[]): { urls: Map<string, string>; loading: boolean };
```

実装上のポイント:
- **バッチ発行**。一覧画面でサムネイル30枚を出すのに30リクエストは出さない。
  同一 tick 内の要求をまとめ、サーバ側は `createSignedUrls()`（複数パス版）で1往復にする。
- **メモリキャッシュ + 期限マージン**。TTL 300秒に対し 60秒前から再発行する。
- URL はトークンを含むので **localStorage 等に永続化しない**。
- 圏外では発行できない。オフライン時は「未送信ジョブのローカル Blob」を
  `queue.getAttachmentBlob()` で表示するようフォールバックする（送信済み画像は表示不可＝仕様）。

#### 2.4.6 Supabase 固有の設計判断

| 論点 | 判断 |
|---|---|
| バケット | `field-uploads` を4アプリ共用、パス第1階層を `appId` で分ける。RLS ポリシーを1本に保てる。アプリ別に分ける案は運用負荷が4倍になるので採らない（要合意） |
| 公開設定 | **非公開**（`public: false`）。読み書きとも署名付きURL経由のみ |
| 署名の発行者 | **`SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` を使ったサーバー側発行**。理由は `docs/auth-findings.md` §4-1 — 認証は next-auth(JWT) + ポータルSSO であり、**リクエストに Supabase JWT が載らない**ため RLS はユーザーを識別できない |
| 認可の実体 | Route Handler の `authorize()`（＝各アプリの `requireSession()` / `getSessionWithRole()`）。service_role は RLS を迂回するので、**ここが唯一の防壁**になる |
| RLS の役割 | `anon` / `authenticated` には INSERT / SELECT とも**一切許可しない default deny**。第2層として置く（anon キーが漏れても直接は触れない）。将来 Supabase Auth に寄せたらユーザーJWT + RLS 判定へ切り替えられるよう、`StorageProvider.client` は関数も受け付ける形にしてある |
| 署名URLの性質 | 署名付きURLは**使用時点では RLS を迂回する**。チェックが効くのは発行時だけなので、`authorize()` とサーバー側パス生成が防衛線のすべて |
| パス生成 | **クライアントが指定したパスは絶対に使わない**。サーバが `appId/jobType/yyyy/mm/jobId/attachmentId.ext` を組み立てる。パストラバーサルと他ユーザー領域への上書きを構造的に防ぐ |
| 種別・サイズ制限 | バケットの `allowed_mime_types` / `file_size_limit` を設定し、加えて Route Handler でも検証（二重）|
| 再試行時の衝突 | パスは jobId/attachmentId 由来で決定的。「実は前回アップロードが成功していた」再試行は **409 を成功として扱う**。`upsert: true` は上書きを許すことになるので採らない |
| アップロードURL期限 | Supabase 既定で約2時間。発行時に指定できるかは M3 で確認する（できなくても「送信直前に発行」なので影響しない） |
| 巨大ファイル | 200〜400KB 前提なので TUS（resumable）は使わない。必要になればアダプタ内で対応可能 |
| CORS | Supabase 側で処理されるためバケットCORS設定は不要（S3 案からの純減） |

**必要な RLS ポリシー**（`docs/supabase-setup.md` に詳細を書く）

発行は service_role が行うので、一般ロールには**何も許可しない**のが正解。
「ポリシーを書かない」＝ RLS 有効下では default deny なので、明示的に確認だけする。

```sql
-- storage.objects は既定で RLS 有効。field-uploads に対する
-- anon / authenticated 向けポリシーは「1本も作らない」ことを意図とする。
-- （既存の緩いポリシーが無いことを必ず確認する）
select polname, polroles::regrole[], polcmd
from pg_policy
where polrelid = 'storage.objects'::regclass;

-- バケット側の防御（Route Handler の検証と二重）
update storage.buckets
   set public = false,
       file_size_limit = 8388608,                     -- 8MB
       allowed_mime_types = array['image/jpeg','image/webp','image/png','application/pdf']
 where id = 'field-uploads';
```

> `SUPABASE_SERVICE_ROLE_KEY` の中身は Supabase の新形式 Secret key（`sb_secret_` 始まり）。
> 変数名は設定済みの環境に合わせて据え置く（実装は `SUPABASE_SECRET_KEY` も別名として受け付ける）。
> **サーバー環境変数としてのみ**扱う。
> `NEXT_PUBLIC_` を付けない、クライアントコンポーネントから import しない、
> ログに出さない。`./server` サブパス以外から参照しないことをテストで担保する。

#### 2.4.7 レコード送信の継ぎ目（DB 移行を見越して）

DB も Supabase へ移行予定のため、レコード本体の送信先も薄く抽象化しておく。

```ts
export interface SubmitAdapter {
  readonly name: string;
  send(job: QueueJob, refs: StoredObjectRef[], ctx: AdapterContext): Promise<SubmitResult>;
}
export interface SubmitResult { ok: true; serverId?: string; duplicated?: boolean }

/** 既定：現行の Next.js Route Handler へ POST（Idempotency-Key 付き） */
export function httpSubmitAdapter(o?: { endpoints?: ... }): SubmitAdapter;

/** 将来：Supabase RPC を直接呼ぶ（1トランザクション・RLS 準拠・PostgREST 経由） */
export function supabaseRpcSubmitAdapter(o: {
  client: SupabaseClient;
  fn: Record<string, string>;   // jobType → Postgres 関数名
}): SubmitAdapter;
```

移行後は Postgres 関数側で `insert ... on conflict (client_job_id) do nothing returning id` と書けば、
冪等性がDB1本で担保できる。**当面の既定は `httpSubmitAdapter`** とし、
移行のタイミングで各アプリが1行差し替える。

---

### 2.5 Service Worker — `@palomapf-dev/pf-field-core/sw`

アプリ側は薄い `worker/sw.ts` を置くだけ:
```ts
import { createFieldServiceWorker } from '@palomapf-dev/pf-field-core/sw';

createFieldServiceWorker({
  appId: 'pf-setsubi',
  version: process.env.NEXT_PUBLIC_BUILD_ID!,
  precache: self.__PF_PRECACHE__,
  appShell: {
    /**
     * ★ 認証済みページはプリキャッシュしない（docs/auth-findings.md §4-5）。
     * pf-setsubi の middleware が対象ページに `Cache-Control: private, no-store` を付けており、
     * 会社スコープのデータを端末キャッシュに残す設計と衝突するため。
     * プリキャッシュするのは機微情報を含まない静的ページだけ。
     */
    strategy: 'network-first',
    precacheRoutes: ['/offline'],
    navigationFallback: '/offline',
  },
  api: {
    strategy: 'network-first',
    timeoutMs: 3000,
    include: [/^\/api\//],
    cacheable: [/^\/api\/master\//, /^\/api\/equipments/],
    exclude: [/^\/api\/uploads\//, /^\/api\/files\//, /^\/api\/auth\//],
    maxAgeMs: 24 * 60 * 60 * 1000,
  },
  /** 署名付きURLで取得した画像のキャッシュ（トークンを鍵から除去して正規化） */
  signedMedia: {
    include: [/\/storage\/v1\/object\/sign\//],
    normalizeCacheKey: 'strip-query',
    maxEntries: 300,
  },
  queue: { syncTag: 'pf-field-queue', enablePeriodicSync: false },
  skipWaiting: false,
});
```

**キャッシュ戦略**
| 対象 | 戦略 | 理由 |
|---|---|---|
| `/_next/static/**`（ハッシュ付き） | Cache First（永続） | 内容不変。機微情報を含まない |
| `/offline`（静的シェル） | Cache First + バージョン更新時に入替 | 圏外でもここまでは必ず開く。未送信一覧と再送への導線を置く |
| **認証済みページのナビゲーション** | **Network First → 失敗時 `/offline`（HTML はキャッシュしない）** | middleware の `private, no-store` と整合させる。会社スコープのHTMLを端末に残さない |
| `/api/master/**` 等の参照系 | Network First（3秒タイムアウト）→ キャッシュ | 弱電界で30秒待たされるのを防ぐ |
| **`/api/uploads/**`, `/api/files/**`, `/api/auth/**`** | **キャッシュしない** | 署名URL・認証をキャッシュしてはいけない |
| Supabase の署名付きメディアURL | Cache First（クエリを除いた正規化キー）| **URL にトークンが載るため、そのままだと毎回キャッシュミス＋際限なく肥大する**。パス部分だけを鍵にすれば同じ画像が再利用される |

`signedMedia` の正規化は Supabase 化で新しく必要になった処理。
`?token=...` を鍵から落とし、レスポンス本体（画像バイト）だけを再利用する。
**期限切れレスポンス（400/403）は絶対にキャッシュしない**。

**ビルド**: `pf-field-sw build` CLI（esbuild）を各アプリの `prebuild` で回し、
`worker/sw.ts` → `public/sw.js` と precache manifest を生成する。

**注意**: `skipWaiting: false` を既定にする。点検入力の途中で SW が入れ替わって
ページがリロードされる事故を防ぐ。更新は UI で明示的に促す。

### 2.6 DataWedge 連携 — `@palomapf-dev/pf-field-core/scanner`

（rev.1 から変更なし）

```ts
export interface ScanEvent {
  data: string; raw: string;
  source: 'keyboard' | 'bridge' | 'manual';
  symbology?: string;
  receivedAt: number; durationMs: number;
}

export interface ScannerOptions {
  enabled?: boolean;
  minLength?: number;                      // 既定 4
  maxIntervalMs?: number;                  // 既定 40
  terminator?: 'Enter' | 'Tab' | RegExp;   // 既定 'Enter'
  prefix?: string; suffix?: string;
  ignoreWhileTyping?: boolean;             // 既定 true
  target?: RefObject<HTMLElement> | Document;
  normalize?(raw: string): string;
  validate?(data: string): boolean;
  onInvalid?(raw: string): void;
}

export function createScannerListener(o: ScannerOptions & { onScan(e: ScanEvent): void }):
  { start(): void; stop(): void; simulate(data: string): void };
export function useDataWedgeScanner(o: ScannerOptions & { onScan(e: ScanEvent): void }):
  { lastScan: ScanEvent | null; isListening: boolean; simulate(data: string): void };
```

**判別ロジック**: `keydown` を蓄積し、(a) 連続キーの間隔がすべて `maxIntervalMs` 以下、
(b) 長さが `minLength` 以上、(c) `terminator` で終端 — の3条件でスキャンと判定。
`prefix`/`suffix` があればそちらを優先（決定的なので誤検知ゼロ）。
**運用としては DataWedge プロファイルで prefix/suffix を付ける設定を推奨**し、
手順を `docs/datawedge-profile.md` に書く。ヒューリスティックは保険。

### 2.7 React バインディング — `@palomapf-dev/pf-field-core/react`

内部は `useSyncExternalStore` で実装。React 18/19・Next.js App Router で安全に動く。

```tsx
export function FieldCoreProvider(props: { config: FieldCoreConfig; children: ReactNode }): JSX.Element;

export function useOfflineQueue(filter?: QueueFilter): {
  counts: QueueCounts; jobs: QueueJob[];
  isSyncing: boolean; lastSyncAt: number | null; lastError: QueueError | null;
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
  isCompressing: boolean; progress: { done: number; total: number }; error: Error | null;
};

/** 閲覧用の署名付きURL（都度発行 + バッチ + キャッシュ） */
export function useSignedUrl(ref: StoredObjectRef | undefined): { url: string | null; loading: boolean; error: Error | null };
export function useSignedUrls(refs: StoredObjectRef[]): { urls: Map<string, string>; loading: boolean };

export function useServiceWorkerUpdate(): {
  registration: ServiceWorkerRegistration | null;
  updateAvailable: boolean;
  applyUpdate(): Promise<void>;
};
```

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
| 2 | `package.json` | `@palomapf-dev/pf-field-core` / `@supabase/supabase-js` 追加、`"prebuild": "pf-field-sw build"` |
| 3 | 環境変数（Vercel） | **`SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY`** — ともに**サーバ専用**。`NEXT_PUBLIC_` を付けない。<br>加えて GitHub Packages 読み取りトークン |
| 4 | — | アプリ側に `lib/supabase.ts` は**不要**。`./server` が env から直接クライアントを作る。<br>端末側は Supabase を知らない（§2.4 の既定構成）|
| 5 | `app/providers.tsx`（新規） | `"use client"` + `<FieldCoreProvider config={...}>` |
| 6 | `app/layout.tsx` | Provider で包む / `manifest` リンク / SW 登録コンポーネント配置 |
| 7 | `worker/sw.ts`（新規） | `createFieldServiceWorker({...})` 数行 |
| 8 | `next.config.js` | `/sw.js` に `Cache-Control: no-cache` + `Service-Worker-Allowed: /` ヘッダ |
| 9 | `public/manifest.webmanifest` + アイコン（新規） | PWA 化。Background Sync / persist の前提 |
| 10 | `app/offline/page.tsx`（新規） | 圏外フォールバック画面 |
| 11 | `app/api/uploads/sign/route.ts`（新規） | `createSignUploadRouteHandler({ provider: supabaseStorageProvider(...) })` |
| 12 | `app/api/files/sign-view/route.ts`（新規） | `createSignViewRouteHandler(...)` — 閲覧用URLの都度発行（バッチ対応）|
| 13 | `app/api/health/route.ts`（新規） | 到達性プローブ用の軽量エンドポイント |
| 14 | **既存の登録系 API** | `Idempotency-Key` を受理し、`client_job_id` UNIQUE で重複を吸収。<br>画像は multipart 受信ではなく **`StoredObjectRef[]`** を受け取る形に変更 |
| 15 | **DB マイグレーション** | 各レコードテーブルに `client_job_id`（UNIQUE）と `captured_at`、添付は `bucket` + `path` を保持（URL は保存しない — 署名URLは短命なため）|
| 16 | 送信フォーム | `fetch(...)` 直呼びを `queue.enqueue(...)` に置換。<br>「送信しました」→「送信予約しました（未送信 N 件）」へ文言変更 |
| 17 | 画像表示箇所 | 直リンク／公開URL前提の実装を `useSignedUrl()` / `useSignedUrls()` に置換 |
| 18 | ヘッダ / グローバルUI | 未送信バッジ + オフライン表示 + 手動再送ボタン |
| 19 | 未送信一覧画面（新規） | ジョブ一覧・エラー理由・個別再送・破棄。`blocked` の救済導線 |
| 20 | CSP（設定していれば） | `worker-src 'self'` / `connect-src` に `https://<project>.supabase.co` 追加 |
| 21 | **既存 `@vercel/blob` からの移行** | `api/upload/media/route.ts` を `createSignUploadRouteHandler` に置換。添付テーブルに `bucket` / `path` 追加。`<img src={d.blobUrl}>` を `useSignedUrl()` に置換。**既存データは `provider: 'vercel-blob'` として並存**させ移行バッチは書かない（`docs/auth-findings.md` §4-6）|
| 22 | **無操作ログアウトとの調停** | 未送信ジョブがある間は `@paloma-pf/ui` の `useIdleLogout` を抑止する（要 pf-ui 変更）。ログアウト直前に `queue.flush()` を試みる。→ `docs/auth-findings.md` §4-3、**要判断** |
| 23 | 再ログイン導線 | `blocked(auth)` のジョブ向けに「再ログイン → `queue.retryAll({ includeBlocked: true })`」の導線を用意（12時間超の滞留は自動回復できないため）|

> S3 案からの純減: バケットCORS設定・IAMポリシー・AWS 認証情報の配布が不要になった。
> 純増: 署名付きメディアのキャッシュキー正規化、閲覧URLの都度発行導線、
> **既存 Vercel Blob との並存**（21）と**無操作ログアウトの調停**（22）。
> 21・22 は認証実装の調査で新たに判明した項目で、当初見積に無かった。

### 3.2 アプリ横断のインフラ変更

- **Supabase プロジェクト**: 東京リージョン。4アプリ共用。
- **バケット**: `field-uploads` を**非公開**（`public: false`）で作成。
  `file_size_limit = 8MB`、`allowed_mime_types = [image/jpeg, image/webp, image/png, application/pdf]`。
  パス第1階層を `appId` にしてアプリを分離する（§2.4.6）。
- **RLS**: `storage.objects` の `field-uploads` に対して **anon / authenticated 向けのポリシーを1本も作らない**
  （＝ default deny）。発行は service_role が行う。既存の緩いポリシーが無いことを `pg_policy` で確認する。
- **環境変数（Vercel、4アプリ共通）**: `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY`。
  **どちらもサーバ専用**。`NEXT_PUBLIC_` を付けず、Preview/Production の両環境に設定する。
- **HTTPS**: ✅ 確認済み。全アプリが `*.paloma-pf.com`（Vercel）で有効な証明書。
  Service Worker の secure context 要件を満たす。
- **認証の有効期限**: ⚠️ 調査済み（`docs/auth-findings.md`）。**Supabase Auth ではない。**
  ポータルSSO（HMAC・TTL 60秒）+ 各アプリ next-auth v4（JWT / `maxAge` 12時間 / `updateAge` 15分）。
  **リフレッシュトークンは無い**ため、12時間を超える圏外滞留は復帰時に 401 → `blocked(auth)` となり
  自動回復できない。再ログイン → `retryAll({ includeBlocked: true })` の導線で救済する（M4 必須）。
  さらに**無操作自動ログアウト（共用端末15分 / 個人端末60分）**が実務上の最大リスク（§5-8 で要判断）。
- **DB**: 現行は **Neon**（4アプリとも）。Supabase Postgres への移行は予定段階。
  ストレージだけ先行して Supabase に寄せると一時的に2ベンダー並存になる（§6 で要確認）。
- **東京リージョン**: 工場からのレイテンシは有利。ただし建屋内の弱電界がボトルネックなので、
  タイムアウト値はリージョンではなく実測で決める（M3 の実機計測項目）。

### 3.3 アプリ別に想定される差分

| アプリ | 想定ジョブ種別 | 特記 |
|---|---|---|
| pf-setsubi | 点検結果 + 現場写真（複数枚） | 添付枚数が最多。1ジョブ 5〜10枚を想定した進捗UIが要る |
| pf-hinshitsu | 不良報告 + 不良部位写真 | 不良箇所の判別があるため圧縮を強くしすぎない（`maxEdge: 1600` を検討）|
| pf-zaiko | 棚卸カウント（写真少なめ / 件数多め）| スキャン主体。ジョブ件数が数百単位になる想定 |
| pf-keisoku | 計測値 + 計器写真 | 数値の桁落ち防止でバリデーションを enqueue 前に必ず通す |

---

## 4. 実装順序とマイルストーン

縦切り（1機能を端から端まで通す）を優先し、**M4 の時点で pf-setsubi に実地投入できる**状態を作る。

| M | 内容 | 完了条件 |
|---|---|---|
| **M0** ✅ | 基盤整備（pnpm workspace / tsup / vitest / playwright / changesets / CI / GitHub Packages publish / playground） | `0.0.1` が publish でき、playground から import できる |
| **M1** ✅ | 画像圧縮（EXIF / 向きの焼き込み / 品質の二分探索 / 実機計測ページ）| 下記「M1 の結果」参照。Worker オフロードのみ **M1b** へ延期 |
| **M1b** | Worker オフロード（実測しだい）| 実機で `/bench` の「メインスレッドの詰まり」が実用に耐えない場合のみ着手 |
| **M2** | 永続化 + キュー骨格（`db/`, `queue/`）| fake-indexeddb の単体テストが通る。状態遷移が網羅テスト済み |
| **M3** | **ストレージ抽象 + Supabase 実装 + 送信ランナー** | 下記の M3 詳細を参照 |
| **M4** | React バインディング（`react/`, Provider, `useSignedUrl`, `useDraft`）+ **pf-setsubi パイロット** | playground の UI で未送信件数・手動再送・進捗・画像表示が動く。<br>pf-setsubi で: `@vercel/blob` からの置換と `provider: 'vercel-blob'` の並存、<br>`blocked(auth)` からの再ログイン導線、無操作ログアウトの調停（§5-9）、<br>**下書きの永続化**（圏外で入力を続けられること）まで含めて実地投入 |
| **M5** | Service Worker（`sw/`, `cli/`, Background Sync, 署名メディアのキャッシュ正規化）+ **マスタのローカルキャッシュ** | アプリを閉じた状態から Background Sync で送信完了。圏外でアプリシェルが起動し、**点検入力を新規に開始できる** |
| **M6** | DataWedge | 実機で連続スキャンが取りこぼしなく拾える。手入力と誤認しない |
| **M7** | 堅牢化（quota / purge / 監視イベント / 多タブ / 障害系テスト / ドキュメント）| ストレージ逼迫・認証切れ・時計ずれで UI が正しく破綻を伝える。`1.0.0` |
| **M8** | 横展開（pf-hinshitsu / pf-zaiko / pf-keisoku）| 4アプリすべてが同一メジャーバージョンで稼働 |

**M1 の結果（2026-08-10）**

デスクトップ Chromium での実測（playground `/bench`、テスト画像6枚）:

| 指標 | 結果 |
|---|---|
| 所要時間（中央値 / 最大） | 150ms / 234ms |
| 上限 400KB 以内 | 6 / 6 |
| 向きの判定（1 / 3 / 6 / 8） | 6 / 6 一致 |
| **メインスレッドの詰まり（long task）** | **0 回 / 0ms** |

4000x3000 の写真が 1,750KB → 265KB（1440x1080・品質 0.75・エンコード1回）。

**Worker オフロードを M1b へ延期する。** `createImageBitmap` も
`OffscreenCanvas.convertToBlob` も非同期なので、メインスレッドは実測で
1ミリ秒も詰まっていない。Worker を入れると、ライブラリから worker スクリプトを
配る仕組み（`new URL(..., import.meta.url)` がアプリ側のバンドラで解決される前提）が
必要になり、壊れやすさが増える。**実機で `/bench` を回して詰まりが確認できたときだけ**入れる。

実測で見つかって直した劣化を1つ記録しておく:
1600x1200 / 195KB の写真を 1440px へ縮めて再エンコードすると **311KB に太っていた**。
縮小の効果より再エンコードの劣化のほうが大きい。
「圧縮後のほうが大きいなら元をそのまま送る」判断を入れ、E2E で見張っている。

**M1 の完了条件のうち未達**: 「実機の代表写真20枚」での確認。
これは Zebra 実機と現場写真が要るので、`/bench` を実機で開いて採取してもらう。
デスクトップの 234ms が実機で 6倍になっても 1.5 秒に収まる見込みだが、確認は要る。

**M3 の詳細**（ストレージ変更で最も重くなったマイルストーン）

| # | 作業 | 完了条件 |
|---|---|---|
| 3-a | `StorageAdapter` / `StorageProvider` / `UploadTarget` 型の確定 | `memory` アダプタでランナーの単体テストが全部通る（Supabase 不要でテストできる状態）|
| 3-b | **Supabase 署名付きアップロードの実地検証（最優先・スパイク）** | ボディ形式・必須ヘッダ・期限・409 の挙動を実エンドポイントで確認し `bodyMode` を確定。XHR で進捗が取れるか判定し、駄目なら `uploadToSignedUrl` フォールバックを実装 |
| 3-c | `supabaseStorageProvider` + 2つの Route Handler | RLS 有効な状態で発行→アップロード→閲覧が通る |
| 3-d | RLS ポリシー設計 + `docs/supabase-setup.md` | 他アプリ領域・他ユーザー領域へ書けないことをテストで確認 |
| 3-e | 送信ランナー本体 + `SubmitAdapter` | 「圏外→復帰→自動送信」「途中切断→残り添付だけ再送」「二重送信されない」が E2E で通る |
| 3-f | `s3StorageProvider`（任意） | プロバイダを1行差し替えるだけで E2E が通ることを確認＝**抽象の妥当性検証** |

3-b は**設計の前提を左右するので M3 の頭で単独スパイクとして先に片付ける**。
ここで想定が外れた場合の影響範囲（進捗表示の粒度）は事前に握っておく。

3-f は工数を使うが、「差し替えられる」という要件を口約束でなく**テストで担保**できる。
省略も可能だが、その場合は抽象が実際に効くかを M8 まで検証できない点は留意したい。

**並行できる作業**: M1 と M2 は独立なので同時進行可。
Supabase 側の準備（プロジェクト作成・バケット・RLS・既存API の冪等化・DBマイグレーション）は
M0 の時点で着手依頼を出しておく — ここが遅れると M3 が止まる。

**バージョニング**: M7 到達までは `0.x`。changesets で PR ごとに変更点を積み、
`main` マージで自動 publish。破壊的変更は 0.x の間はマイナーで出す。

---

## 5. 決定事項（2026-08-10 合意）

| # | 論点 | **決定** |
|---|---|---|
| 1 | パッケージ分割 | **単一パッケージ + サブパス exports**（`@palomapf-dev/pf-field-core`）|
| 2 | 端末側アダプタの既定 | **`httpSigned`**（サーバ経由・プロバイダ非依存）|
| 3 | バケット構成 | **`field-uploads` を4アプリ共用**、パス第1階層を `appId` で分離 |
| 4 | 署名の発行 | **`SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` でサーバ側発行**。認可は `authorize()` |
| 5 | Service Worker のビルド | **自前の薄い esbuild CLI**（`pf-field-sw build`）|
| 6 | 投入戦略 | **M4 で pf-setsubi にパイロット投入** → M8 で残り3本 |
| 7 | サーバ／Supabase 側の変更主体 | **同一チームで実施**（既存API の冪等化・マイグレーション・バケット/RLS 設定を含む）|

### 5-9. 追加論点の決定（2026-08-10）

`docs/auth-findings.md` の調査で出た3件を決定した。

#### (1) 無操作ログアウト — 「ロック + 送信専用トークンへの降格」

単純な延長・無効化はセキュリティ要件（共用端末にログインを残さない）を崩すので、
**画面の遮断とセッションの権限を分離**する。

```
無操作タイムアウト発火
  └─ queue.flush() を最大10秒試す
       ├─ 送信しきれた  → 従来どおり完全ログアウト（挙動変更なし）
       └─ 未送信が残る  → ロック画面へ + セッション Cookie を破棄
                          + 「送信専用トークン」を IndexedDB に発行
                          → 送信完了後にトークンを破棄し完全ログアウト状態へ
```

送信専用トークンの権限は**発行時点で存在した jobId の、アップロード署名発行と
レコード送信のみ**。閲覧URL発行もデータ読み取りも不可。Cookie ではないので
ambient authority にもならず、CSRF の面も増えない。

現状より弱くならない。画面は即座に隠れ、読み取り権限はむしろ完全に消える。
残るのは「すでに端末内にあるデータを送り切る」能力だけ。

| 担当 | 変更内容 |
|---|---|
| pf-ui | `useIdleLogout` に `onIdle?: () => 'logout' \| 'lock'` を追加 |
| サーバ | `POST /api/auth/flush-token` の追加、sign/submit が Bearer トークンも受理する分岐 |
| pf-field-core | ロック時の降格処理、トークンの保存と送信ランナーからの利用（M4）|

#### (2) 既存 `@vercel/blob` — 並存

`StoredObjectRef.provider` で振り分ける。移行バッチは書かない。廃止時期は後日決定。

```ts
{ provider: 'vercel-blob', bucket: '', path: '<pathname>', extra: { url } }  // 既存 → そのまま表示
{ provider: 'supabase', bucket: 'field-uploads', path: 'pf-setsubi/...' }     // 新規 → 署名URLを都度発行
```

`FileUrlResolver` は provider ごとにまとめ、**Supabase 分だけを1回のバッチで署名要求**する。
Vercel Blob の URL は公開URLなのでサーバ往復が要らない。混在一覧でも往復は1回で済む。
DB は `blob_url` を残したまま `provider` / `bucket` / `path` を追加する。

#### (3) 圏外での入力開始 — 段階を分ける

| 段階 | 範囲 |
|---|---|
| **M4** | オンラインで開始 → 圏外で入力継続 → 復帰後に送信 |
| **M5 以降** | マスタのローカルキャッシュを実装し、完全オフライン開始に対応 |

M4 に**下書きの永続化を含める**。Zebra 端末は WebView をバックグラウンドで kill するため、
胸ポケットに入れた時点で入力内容が消えると「圏外で入力継続」が成立しない。
`createDraftStore` / `useDraft`（IndexedDB・デバウンス自動保存・送信成功で破棄）を追加する。

あわせてアプリ側の制約として、**入力中に通信を要求しない**こと（次ページの取得や
マスタの遅延読み込みを入力フローの途中に置かない）を組み込み手順に明記する。

## 6. 前提の確認結果

| 前提 | 状態 | 内容 |
|---|---|---|
| HTTPS | ✅ 確定 | 全アプリ `*.paloma-pf.com`（Vercel）で有効な証明書。Service Worker 可 |
| ストレージ構成 | ✅ 確定 | 4アプリ共用バケット、パス第1階層 `appId` で分離 |
| 認証の有効期限 | ✅ 調査完了 | next-auth v4 JWT・**12時間**・`updateAge` 15分・**リフレッシュトークン無し**。<br>ポータルSSO は HMAC・TTL 60秒。無操作ログアウトは共用15分/個人60分。<br>詳細と影響は `docs/auth-findings.md` |
| Zebra WebView バージョン | ⏳ 実機確認待ち | **暫定値で進行**（下記）|
| オフライン滞留の許容量 | ⏳ 実機確認待ち | **暫定値で進行**（下記）|
| Supabase の準備 | ✅ 完了 | バケット `field-uploads`（ap-northeast-1）、環境変数 `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` 設定済み。<br>RLS はポリシー未作成（= default deny）で、サーバは **Secret key（`sb_secret_` 形式）**でバイパスする方針 |
| サーバ側の変更 | 🔄 並行着手中 | `client_job_id` の追加と API の冪等化は別セッションで進行 |
| DB 移行（Neon → Supabase）の時期 | ❓ 未定 | ストレージ先行で一時的に2ベンダー並存になる点の可否を要確認 |

### 6-1. 暫定値（実機確認後に見直す）

実機確認待ちの2項目は、以下の暫定値で実装を進める。
いずれも**下振れしても壊れない**設計にしてあるので、確認結果で調整すればよい。

| 項目 | 暫定値 | 根拠と、外れたときの影響 |
|---|---|---|
| Android WebView | **Chrome 90 以上**を想定 | Zebra TC/MC 系（Android 11）の標準構成。<br>必要機能の下限は `imageOrientation:'from-image'` の **Chrome 79**、`OffscreenCanvas` の 69、`Web Locks` の 69、`Background Sync` の 49。<br>いずれも実装時にフォールバック経路を用意するので、**Chrome 79 未満でも機能縮退で動く**（自前EXIF補正 / `HTMLCanvasElement` / IDBリース / ページ内トリガのみ）。<br>M1 の完了条件に「capability 検出のログを実機で採取」を追加する |
| 保持写真の上限 | **300枚 / 約120MB / 保持7日** | 200〜400KB × 300枚 ≈ 90MB を見込み、余裕を持って 120MB。<br>`navigator.storage.estimate()` の残量が **50MB 未満で警告**、**20MB 未満で enqueue を拒否**（`QuotaExceededError`）。<br>成功ジョブは7日で自動 purge。実機の空き容量が想定より小さければ閾値を下げるだけで済む |
| 1ジョブの添付上限 | **10枚 / 合計8MB** | pf-setsubi の想定（5〜10枚）に合わせる。超過は enqueue 時にバリデーションエラー |
| アップロードのタイムアウト | **1ファイル 60秒 / 署名要求 15秒** | 弱電界での実測（M3）で調整する暫定値 |
