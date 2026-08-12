# M8 横展開計画 — pf-hinshitsu / pf-keisoku / pf-zaiko

> 作成: 2026-08-12。4アプリ(設備・品質・計測・在庫)の実装調査に基づく。
> 方針: **現場管理アプリ4本を pf-setsubi と同一仕様に統一する**(利用者からの指示)。
> DataWedge(M6 の残り)は Zebra 実機の到着後に別途進める。DataWedge が無くても
> `capabilities.hardwareScanner` が false になり手入力へフォールバックするため、横展開は先行できる。

---

## 0. 決定事項と保留

| # | 事項 | 決定 |
|---|---|---|
| 1 | ストレージ | **新規(オフライン経路)の添付は Supabase 署名URL 方式**。既存の Vercel Blob 公開URLのデータは**並存**させ移行バッチは書かない(DESIGN §3.1-21 の既定方針どおり) |
| 2 | 既存のオンライン送信経路 | **触らない。** Server Action 経路はそのまま残し、オフライン経路(enqueue → `/api/...` の冪等受け口)を**並走**で足す。pf-setsubi のパイロットと同じ形 |
| 3 | 送信の認可 | pf-setsubi の `field_job_tokens` 設計(不透明トークン・SHA-256 保存・TTL 26h・Bearer/cookie 両対応)を共通仕様として3アプリへ複製 |
| 4 | sign-view | pf-setsubi はストレージ3種混在の歴史的経緯で自前実装だが、**3アプリは新規添付が Supabase 単一なのでライブラリの `createSignViewRoute` を使う**(混在が発生したら pf-setsubi 方式に切替) |
| 5 | pf-keisoku の対象記録 | ⚠️ DESIGN の想定「計測値+計器写真」は**アプリの実態と乖離**(計測値の記録機能は存在しない。計測機器の台帳・校正・貸出アプリ)。オフライン対象は**校正実績の登録(+状況写真)**とする。**要確認事項として利用者へ報告済み** |
| 6 | ブランチ | 各アプリ `claude/m8-field-core-rollout`。main へは push しない |

## 1. 現状マトリクス(2026-08-12 調査)

| | pf-setsubi | pf-hinshitsu | pf-keisoku | pf-zaiko |
|---|---|---|---|---|
| pf-field-core | **0.7.0 導入済み** | なし | なし | なし |
| manifest + アイコン | ✅ | ✅ | ✅ | ✅ |
| Service Worker | ✅ `worker/sw.ts` | なし | なし | なし |
| ホーム画面追加の案内 | ✅ `fieldRuntimeNotices` | なし | なし | なし |
| 記録系の送信経路 | API ルート(冪等)+旧経路並走 | Server Action のみ | Server Action のみ | Server Action のみ |
| 添付ストレージ | Supabase 署名 + Blob 並存 | Blob 公開URL(client 直アップ) | Blob 公開URL(Server Action 内 `put`) | Blob 公開URL(client 直アップ、`record-media/` 枠は未使用) |
| `client_job_id` / `captured_at` | ✅ | なし | なし | なし |
| `field_job_tokens` | ✅ | なし | なし | なし |
| クライアント画像圧縮 | field-core(EXIF 対応) | **なし(原寸)** | 自前 canvas(EXIF 非対応) | 自前 canvas(EXIF 非対応) |
| Next.js / React | 16.2.4 / 19.2.4 | 同じ | 同じ | 同じ |
| DB | 生SQL + `ensureSchema()` 冪等DDL | 同じ | 同じ | 同じ |
| 認証 | next-auth v4 JWT + ポータル SSO | 同じ | 同じ | 同じ |
| パッケージマネージャ | npm | npm | npm | npm |

4アプリの骨格(Next バージョン・認証・DB アダプタ・`safeDdl` 増築パターン)が一致しているため、
pf-setsubi の実装がほぼそのまま移植テンプレートになる。

## 2. 統一仕様(全アプリに入れるもの)

### 2.1 pf-setsubi からコピー(appId・文言・テーマ色のみ置換)

| 対象 | 備考 |
|---|---|
| `.npmrc` | `@palomapf-dev:registry` + `${NPM_TOKEN}`。無変更 |
| `package.json` | `@palomapf-dev/pf-field-core: "0.7.0"`(^なし固定)、`@supabase/supabase-js: "^2.45.0"`(**明示追加**。setsubi は optional peer 経由で入っている状態なので3アプリでは明示する)、`"prebuild": "pf-field-sw build"` |
| `.gitignore` | `public/sw.js` / `public/sw.js.map` の2行 |
| `worker/sw.ts` | `APP_ID` / `JOB_TYPE` / submit URL / `api.exclude` を置換。**`process.env.*` を読まない**(地雷 §5-1) |
| `src/lib/fieldCoreConfig.ts` | `appId`・`endpoints.submit` のジョブ種別・`limits`・`image` を置換。**トークン先取り機構と `subscribeStorageAlerts` は必ず持っていく** |
| `src/components/Providers.tsx` | `companyId` をサーバー(layout)から受けて `FieldCoreProvider` を `SessionProvider` の内側に |
| `src/lib/fieldRuntimeNotices.ts` + `.test.ts` | **完全に無変更**(ホーム画面追加の案内・installAdvice・shouldSendBeforeInstall を含む) |
| `src/components/FieldRuntimeNotices.tsx` | `DISMISS_KEY` とテーマ色のみ。SW 登録(`useServiceWorkerUpdate`)もこの中 |
| `src/components/UnsentIndicator.tsx` / `UnsentJobList.tsx` / `src/app/unsent/page.tsx` | 文言(「点検」→各業務語)と色 |
| `src/app/offline/page.tsx` | 文言・リンク先。`force-static` を維持 |
| `src/components/FieldVersionPanel.tsx` | 「この端末の状態」。設定画面が無いアプリは `/settings` 相当の置き場を作る |
| `src/lib/fieldAuth.ts` / `fieldJobToken.ts` / `fieldBudget.ts` / `mediaLimits.ts` / `mediaRef.ts` | `fieldJobToken.ts` の `consumeIfComplete` の SQL(記録テーブル名)と `FIELD_APP_ID` を置換 |
| `src/app/api/health/route.ts` | `app` 文字列のみ |
| `src/app/api/uploads/sign/route.ts` | `createSignUploadRoute` + `supabaseStorageFromEnv()`。`FIELD_APP_ID` を置換 |
| `src/app/api/files/sign-view/route.ts` | **setsubi 自前版ではなくライブラリの `createSignViewRoute`**(決定 §0-4) |
| `src/app/api/<記録>/token/route.ts` | トークン発行。setsubi の `inspections/token` と同型 |
| `schema.ts` への `field_job_tokens` DDL | 無変更でコピー |
| `AppShell` への差し込み | `FieldRuntimeNotices` を children 先頭、`UnsentIndicator compact` をヘッダ右 |

### 2.2 スキーマ追加(各アプリの `ensureSchema()` に `safeDdl` で追記)

- 対象記録テーブルに `client_job_id UUID` と `captured_at TIMESTAMPTZ` を `ADD COLUMN IF NOT EXISTS`
- `CREATE UNIQUE INDEX <tbl>_client_job_id_unique ON <tbl>(company_id, client_job_id) WHERE client_job_id IS NOT NULL`
- `field_job_tokens` テーブル(setsubi と同一 DDL)
- INSERT は `ON CONFLICT DO NOTHING` + 冪等応答(既存なら 200 で既存 ID を返す)

### 2.3 冪等な受け口 API(アプリ固有実装)

`POST /api/<記録>`。`Idempotency-Key` ヘッダ / payload の `client_job_id` で重複吸収。
添付は multipart ではなく **`StoredObjectRef[]`** を受ける。`authorizeFieldRequest` で Bearer 優先・cookie フォールバック。
`auth_expired`(401) と `not_entitled`(403) を分離(再ログインで直るものと直らないものを UI が区別するため)。

### 2.4 PWA / ホーム画面追加の案内

manifest・アイコンは4アプリとも配備済みなので、追加は SW(`pf-field-sw build` → `public/sw.js`)と
`FieldRuntimeNotices`(= SW 登録 + iOS の保存領域分離への案内 + 未送信を抱えたままの追加ブロック)のみ。
`middleware.ts` の `Cache-Control: private, no-store` は3アプリとも設定済みで setsubi と同じ考え方。
**matcher に `/unsent` `/offline` を足さない**(offline は precache するため)。

## 3. アプリ別の適用

### 3.1 pf-hinshitsu(品質) — オフライン対象: 検査実行(NG 時の不良報告 + 写真)
- 現行: `InspectForm.tsx`(890行) → Server Action `submitInspection` → `submitCore.ts`。
  画像は Blob へ client 直アップ後に URL だけ送る方式。**クライアント圧縮なし(原寸)**
- 追加: `POST /api/inspections`(冪等受け口)+ パイロットのオフライン検査フォーム(setsubi の
  `OfflineInspectionForm` パターン: jobId 先確定 → `pretakeJobToken` → `useDraft` → `enqueue`)
- 注意: `submitCore.ts` の `sanitizeMedia()` が `.blob.vercel-storage.com` 決め打ち。オフライン経路は
  `StoredObjectRef` を受けるため通らない(新 API 側で受ける。既存関数は触らない)
- 動画は不良部位判別のため画質を落としすぎない(`mediaLimits` の env 分岐を活用)

### 3.2 pf-keisoku(計測) — オフライン対象: 校正実績の登録(+状況写真)
- 現行: `CalibrationForm.tsx` → Server Action `addCalibrationAction`。写真は Server Action 内で `put()`
- 追加: `POST /api/calibrations`(冪等)+ オフライン校正フォーム。
  必須チェック(校正日・機器)は **enqueue 前にクライアントで実施**(DESIGN の「バリデーションを enqueue 前に必ず通す」)
- `documents` テーブルに校正写真が紐づく構造のため、受け口では `calibration_records` に `client_job_id`/`captured_at` を追加し、`documents` は従属挿入
- 「結果 pass なら写真を捨てる」仕様は受け口でも踏襲
- viewport の themeColor(`#7c3aed`)と manifest(`#9162f4`)の不一致を修正

### 3.3 pf-zaiko(在庫) — オフライン対象: 入出庫・調整の記録(写真は任意)
- 現行: `IoForm.tsx` → Server Action `recordMovementAction` → `applyMovement`(ID サーバー生成)
- 追加: `POST /api/movements`(冪等)+ IoForm のオフライン版。`transactions` に `client_job_id`/`captured_at` 追加、
  `applyMovement` 相当の INSERT を `ON CONFLICT DO NOTHING` 化
- 添付枠 `zaiko/record-media/` が既に upload API のホワイトリストにあり、写真対応の下地は流用可
- `useScanWedge`(ハンディ入力)が既にあるため、Zebra 到着後の DataWedge 有効化はこのアプリが最初の実地になる見込み
- 棚卸(`saveStocktakeCountsAction`)のオフライン化は**第2段**(一括保存の冪等設計が別論点のため)

## 4. 運用側(人間)にお願いする作業 — コードでは完結しないもの

| # | 作業 | 対象 |
|---|---|---|
| 1 | Supabase の env 登録: `SUPABASE_URL` / `SUPABASE_SECRET_KEY`(**サーバー専用**、`NEXT_PUBLIC_` を付けない) | 3アプリ × Vercel(Production/Preview/Development) |
| 2 | Supabase バケット `field-uploads`(4アプリ共用、パス第1階層 = appId)の存在確認と `allowed_mime_types` / `file_size_limit`(8MB)の設定 | Supabase コンソール |
| 3 | `NPM_TOKEN`(read:packages)が3アプリの Vercel に登録済みか確認 | Vercel |
| 4 | 開発者トークンで各アプリ `npm install` を1回実行し `package-lock.json` を更新(この環境には GitHub Packages トークンが無いため lock は未更新のまま push される) | 各アプリ |
| 5 | 本番反映後の実機検証(pf-setsubi の `docs/IPHONE-CHECK.md` を各アプリ名に読み替えて実施) | iPhone 実機 |
| 6 | pf-keisoku の対象記録の確認(§0-5。校正実績で良いか、別に「計測値の記録」機能を新規に作る構想があるか) | 判断 |

## 5. 既知の地雷(pf-setsubi の実装コメントから)

1. `worker/sw.ts` で `process.env.*` を読むと SW の install ごと失敗する(define されるのは `NODE_ENV` / `__PF_FIELD_PRECACHE__` / `__PF_FIELD_BUILD_ID__` のみ)
2. クライアント `appId` とサーバー `FIELD_APP_ID` の不一致は `isOwnMediaRef` が全参照を弾く
3. `master.limits.maxAssetsPerGroup` 既定 50 は超過分を黙って切り捨てる
4. Supabase バケットの `allowed_mime_types` を広げる前に `NEXT_PUBLIC_FIELD_AV_CAPTURE=1` にすると「撮れるが永久に送れない」
5. 署名ルートの `maxBytes` とクライアント判定値のずれは「保存できるが 413」
6. `skipWaiting` は既定 false のまま(入力中のリロードで書きかけが消えるため)
7. ライブラリの `enqueue` は `issueJobToken` 失敗時にジョブごと削除して throw する — **トークン先取り機構を必ず併設**(fieldCoreConfig のコメント参照)
8. 切り戻しで `prebuild` を外すのは不可(旧 SW が残る)。撤去は pf-setsubi `docs/OFFLINE-INTAKE.md` §10-6 の手順で

## 6. 検証(この環境でできる範囲)

- `@palomapf-dev/pf-field-core@0.7.0` はローカルビルドの tarball で依存解決し、`tsc --noEmit` / `next lint` / `pf-field-sw build` を通す
- `next build` は DB env が無いため落ちる場合がある。その場合は型検査と SW 生成までを合格ラインとする
- `fieldRuntimeNotices.test.ts` はテストランナーが無いアプリでは持ち込みのみ(実行は CI 整備後)

## 7. pf-field-core 0.8 への還元候補(4回コピーの解消)

横展開で「アプリ間コピー」になったもの: `fieldRuntimeNotices`(ホーム画面案内)、`FieldVersionPanel`、
`UnsentIndicator` / `UnsentJobList`、`/offline` ページ雛形、`fieldBudget`、トークン先取り機構、
`field_job_tokens` DDL + 発行/検証ルートの雛形。次のメジャーでライブラリの `react/` へ引き上げる。
あわせて 0.7.0 の `createSignViewRoute` の制約(単一 provider・テナント検証固定)の解消も検討。
