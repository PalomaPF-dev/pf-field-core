---
"@palomapf-dev/pf-field-core": minor
---

M3（端末側）: 送信ランナー — 署名 → アップロード → 本体送信。

Supabase の実地部分（3-b/3-c/3-d）はプロジェクト準備待ちだが、
端末側は先に完成させた。裏が Supabase になっても端末のコードは変わらない。

```ts
import { createOfflineQueue, createUploadProcessor, createHttpSubmitAdapter } from "@palomapf-dev/pf-field-core";
import { createHttpSignedStorageAdapter } from "@palomapf-dev/pf-field-core/storage";

const queue = await createOfflineQueue({
  appId: "pf-setsubi",
  processor: createUploadProcessor({
    storage: createHttpSignedStorageAdapter(),           // 既定: /api/uploads/sign
    submit: createHttpSubmitAdapter({ urls: { "setsubi.inspection": "/api/inspections" } }),
  }),
  issueJobToken: async ({ jobId }) => /* 認証が生きているうちに発行 */,
});
```

**新しい公開 API**

- `createUploadProcessor()` — 送信ランナー本体
- `createHttpSignedStorageAdapter()` — 既定のアップロード経路（プロバイダ非依存）
- `createMemoryStorageAdapter()` — 通信しないアダプタ。アプリ側のテスト用
- `createHttpSubmitAdapter()` — レコード本体の POST（冪等キー付き）
- `uploadToTarget()` / `UploadFailure` — 独自アダプタを書く場合の下回り

**M3 の必須要件3点は実装で満たしている**

1. すべての送信は `redirect: "manual"`。XHR は指定できないので `responseURL` で追跡を検出する
2. `res.ok` では判定しない。リダイレクト → 2xx → ステータス別、の順に明示的に分類する
3. 認証はジョブ単位の送信トークン。`Authorization: Bearer <jobToken>` で送り、
   **401 でもジョブは捨てず `blocked(auth)` で端末に残す**。
   期限切れを検知したら通信する前に止める（投げても 401 になるだけなので）

**振る舞いの変更**

- `flush({ force: true })` が**バックオフの残り時間を無視する**ようになった。
  バックオフは自動再試行を散らすためのもので、電波の良い所まで歩いてきて
  送信ボタンを押した人を待たせる理由が無い。押しても何も起きない画面は現場で故障と見なされる。
  自動の周回（`force` なし）は従来どおり待つ
- 添付の並列アップロードを `Promise.allSettled` で待つようにした。
  `all` は最初の失敗で即 reject するため、並走中の添付が送信途中で見捨てられ、
  そのぶんの完了を記録できずに次回また最初から送り直しになっていた

**`ProcessContext` に追加**（独自ランナーを書いている場合のみ影響）

- `authHeaders()` — そのジョブの認証ヘッダ。トークンはキューが持つのでランナーは中身を知らない
- `reloadJob()` — 送信直前に ref を読み直す
