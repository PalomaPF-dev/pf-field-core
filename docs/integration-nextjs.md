# アプリへの組み込み手順（Next.js）

対象: pf-setsubi / pf-hinshitsu / pf-zaiko / pf-keisoku

> `0.7.0` 時点。キュー・アップロード・React バインディング・Service Worker・
> マスタキャッシュはすべて使える状態にある（DataWedge のみ Zebra 実機の到着待ち）。
>
> 上から順にやれば組み込みが終わる:
>
> 1. [依存の追加](#1-github-packages-からの取得)
> 2. [環境変数](#2-環境変数)
> 3. [サーバ側の準備](#3-サーバ側の準備先行着手が要るもの) — **リードタイムが長いのでここを先に**
> 4. [組み込み](#4-組み込み) — Route Handler・Provider・Service Worker
> 5. [実機診断ページ](#5-実機診断ページ)

---

## 1. GitHub Packages からの取得

パッケージはプライベート配布なので、レジストリの向き先と認証が要る。

### 1-1. `.npmrc`（リポジトリ直下、コミットする）

```ini
@palomapf-dev:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${NPM_TOKEN}
```

**トークンそのものは書かない。** 環境変数の参照だけを置く。

### 1-2. トークンの用意

`read:packages` スコープだけを持つトークンを発行し、以下に登録する。

**変数名は `NPM_TOKEN` を正とする。** Vercel 側は既にこの名前で登録済みで、
4アプリすべてを同じ名前に揃える（名前がずれると、展開したアプリだけが
インストール時に 401 で落ちて原因が見えにくい）。

| 場所 | 変数名 |
|---|---|
| Vercel（Production / Preview / Development すべて） | `NPM_TOKEN` |
| GitHub Actions（あれば） | `NPM_TOKEN`（secrets）|
| 開発者のローカル | シェルの環境変数 `NPM_TOKEN` |

### 1-3. 依存の追加

```bash
pnpm add @palomapf-dev/pf-field-core
```

ESM のみを出力している。Next.js 16 / Node 20+ が前提なので `transpilePackages` は不要。

---

## 2. 環境変数

pf-field-core が読むのは次の2つだけ。**どちらもサーバ専用**で、
`NEXT_PUBLIC_` を付けてはいけない。

| 変数 | 用途 |
|---|---|
| `SUPABASE_URL` | Supabase プロジェクトの URL |
| `SUPABASE_SECRET_KEY` | 署名付きURLの発行（アップロード・閲覧の両方）。Supabase の Secret key（`sb_secret_` 始まり）|

**変数名は `SUPABASE_SECRET_KEY` を正とする。**
実装は移行のため `SUPABASE_SERVICE_ROLE_KEY` も別名として受け付けるが、
新しく設定するときは `SUPABASE_SECRET_KEY` を使うこと。

> `SUPABASE_SECRET_KEY` は RLS を迂回する。
> **認可の実体は Route Handler の `authorize()`**（＝アプリ既存の `requireSession()`）であり、
> 保存パスは必ずサーバが組み立てる。詳細は
> [`DESIGN.md` §2.4.6](DESIGN.md) と [`auth-findings.md` §4-1](auth-findings.md)。

---

## 3. サーバ側の準備（先行着手が要るもの）

**リードタイムが長いのはこの4つ。**組み込みより先に着手しておくと止まらない。
一覧は [`DESIGN.md` §3.1](DESIGN.md) にある。

### 3-1. 既存の登録系 API を冪等にする

弱電界では「送信は成功したがレスポンスが届かない」が日常的に起きる。
クライアントは同じ `jobId` で再送するので、サーバがこれを吸収する必要がある。

- リクエストヘッダ `Idempotency-Key`（= クライアント発行 UUID）を受理する
- レコードテーブルに `client_job_id`（**UNIQUE**）を追加する
- 重複時は既存レコードを返して 200（または 409）にする

### 3-2. DB マイグレーション

| 追加するもの | 用途 |
|---|---|
| `client_job_id`（UNIQUE） | 冪等キー |
| `captured_at` | 撮影時刻。canvas 再エンコードで EXIF が落ちるため構造化データ側に持つ |
| 添付テーブルの `bucket` / `path` | 保存先。**URL は保存しない**（署名付きURLは短命なため）|

### 3-3. 画像の受け取り方を変える

現行は multipart で画像本体を受けている（pf-setsubi は `@vercel/blob`）。
これを **`StoredObjectRef[]`（`{ provider, bucket, path }` の配列）を受け取る形**に変える。
端末は先に Supabase へ直送し、サーバにはレコードと参照だけを送る。

### 3-4. Supabase 側の準備

- バケット `field-uploads` を**非公開**で作成（4アプリ共用、パス第1階層が `companyId`）
- `file_size_limit = 8MB` / `allowed_mime_types` を設定
- `storage.objects` の `field-uploads` に対して、`anon` / `authenticated` 向けの
  ポリシーを**1本も作らない**（default deny）。既存の緩いポリシーが無いことを確認する

→ 手順の詳細は [`supabase-setup.md`](supabase-setup.md)

### 3-5. 無操作ログアウトとの調停（要判断）

共用端末は15分でログアウトし Cookie が破棄されるため、未送信ジョブが送れなくなる。
`@paloma-pf/ui` の `useIdleLogout` に「未送信がある間は抑止する」条件を足すのが本命。
→ [`auth-findings.md` §4-3](auth-findings.md)

---

## 4. 組み込み

### 4-1. Route Handler を2本置く

**認可の実体はここ。** 署名鍵は RLS を迂回するので、
「誰がどのパスに書けるか」を決めているのはこの `authorize` だけになる。

```ts
// src/app/api/uploads/sign/route.ts
import { createSignUploadRoute, supabaseStorageFromEnv } from "@palomapf-dev/pf-field-core/server";
import { requireSession } from "@/lib/auth";

export const POST = createSignUploadRoute({
  provider: supabaseStorageFromEnv(),
  appId: "pf-setsubi",
  authorize: async (request) => {
    const session = await requireSession(request);
    if (!session) return undefined; // 401 になる
    // companyId は保存パスの第1階層 = テナント分離の要。
    // 欠けたまま保存すると全社ぶんが同じプレフィックスに落ちるので、
    // 既定のパス生成は companyId が無ければ例外にする
    return { userId: session.userId, companyId: session.companyId };
  },
});
```

```ts
// src/app/api/files/sign-view/route.ts
import { createSignViewRoute, supabaseStorageFromEnv } from "@palomapf-dev/pf-field-core/server";
import { requireSession } from "@/lib/auth";

export const POST = createSignViewRoute({
  provider: supabaseStorageFromEnv(),
  appId: "pf-setsubi",
  authorize: async (request) => {
    const session = await requireSession(request);
    return session ? { userId: session.userId, companyId: session.companyId } : undefined;
  },
});
```

> `/server` は**サーバ専用**。クライアントコンポーネントから import してはいけない
> （`SUPABASE_SECRET_KEY` を読むため）。誤って辿れる経路ができていないかは
> ライブラリ側の `no-client-leak` テストが見張っている。

### 4-2. Provider で包む

```tsx
// src/app/providers.tsx
"use client";

import { FieldCoreProvider } from "@palomapf-dev/pf-field-core/react";

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <FieldCoreProvider
      config={{
        appId: "pf-setsubi",
        endpoints: {
          submit: { "setsubi.inspection": "/api/inspections" },
        },
        master: {
          scope: `${companyId}/${factoryId}`, // 会社・工場に限定する
          fetchCollections: async (scope) =>
            (await fetch(`/api/master?scope=${scope}`)).json(),
        },
        onEvent: (event) => {
          // 監視に流す。type で絞ると data の中身が確定する
          if (event.type === "job.failed") report(event.data.kind);
        },
      }}
    >
      {children}
    </FieldCoreProvider>
  );
}
```

画面側は `useOfflineQueue()` / `useMaster()` / `useCachedMedia()` / `useDraft()` を使う。
未送信バッジ・再送導線・容量警告の出し方は [`operations.md`](operations.md) にまとめてある。

**`blocked` の出し分けだけは間違えないこと。**

```tsx
import { requiresReauth, requiresAdmin } from "@palomapf-dev/pf-field-core";

{job.lastError && requiresReauth(job.lastError) && <ReloginButton />}
{job.lastError && requiresAdmin(job.lastError) && (
  <p>利用権がありません。管理者に連絡してください（再ログインでは解決しません）</p>
)}
```

再ログインで戻らないもの（403 `not_entitled`）に再ログイン導線を出すと、
現場が何度ログインしても直らない操作を繰り返すことになる。

### 4-3. Service Worker を置く

アプリ側に `worker/sw.ts` を1本書き、ビルド時に `public/sw.js` へ束ねる。

```ts
// worker/sw.ts
import { createFieldServiceWorker } from "@palomapf-dev/pf-field-core/sw";
import {
  createHttpSubmitAdapter,
  createOfflineQueue,
  createUploadProcessor,
} from "@palomapf-dev/pf-field-core";
import { createHttpSignedStorageAdapter } from "@palomapf-dev/pf-field-core/storage";

declare const __PF_FIELD_PRECACHE__: { url: string; revision: string }[];
declare const __PF_FIELD_BUILD_ID__: string;

createFieldServiceWorker({
  appId: "pf-setsubi",
  version: __PF_FIELD_BUILD_ID__,
  precache: __PF_FIELD_PRECACHE__,

  api: {
    // 署名の発行・認証・アップロードは絶対にキャッシュしない
    exclude: [/^\/api\/(uploads|token|submit|files)/],
    include: [/^\/api\//],
    cacheable: [/^\/api\/health/],
  },

  // Background Sync 用のキュー。
  // issueJobToken は渡さない — SW にはセッションが無く、トークンを新規発行できない。
  // 投入時に預けたトークンで送るので requireJobToken を立てる
  createQueue: () =>
    createOfflineQueue({
      appId: "pf-setsubi",
      requireJobToken: true,
      autoStart: false,
      pollIntervalMs: 0,
      processor: createUploadProcessor({
        storage: createHttpSignedStorageAdapter({ signUrl: "/api/uploads/sign" }),
        submit: createHttpSubmitAdapter({ urls: { "setsubi.inspection": "/api/inspections" } }),
      }),
    }),
});
```

```jsonc
// package.json
{
  "scripts": {
    "prebuild": "pf-field-sw build"   // worker/sw.ts → public/sw.js
  }
}
```

生成物（`public/sw.js`）は**コミットしない**。`.gitignore` に入れること。

動く見本は `apps/playground/worker/sw.ts`。

iOS には Background Sync が無いので、画面を開いている間に送る経路へ落ちる。
`requestQueueSync()` が「前面が要るか」を返すので、UI はそれを見て
「アプリを開いたままにしてください」と伝えられる。

---

## 5. 実機診断ページ

端末の WebView が何に対応しているかを採取する。
Android と iPhone で挙動が分かれる箇所（Background Sync・永続化の可否）の確認に使う。

```tsx
// src/app/diagnostics/page.tsx
"use client";

import { useImageCapabilities } from "@palomapf-dev/pf-field-core/react";
import { VERSION } from "@palomapf-dev/pf-field-core";

export default function Diagnostics() {
  const { capabilities, probing } = useImageCapabilities();
  if (probing) return <p>検出中…</p>;
  return <pre>{JSON.stringify({ version: VERSION, ...capabilities }, null, 2)}</pre>;
}
```

実機で開いて、表示された JSON をそのまま共有してほしい。

---

## 6. トラブルシューティング

| 症状 | 原因 |
|---|---|
| `404 Not Found` で `@palomapf-dev/pf-field-core` が取れない | `.npmrc` のスコープ指定漏れ、またはトークン未設定。GitHub Packages は公開パッケージでも認証が要る |
| `ERR_MODULE_NOT_FOUND` | ESM のみの配布。`require()` では読めない |
| フックが動かず初期状態のまま | `"use client"` の付いたコンポーネントから使っているか確認する |
| 署名要求が 500 になる | `authorize()` が `companyId` を返していない。保存パスの第1階層なので、欠けていると既定のパス生成が例外を投げる（全社ぶんが同じプレフィックスに落ちるのを防ぐため） |
| 再ログインしても未送信が減らない | 403 `not_entitled`（利用権）を再ログインで直そうとしている。`requiresAdmin()` で出し分ける |
| 送信済みなのに別のタブだけ未送信が残る | `0.7.0` 未満。タブ間通知が入っていない |
| ビルドで `SUPABASE_SECRET_KEY` が undefined | `/server` をクライアントコンポーネントから import している |
