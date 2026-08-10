---
"@palomapf-dev/pf-field-core": minor
---

M5: Service Worker と Background Sync（iOS フォールバック込み）。

```ts
// worker/sw.ts
import { createFieldServiceWorker } from "@palomapf-dev/pf-field-core/sw";

createFieldServiceWorker({
  appId: "pf-setsubi",
  version: __PF_FIELD_BUILD_ID__,
  precache: __PF_FIELD_PRECACHE__,
  api: { exclude: [/^\/api\/(uploads|token)/] },
  // SW にセッションは無い。投入時に預けたトークンで送る
  createQueue: () => createOfflineQueue({ appId: "pf-setsubi", requireJobToken: true, ... }),
});
```

```jsonc
// package.json
"prebuild": "pf-field-sw build"
```

**新しい公開 API**

- `createFieldServiceWorker()` — SW 本体（`/sw` サブパス）
- `registerFieldServiceWorker()` / `requestQueueSync()` / `askServiceWorkerToFlush()`
- `useServiceWorkerUpdate()` — 登録と更新の通知（`/react`）
- `pf-field-sw build` — `worker/sw.ts` → `public/sw.js`（precache 一覧を差し込む）
- `OfflineQueueOptions.requireJobToken`

**Background Sync が無い場合（iOS）**

`requestQueueSync()` は「登録できたか」ではなく
**「前面での送信が要るか」**（`requiresForeground`）を返す。
iOS では常に true になり、送信は画面が開いている間のトリガに任せる。
劣化ではなく、iOS で取りうる唯一の経路。

**判断したこと**

- 認証済み HTML は Cache First にしない（middleware が `private, no-store` を付けている）
- 署名の発行・認証・アップロードは一切キャッシュしない
- 署名付きメディアはクエリを外した鍵で持つ（トークンがクエリに載るため）
- 更新を勝手に適用しない。入力途中でリロードされると書きかけが消える
- `sync` の失敗は握りつぶさない。reject させてブラウザに再試行させる

**不具合修正**

`Authorization: Bearer <jobToken>` の付与が `issueJobToken` の有無に依存していた。
Service Worker では発行できない（セッションが無い）ため、
**Background Sync 経由の送信だけトークンが落ちて 401 になる**状態だった。
付与は「トークンがあれば必ず」に変更し、必須かどうかは `requireJobToken` で表す。
