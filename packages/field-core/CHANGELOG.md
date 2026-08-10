# @palomapf-dev/pf-field-core

## 0.1.0

### Minor Changes

- 2a93de4: M1: 画像圧縮を実装した。

  - `compressImage` / `compressImages` — 長辺 1440px・JPEG 品質 0.75 を起点に、
    200〜400KB へ収まる品質を二分探索する。直列処理で、弱い端末のメモリを溢れさせない
  - EXIF の Orientation を焼き込む。`createImageBitmap(blob, { imageOrientation: 'from-image' })`
    を優先し、未対応の環境では自前で変換行列を適用する
  - 撮影時刻（DateTimeOriginal）を `capturedAt` として拾い上げる。
    canvas 再エンコードで EXIF は落ちるため、構造化データ側でサーバへ送るための値
  - 品質を下げきっても大きい場合は、長辺を 0.85 倍して一度だけ再挑戦する
  - すでに条件を満たす写真、および**圧縮したほうが大きくなる写真は元のまま返す**
    （`renderer: 'passthrough'`）。1600px / 195KB の写真が 311KB に太る劣化を実測で見つけたため
  - 目標に収まらなくても失敗にはしない。「収まらなかった結果」を返す

  Worker へのオフロードは M1b へ延期した。OffscreenCanvas 経路では
  メインスレッドの詰まりが実測 0ms で、worker スクリプトを配る仕組みを足す割に得るものが無い。

  破壊的変更: `CompressImageOptions.useWorker` を削除（未実装のオプションを残さないため）。
  `ImageRenderer` に `'passthrough'` を追加し、canvas 経路だけを指す `CanvasRenderer` を分離した。

- 2a93de4: M2: IndexedDB による永続化とオフラインキューを実装した。

  - `createOfflineQueue` — 投入・一覧・件数・手動再送・破棄・購読。送信の実体（`JobProcessor`）は
    差し替え式にしてあり、キューの正しさは通信を 1 バイトも発生させずに検証できる
  - ジョブと画像 Blob をストアで分離。一覧表示のたびに数 MB を読まない
  - 状態遷移（`pending` / `active` / `succeeded` / `failed` / `blocked` / `canceled`）を純関数化。
    全 36 通りの遷移可否を表で検証している
  - 添付は 1 枚ごとに完了を記録する。3 枚中 2 枚まで送って圏外になっても、次回は残り 1 枚だけを送る
  - 排他は Web Locks、無い環境では IndexedDB のリース（TTL 30 秒・自動延長）
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
  - 有効期限は既定 26 時間。送信成功時とキューが空になった時点で破棄する
  - `safeFetch` / `classifyResponse` / `responseError` — `redirect: "manual"` を強制し、
    ログイン画面へのリダイレクトを成功と誤認しない。401 でもジョブは消さず `blocked(auth)` に残す

  破壊的変更: `QueueSnapshot` に `storage` を追加、`OfflineQueue` に `health()` と
  `destroy()` を追加。`config.auth` の形を送信トークン方式に変更。

### Patch Changes

- 2a93de4: M0（基盤整備）: パッケージの骨格と、後続のマイルストーンが向かう型の契約を用意した。

  - 単一パッケージ + サブパス exports（`.` / `./image` / `./storage` / `./react` / `./scanner` / `./sw` / `./server`）。ESM のみを出力する
  - キュー・ストレージ・送信・設定・Service Worker・スキャナの型を確定
  - 指数バックオフ（full jitter）— 既定は 2 秒から倍々、上限 5 分、10 回で打ち切り
  - エラー分類 — 「待てば直る見込みがあるか」だけで再試行と `blocked` を分ける
  - 画像処理の機能検出（`getImageCapabilities` / `probeImageCapabilities`）と `useImageCapabilities`
