---
"@palomapf-dev/pf-field-core": minor
---

M3（サーバ側）: Supabase Storage 実装 + Route Handler + S3 実装。

```ts
// app/api/uploads/sign/route.ts
import { createSignUploadRoute, supabaseStorageFromEnv } from "@palomapf-dev/pf-field-core/server";

export const POST = createSignUploadRoute({
  provider: supabaseStorageFromEnv(),   // SUPABASE_URL / SUPABASE_SECRET_KEY / SUPABASE_BUCKET
  appId: "pf-setsubi",
  authorize: async (request) => {
    const session = await requireSession(request);
    return session ? { userId: session.userId, companyId: session.companyId } : undefined;
  },
});
```

**新しい公開 API（`/server` サブパス）**

- `createSupabaseStorageProvider()` / `supabaseStorageFromEnv()`
- `createSignUploadRoute()` / `createSignViewRoute()` — 2本の Route Handler
- `createS3StorageProvider()` — S3 互換（抽象が効いていることの検証用）
- `defaultObjectPath()` / `companyIdOfPath()` / `sanitizeSegment()`

**パス規約（確定）**

```
field-uploads/<companyId>/<appId>/<YYYY>/<MM>/<jobId>/<attachmentId>
```

`companyId` が取れない場合はパス生成を**例外にする**。
既定値で埋めると全社ぶんが同じプレフィックスに落ち、テナント分離が静かに消えるため。

**テナント分離について**

署名鍵（`sb_secret_`）は **RLS を迂回する**ので、Storage のポリシーはサーバ経路の
防御にならない。守っているのは `authorize()`・サーバ側パス生成・閲覧時の会社照合の3つだけ。
RLS ポリシーを未作成にしているのは anon からの直接操作を全拒否するためで、
サーバ経路の安全性とは別の話。詳細は `docs/supabase-setup.md`。

**S3 実装の署名は AWS 公式の計算例と一致することを検証済み**（SigV4 を自前実装しているため）。

**未確認**: 実エンドポイントでの確認（3-b）は未実行。
開発環境から `*.supabase.co` へ到達できないため。
`pnpm verify:supabase` を鍵のある環境で1回流せば確定する。
外れうるのは `bodyMode`（`binary` / `form-data`）だけで、
その場合の変更は `server/supabase.ts` の1箇所に閉じ、端末側は影響を受けない。
