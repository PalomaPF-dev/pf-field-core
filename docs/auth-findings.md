# 認証・セッション実装の調査結果（pf-portal / pf-setsubi）

調査日: 2026-08-10
対象: `PalomaPF-dev/pf-portal`（HEAD）、`PalomaPF-dev/pf-setsubi`（HEAD）
目的: pf-field-core のオフラインキューが「数時間の滞留後に送信できるか」を判断するため。

> **この文書は調査時点のスナップショット。**
> 以降の実装で結論が変わった箇所があるので、先にここを読むこと（`0.7.0` 時点）。
>
> | 節 | 調査時の結論 | 現在 |
> |---|---|---|
> | §4-2 | Cookie が切れる12時間超の滞留は再ログインが必要 | **ジョブ単位の送信トークン（26時間）**を導入したので、Cookie とは独立に送れる。26時間を超えた場合の導線は変わらず必要 |
> | §4-4 | Cookie 認証なので `auth.getHeaders()` は基本不要 | **不要ではない。** Service Worker にはセッションが無いため、投入時に預けた送信トークンを `Bearer` で載せる |
> | §5 | 判断待ち3件 | すべて決着済み → [`DESIGN.md` §5-9](DESIGN.md) |
>
> **後の調査で判明した追加事項**: 認証エラーは2種類ある。
> 401 `auth_expired` は再ログインで復帰でき、403 `not_entitled`（利用権・課金ゲート）は
> **再ログインしても復帰しない**。同じ扱いにすると現場が無限に再ログインを繰り返すため、
> `kind: "entitlement"` として分けてある（`requiresReauth()` / `requiresAdmin()`）。

---

## 1. 結論（先に3行）

1. **認証は Supabase Auth ではない。** ポータル発行の HMAC 署名トークンによる SSO + 各アプリの
   **next-auth v4（JWT strategy / Cookie）**。リクエストに Supabase の JWT は載らない。
   → 署名付きURLの発行を「ユーザーJWTを載せた Supabase クライアント → RLS で判定」で行う構成は**現状成立しない**。
   `SUPABASE_SECRET_KEY` でサーバー側発行し、**認可は Route Handler の `requireSession()` が担う**構成が唯一整合する
   （＝ご指示の環境変数指定と一致）。
2. **セッション上限は12時間。リフレッシュトークンは存在しない。**
   12時間を超えて圏外にいた端末は復帰時に 401 → `blocked(auth)` になり、**自動回復できない**。
   再ログイン後に手動再送で救済する導線が必須。
3. **最大のリスクは無操作自動ログアウト（共用端末15分）。**
   ハンディが共用端末扱いだと、15分放置でログアウト → Cookie 破棄 → 未送信ジョブが送れない。
   pf-field-core だけでは解決できない運用判断が要る（§5）。

---

## 2. ポータル側（pf-portal）

技術構成は Next.js ではなく **静的HTML + Vercel Serverless Functions + Neon**。

| 項目 | 実装 | 値 |
|---|---|---|
| 利用者セッション | Cookie `pf_user` = `exp.loginId.HMAC` | **12時間** |
| 管理セッション | Cookie `pf_admin` = `exp.kind.HMAC` | 12時間 |
| 署名 | HMAC-SHA256（`PORTAL_SESSION_SECRET`）| — |
| Cookie 属性 | `HttpOnly; Secure; SameSite=Lax; Path=/` | — |
| セッション延長 | `api/user.js` の `handleSession` が**使うたびに再発行**（スライディング）| 実質「最後に使ってから12時間」|
| 無操作自動ログアウト | `index.html` の `IDLE_MS` | **共用端末 15分 / 個人端末 60分** |

`lib/portalAuth.js:12-14` のコメントに、各アプリの `next-auth` の `session.maxAge` も
12時間に揃えてあることが明記されている（実装でも確認済み → §3）。

### SSO の流れ

```
ポータル GET /api/user?launch=setsubi
  └ verifyUserSession(pf_user)
  └ fetchUserProfile() で所属アプリ・権限を確認（退職者は弾く）
  └ payload = base64url({ loginId, name, role, canManage, department, ..., app, exp })
  └ sig = HMAC-SHA256(payload, PF_PROVISION_KEY)
  └ 302 → https://setsubi.paloma-pf.com/api/sso?token=<payload>.<sig>
```

- SSO トークンの TTL は **60秒**（`api/user.js:68` `TOKEN_TTL_MS = 60 * 1000`）。起動用の短命トークンであり、
  API 呼び出しの認証には使われない。
- 一括ログアウトは front-channel（各アプリの `/api/logout` を iframe で叩く）。

---

## 3. アプリ側（pf-setsubi）

| 項目 | 値 |
|---|---|
| フレームワーク | **Next.js 16.2.4 / React 19.2.4**（App Router）|
| 認証 | **next-auth v4.24（`strategy: "jwt"`）** |
| セッション寿命 | `maxAge: 12 * 60 * 60`（12時間）、`updateAge: 15 * 60`（15分ごとに再発行）|
| Cookie 名 | `__Secure-setsubi.session-token`（アプリごとに分離）|
| Cookie 属性 | `HttpOnly; SameSite=Lax; Secure` |
| SSO 受け口 | `/api/sso` — `PF_PROVISION_KEY` で署名検証 → `next-auth/jwt` の `encode()` でセッション JWT を発行 |
| パスワードログイン | `admin` のみ（一般利用者はポータル経由に一本化）|
| 失効チェック | `requireSession()` が毎リクエスト `isUserDisabled(userId)` で DB 確認（JWT は取り消せないため）|
| 無操作ログアウト | `@paloma-pf/ui` の `useIdleLogout`（共用15分 / 個人60分）|
| DB | **Neon**（`@neondatabase/serverless`）|
| ストレージ | **`@vercel/blob`**（`src/app/api/upload/media/route.ts`、`client-blob` と `server-multipart` の2モード）|

`src/lib/authOptions.ts:118` のコメント:
> セッション上限。共用PCにログインが残り続けないよう、PFシリーズ共通で12時間に揃える。
> 無操作の自動ログアウト（@paloma-pf/ui の useIdleLogout・共用15分/個人60分）が主で、
> こちらは JS が動かない場合の受け皿。

---

## 4. pf-field-core への影響

### 4-1. 署名付きURL発行は service_role 一択（確定）

リクエストに Supabase JWT が載らない以上、`storage.objects` の RLS はユーザーを識別できない。
したがって:

- `supabaseStorageProvider` は `SUPABASE_URL` / `SUPABASE_SECRET_KEY` でクライアントを作る。
- **認可の実体は Route Handler の `authorize()`**（= 各アプリの `requireSession()` / `getSessionWithRole()`）。
- 保存パスはサーバーが `appId/jobType/yyyy/mm/jobId/attachmentId.ext` で組み立て、
  **クライアント指定のパスは一切使わない**。これが他社・他ユーザー領域への書き込みを防ぐ唯一の防壁になる。
- RLS は「**anon / authenticated には INSERT も SELECT も一切許可しない**」default deny を置く。
  service_role は RLS を迂回するので発行経路は動き、万一 anon キーが漏れても直接は触れない。

> 将来 Supabase Auth へ寄せるなら、ユーザーJWT + RLS 判定に切り替えられる。
> `StorageProvider` の `client` オプションが関数も受け付ける形にしてあるのはそのため。

### 4-2. 12時間を超える滞留は自動回復できない（要 UI 導線）

next-auth の JWT は `updateAge: 15分` で「アクセスがあれば延長」されるが、**アクセスが無ければ延びない**。
リフレッシュトークンも無い。よって:

| 圏外滞留時間 | 復帰時の挙動 |
|---|---|
| 〜12時間 | Cookie 有効。そのまま送信できる |
| 12時間超 | 401 → `blocked(auth)`。**再ログインが必要** |

**データは失われない**（IndexedDB に残る）。設計側の対応:

- `auth.onUnauthorized()` を「ポータル再ログインへの導線」に接続する。
- 再ログイン後に `queue.retryAll({ includeBlocked: true })` を叩く導線を用意する。
- 未送信一覧画面に「ログインが切れたため送信できていません」という明示的な文言を出す。

→ **M4 の必須項目**として扱う（当初はオプション扱いだった）。

### 4-3. 無操作15分ログアウトが最大の実務リスク（要運用判断）

ハンディ端末が「共用端末」設定だと 15分の放置でログアウトし、Cookie が破棄される。
Background Sync も Cookie を使って送るため、**ログアウト後は未送信ジョブが送れない**。
現場では「点検して端末を置く → 15分後にログアウト → 圏内に戻っても送られない」が起こりうる。

対応案（pf-field-core 単独では決められないので要判断）:

| 案 | 内容 | 評価 |
|---|---|---|
| A | 未送信ジョブがある間は idle logout を抑止（`@paloma-pf/ui` の `useIdleLogout` に例外を追加）| 最も筋が良い。ただし pf-ui の変更が要る |
| B | ログアウト直前に `queue.flush()` を試み、成功したものだけ送る | 圏外だと無意味。A の補助 |
| C | 現場系4アプリだけ「個人端末（60分）」を既定にする | 運用が許すか要確認。共用端末のセキュリティ要件と衝突 |
| D | 何もしない（再ログイン後に手動再送）| 現場の手間が増えるが実装ゼロ |

**推奨は A + B**。A は `useIdleLogout` に「抑止条件」のコールバックを1つ足すだけで済むはず
（pf-ui のインターフェース次第。M4 で pf-setsubi に入れるタイミングで確認する）。

### 4-4. Cookie 認証なので `auth.getHeaders()` は基本不要

同一オリジンの `/api/*` へは Cookie が自動で載る（`fetch` の既定 `credentials: 'same-origin'`）。
Service Worker からの `fetch` も同様。`FieldCoreConfig.auth.getHeaders` は
**将来 Bearer 方式へ移行したときの余地**として残し、既定は未設定でよい。

`onUnauthorized` は引き続き必要（§4-2）。

### 4-5. App Shell の Cache First は middleware と衝突する

`pf-setsubi/src/middleware.ts` が対象ページに `Cache-Control: private, no-store` を付けている
（会社スコープのデータを CDN に滞留させないため。正しい設定）。

SW でこれらのページを **Cache First でプリキャッシュすると、この意図と矛盾する**。
設計を次のように修正する:

| 対象 | 修正前 | **修正後** |
|---|---|---|
| `/_next/static/**` | Cache First | Cache First（変更なし。内容不変で機微情報を含まない）|
| 認証済みページのHTML | Cache First でプリキャッシュ | **プリキャッシュしない**。Network First → 失敗時のみ `/offline` |
| `/offline` と静的シェル | — | **`/offline` だけをプリキャッシュ**（機微情報を含まない静的ページ）|

「圏外でもアプリが起動する」要件は、`/offline` から未送信一覧・再送ボタンへ行ければ満たせる。
点検入力そのものを完全オフラインで開始できるようにするかは別途要件確認（現状は非対応で設計）。

### 4-6. 既存の `@vercel/blob` からの移行が必要

pf-setsubi は現在 `@vercel/blob` を使い、`blobUrl` を DB に保存している
（`src/app/api/upload/media/route.ts`、`src/app/equipment/[id]/page.tsx` で `d.blobUrl` を直接 `<img src>` に渡している）。

Supabase Storage 化で必要になる作業:

1. `api/upload/media/route.ts` を pf-field-core の `createSignUploadRoute` に置換
   （調査時は `createSignUploadRouteHandler` という名前で書いていた）。
2. DB の添付テーブルに `bucket` / `path` を追加（`blobUrl` は移行期間中は残す）。
3. 表示箇所を `<img src={d.blobUrl}>` → `useSignedUrl({ bucket, path })` に置換。
4. **既存データの扱い**を決める:
   - (a) 既存 `blobUrl` はそのまま Vercel Blob から配信し続け、新規のみ Supabase（並存）
   - (b) 一括コピーして `blobUrl` を廃止（移行バッチが要る）
   → **(a) を推奨**。`StoredObjectRef.provider` に `'vercel-blob'` を持たせれば
     `FileUrlResolver` が provider ごとに解決先を振り分けられ、移行バッチ無しで共存できる。

これは M8（横展開）ではなく **M4（pf-setsubi パイロット）の範囲**に入る。工数見積を上方修正する。

---

## 5. 判断をお願いしたい事項

1. **無操作ログアウトと未送信ジョブの関係**（§4-3）— A/B/C/D のどれで行くか。
   推奨は A（未送信がある間は idle logout を抑止）+ B。`@paloma-pf/ui` の変更可否を確認したい。
2. **既存 Vercel Blob データの扱い**（§4-6）— 並存（推奨）か一括移行か。
3. **オフラインでの新規入力開始**（§4-5）— 圏外で点検入力を「開始」できる必要があるか。
   現設計は「入力はオンラインで開始 → 送信だけオフライン耐性」。完全オフライン起動が要件なら
   マスタデータのローカルキャッシュ設計が別途必要になり、スコープが一段広がる。
4. **DB 移行（Neon → Supabase）の時期** — 現行は全アプリ Neon。ストレージだけ先に Supabase へ寄せると
   一時的に2ベンダー並存になる。それで問題ないか。
