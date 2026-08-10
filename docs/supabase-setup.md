# Supabase Storage セットアップ（3-c / 3-d）

対象プロジェクト: `https://asustezkyqzuetrxwijp.supabase.co`（ap-northeast-1 / Tokyo）

---

## 1. 結論から

**このシステムでは、Supabase の RLS ポリシーは防御の主役ではない。**

署名鍵（`SUPABASE_SECRET_KEY`、`sb_secret_` 形式）は **RLS を迂回する**。
サーバはこの鍵で署名を発行するので、Storage 側にどんなポリシーを書いても
その経路には一切効かない。

したがって「誰がどこへ書けるか」「何を見られるか」を決めているのは次の3つだけ:

| 守るもの | どこで | 実体 |
|---|---|---|
| 認証されているか | Route Handler の `authorize()` | 各アプリの `requireSession()` 相当 |
| どこへ書くか | サーバ側のパス生成 | `defaultObjectPath()`。クライアントの値は使わない |
| 何を見られるか | 閲覧の会社照合 | `createSignViewRoute` が `companyId` 前方一致で弾く |

**ポリシーを未作成のままにしているのは正しい。** ただしそれは
「anon / authenticated からの直接操作を全部拒否する」ことが目的であって、
サーバ経路の安全性を担保しているわけではない。ここを取り違えると、
`authorize()` を緩めたときに何も気づけなくなる。

---

## 2. バケット

| 項目 | 値 |
|---|---|
| 名前 | `field-uploads` |
| 公開 | **非公開**（Public bucket = off） |
| ファイルサイズ上限 | 20MB |
| 許可 MIME | `image/jpeg` `image/webp` `image/png` `application/pdf` |

4アプリ共用。分離はパスで行う。

### パス規約（確定）

```
field-uploads/<companyId>/<appId>/<YYYY>/<MM>/<jobId>/<attachmentId>
```

- **先頭が `companyId`** — テナント分離の要。閲覧の照合もこの第1階層を見る
- `appId` は `pf-setsubi` / `pf-hinshitsu` / `pf-zaiko` / `pf-keisoku`
- 年月で割るのは、1つのプレフィックス配下が際限なく増えるのを避けるため
- **組み立ては必ずサーバ側**（`defaultObjectPath()`）。
  クライアントが送ったファイル名は使わない（`../` を含む名前が来ても関係が無い形にしてある）

`companyId` が取れない場合、パス生成は**例外にする**。
既定値で埋めると全社ぶんが同じプレフィックスに落ち、分離が静かに消えるため。

---

## 3. 環境変数

| 変数 | 用途 | 置き場所 |
|---|---|---|
| `SUPABASE_URL` | プロジェクト URL | Vercel（サーバのみ） |
| `SUPABASE_SECRET_KEY` | 署名鍵（`sb_secret_`）。**RLS を迂回する** | Vercel（サーバのみ） |
| `SUPABASE_BUCKET` | バケット名。既定 `field-uploads` | Vercel（サーバのみ） |

- **正は `SUPABASE_SECRET_KEY`。** `SUPABASE_SERVICE_ROLE_KEY` は移行期の別名として
  読むだけ受け付ける
- `NEXT_PUBLIC_` を頭に付けないこと。付けるとクライアントバンドルに焼き込まれ、
  **RLS を迂回する鍵が全利用者の手に渡る**
- `packages/field-core/test/packaging.test.ts` が、
  クライアント向けエントリからサーバ専用モジュールへ辿れないことを機械的に検査している

---

## 4. Route Handler（3-c）

各アプリに2本置く。中身は field-core が持つので、アプリ側は認証を渡すだけ。

```ts
// app/api/uploads/sign/route.ts
import { createSignUploadRoute, supabaseStorageFromEnv } from "@palomapf-dev/pf-field-core/server";
import { requireSession } from "@/lib/auth";

export const POST = createSignUploadRoute({
  provider: supabaseStorageFromEnv(),
  appId: "pf-setsubi",
  authorize: async (request) => {
    const session = await requireSession(request);
    if (!session) return undefined;             // → 401
    return { userId: session.userId, companyId: session.companyId };
  },
});
```

```ts
// app/api/files/sign-view/route.ts
import { createSignViewRoute, supabaseStorageFromEnv } from "@palomapf-dev/pf-field-core/server";
import { requireSession } from "@/lib/auth";

export const POST = createSignViewRoute({
  provider: supabaseStorageFromEnv(),
  appId: "pf-setsubi",
  authorize: async (request) => {
    const session = await requireSession(request);
    if (!session) return undefined;
    return { userId: session.userId, companyId: session.companyId };
  },
});
```

> `authorize()` が返す `companyId` が保存パスの第1階層になる。
> ここを間違えると他社の領域へ書ける。**セッションから取ること**、
> リクエストボディやクエリから取らないこと。

---

## 5. RLS の状態を確認する（3-d）

ポリシーは作らない。確認すべきは「**作っていない状態が、意図どおり全拒否になっているか**」。

### 5-1. 確認クエリ

Supabase の SQL Editor で実行する。

```sql
-- storage.objects の RLS が有効か（Supabase は既定で有効）
select relname, relrowsecurity
from pg_class
where relnamespace = 'storage'::regnamespace and relname = 'objects';
-- => relrowsecurity = true であること

-- field-uploads に対するポリシーが無いこと
select policyname, cmd, roles
from pg_policies
where schemaname = 'storage' and tablename = 'objects';
-- => field-uploads を許可する行が無いこと

-- バケットが非公開であること
select id, public, file_size_limit, allowed_mime_types
from storage.buckets
where id = 'field-uploads';
-- => public = false
```

RLS 有効 + ポリシー無し = anon / authenticated からは **select も insert もできない**。
これが狙った状態。

### 5-2. 実際に拒否されることを確かめる

`scripts/verify-supabase.mjs` が、鍵なしの GET が拒否されることまで含めて確認する。

```bash
pnpm build
SUPABASE_URL=https://asustezkyqzuetrxwijp.supabase.co \
SUPABASE_SECRET_KEY=sb_secret_xxx \
SUPABASE_BUCKET=field-uploads \
pnpm verify:supabase
```

確認項目:

1. 署名付きアップロードURLを発行できる
2. 保存パスが規約どおり
3. **生バイナリの PUT を受け付ける**（`bodyMode: "binary"` の確定 = 3-b の主目的）
4. 同じ署名URLへの再送の挙動（200 / 409 のどちらか）
5. 閲覧用の署名URLで中身が元どおり取れる
6. **鍵なしでは読めない**（バケット非公開・ポリシー未作成が効いている）
7. 削除できる

`_verify/` 配下の使い捨てパスを使い、最後に消す。実データには触れない。

---

## 6. 未確定事項

**3-b はこの環境から実行できていない。**
開発コンテナの egress ポリシーが `*.supabase.co` への接続を拒否するため
（`gateway answered 403 to CONNECT`）。回避はしていない。

したがって次の2点は**実装が正しいという確認が取れていない**:

| 項目 | 現在の実装 | 外れた場合 |
|---|---|---|
| 生バイナリ PUT を受け付けるか | `bodyMode: "binary"` | `server/supabase.ts` の `UPLOAD_BODY_MODE` を `'form-data'` にする。**端末側の変更は不要** |
| 同一パス再送時の 409 | `x-upsert: true` で上書き | ランナーは 409 も成功として扱うので、どちらでも壊れない |

鍵のある環境で `pnpm verify:supabase` を1回流せば確定する。
