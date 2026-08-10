# @palomapf-dev/pf-field-core

## 0.2.0

### Minor Changes

- fb93ba9: iOS 対応: 端末能力の公開 API と、Background Sync 非対応時のフォールバック。

  現場端末は将来的に Zebra Android だが、当面は iPhone も併用する。
  両者は送信の振る舞いが根本的に違う（Background Sync の有無）ため、
  UI が出し分けられるように能力判定を公開した。

  **`capabilities`（他アプリの UI 実装が依存するインターフェース）**

  ```ts
  import { useCapabilities } from "@palomapf-dev/pf-field-core/react";

  const { capabilities, syncDescription } = useCapabilities();

  {
    capabilities.requiresForegroundToSend && (
      <p>送信完了までアプリを開いたままにしてください</p>
    );
  }
  {
    capabilities.hardwareScanner ? <ScannerInput /> : <ManualInput />;
  }
  ```

  - `detectCapabilities()` / `probeCapabilities()` / `describeSyncBehaviour()` / `detectPlatform()`
  - `platform` は iPadOS が Mac を名乗る件をタッチ点数で判別する
  - `hardwareScanner` は iOS で false（DataWedge は Zebra 専用）。誤判定に備えて上書きできる
  - `detectCapabilities()` は副作用が無く同期で返るので、初回描画から正しい値になる

  **Background Sync 非対応時のフォールバック**

  「iOS では送信されない」ではなく「開いている間は送信される」。
  アプリを開いたとき・前面復帰・フォーカス・**bfcache からの復帰**・定期実行・オンライン復帰の
  すべてで送信が走ることをテストで固定した。`pageshow` の追加は iOS 固有の対策
  （アプリ間を行き来すると `visibilitychange` が期待どおり来ないことがある）。

  **iOS Safari のストレージ制約**

  - `persist()` が拒否されても機能は止めない。未送信を抱えている間だけ `warn` にして送信を促す
  - 容量逼迫時は `enqueue` を断る前に送信済みジョブを片付ける
  - IndexedDB の消失を検知して `storage.evicted` イベントを出す（best-effort）。
    `StorageHealth` に `persistenceSupported` / `persistenceDenied` / `evictionSuspected` を追加

  **添付の保存形式を Blob からバイト列へ（iOS でキューが動かなかった実欠陥）**

  WebKit は IndexedDB に `Blob` を入れるときディスク上のファイルへ退避する経路を通る。
  その経路が使えない状況（プライベートブラウズ、E2E の一時プロファイル）では
  `UnknownError: Error preparing Blob/File data to be stored in object store` で
  書き込みごと失敗し、**写真を 1 枚も預かれない**。WebKit を E2E に入れて発覚した。

  `StoredBlob` を `{ data: ArrayBuffer; contentType: string }` に変更し、
  読み出し時に `Blob` を組み立て直す。公開 API（`getAttachmentBlob()`）の戻り値は
  `Blob` のままなので**利用側の変更は不要**。0.1.0 までに保存された Blob 形式の
  レコードもそのまま読める（更新した端末が未送信の写真を失わないため）。

  同じ理由で、書き込みトランザクションの内側では IndexedDB 以外の `await` をしない
  （Safari はそこでトランザクションを確定させる）。

  **その他**

  - E2E に WebKit（iPhone 13）プロジェクトを追加。エンジン差のある値は断定せず不変条件で検証する
  - `ScannerListener.simulate()` を `submitManual()` に改名（手入力フォールバックの経路であることを明示）

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
