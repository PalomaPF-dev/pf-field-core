# アプリへの組み込み手順（Next.js）

対象: pf-setsubi / pf-hinshitsu / pf-zaiko / pf-keisoku

> **M0 時点でできること**は「依存の追加」と「実機診断ページの設置」まで。
> キュー・アップロード・Service Worker の組み込みは M4 以降。
> 先に読んでおけば、必要な準備（トークン・環境変数・サーバ側の変更）に着手できる。

---

## 1. GitHub Packages からの取得

パッケージはプライベート配布なので、レジストリの向き先と認証が要る。

### 1-1. `.npmrc`（リポジトリ直下、コミットする）

```ini
@palomapf-dev:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_PACKAGES_TOKEN}
```

**トークンそのものは書かない。** 環境変数の参照だけを置く。

### 1-2. トークンの用意

`read:packages` スコープだけを持つトークンを発行し、以下に登録する。

| 場所 | 変数名 |
|---|---|
| Vercel（Production / Preview / Development すべて） | `GITHUB_PACKAGES_TOKEN` |
| GitHub Actions（あれば） | `GITHUB_PACKAGES_TOKEN`（secrets）|
| 開発者のローカル | シェルの環境変数 |

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
| `SUPABASE_SERVICE_ROLE_KEY` | 署名付きURLの発行（アップロード・閲覧の両方） |

> `SUPABASE_SERVICE_ROLE_KEY` は RLS を迂回する。
> **認可の実体は Route Handler の `authorize()`**（＝アプリ既存の `requireSession()`）であり、
> 保存パスは必ずサーバが組み立てる。詳細は
> [`DESIGN.md` §2.4.6](DESIGN.md) と [`auth-findings.md` §4-1](auth-findings.md)。

---

## 3. 実機診断ページの設置（M0 でできる）

Zebra 端末の WebView が何に対応しているかを採取する。M1 の実装方針を決めるのに使う。

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

## 4. これから必要になる変更（M3〜M4）

着手時期が来る前に、サーバ側・インフラ側の準備を進めておくと M3 が止まらない。
一覧は [`DESIGN.md` §3.1](DESIGN.md) にあるが、**リードタイムが長いものだけ**再掲する。

### 4-1. 既存の登録系 API を冪等にする（サーバ側・先行着手推奨）

弱電界では「送信は成功したがレスポンスが届かない」が日常的に起きる。
クライアントは同じ `jobId` で再送するので、サーバがこれを吸収する必要がある。

- リクエストヘッダ `Idempotency-Key`（= クライアント発行 UUID）を受理する
- レコードテーブルに `client_job_id`（**UNIQUE**）を追加する
- 重複時は既存レコードを返して 200（または 409）にする

### 4-2. DB マイグレーション（サーバ側・先行着手推奨）

| 追加するもの | 用途 |
|---|---|
| `client_job_id`（UNIQUE） | 冪等キー |
| `captured_at` | 撮影時刻。canvas 再エンコードで EXIF が落ちるため構造化データ側に持つ |
| 添付テーブルの `bucket` / `path` | 保存先。**URL は保存しない**（署名付きURLは短命なため）|

### 4-3. 画像の受け取り方を変える

現行は multipart で画像本体を受けている（pf-setsubi は `@vercel/blob`）。
これを **`StoredObjectRef[]`（`{ provider, bucket, path }` の配列）を受け取る形**に変える。
端末は先に Supabase へ直送し、サーバにはレコードと参照だけを送る。

### 4-4. Supabase 側の準備

- バケット `field-uploads` を**非公開**で作成（4アプリ共用、パス第1階層が `appId`）
- `file_size_limit = 8MB` / `allowed_mime_types` を設定
- `storage.objects` の `field-uploads` に対して、`anon` / `authenticated` 向けの
  ポリシーを**1本も作らない**（default deny）。既存の緩いポリシーが無いことを確認する

### 4-5. 無操作ログアウトとの調停（要判断）

共用端末は15分でログアウトし Cookie が破棄されるため、未送信ジョブが送れなくなる。
`@paloma-pf/ui` の `useIdleLogout` に「未送信がある間は抑止する」条件を足すのが本命。
→ [`auth-findings.md` §4-3](auth-findings.md)

---

## 5. トラブルシューティング

| 症状 | 原因 |
|---|---|
| `404 Not Found` で `@palomapf-dev/pf-field-core` が取れない | `.npmrc` のスコープ指定漏れ、またはトークン未設定。GitHub Packages は公開パッケージでも認証が要る |
| `ERR_MODULE_NOT_FOUND` | ESM のみの配布。`require()` では読めない |
| フックが動かず初期状態のまま | `"use client"` の付いたコンポーネントから使っているか確認する |
