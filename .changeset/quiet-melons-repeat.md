---
"@palomapf-dev/pf-field-core": minor
---

M2: IndexedDB による永続化とオフラインキューを実装した。

- `createOfflineQueue` — 投入・一覧・件数・手動再送・破棄・購読。送信の実体（`JobProcessor`）は
  差し替え式にしてあり、キューの正しさは通信を1バイトも発生させずに検証できる
- ジョブと画像 Blob をストアで分離。一覧表示のたびに数MBを読まない
- 状態遷移（`pending` / `active` / `succeeded` / `failed` / `blocked` / `canceled`）を純関数化。
  全36通りの遷移可否を表で検証している
- 添付は1枚ごとに完了を記録する。3枚中2枚まで送って圏外になっても、次回は残り1枚だけを送る
- 排他は Web Locks、無い環境では IndexedDB のリース（TTL 30秒・自動延長）
- `active` のまま取り残されたジョブの回収。WebView が kill されても「送信中」で固まらない。
  試行回数は増やさない（端末が落ちたのはサーバのせいではないため）

端末ストレージ:

- `navigator.storage.persist()` を初期化時に要求し、拒否されたら警告イベントを出す
- `estimate()` の残量と滞留量を `StorageHealth` にまとめ、`QueueSnapshot.storage` で購読できる。
  「入らなくなってから気づく」を避けるため、warn の段階で UI に出せる
- 容量・滞留の上限に達したら `enqueue` が `QuotaExceededError` を投げる。
  **既存の未送信ジョブは絶対に消さない**（端末にしか無いデータのため）
- 滞留上限は設定で変更できる: `retention.maxUnsentJobs` / `maxUnsentAttachments` /
  `maxUnsentBytes` / `succeededMaxAgeMs` / `staleUnsentAfterMs`

認証（M3 の要件を先行して型とヘルパで固定）:

- `config.auth.issueJobToken` — ジョブ投入時（認証が生きているうち）に
  そのジョブ専用の送信トークンを受け取り、`tokens` ストアへ保管する。Cookie ではない
- 有効期限は既定26時間。送信成功時とキューが空になった時点で破棄する
- `safeFetch` / `classifyResponse` / `responseError` — `redirect: "manual"` を強制し、
  ログイン画面へのリダイレクトを成功と誤認しない。401 でもジョブは消さず `blocked(auth)` に残す

破壊的変更: `QueueSnapshot` に `storage` を追加、`OfflineQueue` に `health()` と
`destroy()` を追加。`config.auth` の形を送信トークン方式に変更。
