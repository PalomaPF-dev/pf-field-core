# @palomapf-dev/pf-field-core

## 0.4.0

### Minor Changes

- f878dd0: M4: React バインディングと下書きの永続化。

  ```tsx
  // app/providers.tsx
  "use client";
  import { FieldCoreProvider } from "@palomapf-dev/pf-field-core/react";

  export function Providers({ children }) {
    return <FieldCoreProvider config={{ appId: "pf-setsubi", endpoints: { submit: {...} } }}>
      {children}
    </FieldCoreProvider>;
  }
  ```

  ```tsx
  const { counts, jobs, flush, retryAll, isSyncing } = useOfflineQueue();
  const { reachable } = useNetworkStatus();

  <button onClick={flush} disabled={isSyncing || !reachable}>
    未送信 {counts.unsent} 件を送信
  </button>;
  ```

  **新しい公開 API**

  - `configureFieldCore()` — 設定ひとつから一式（キュー・送信ランナー・URL 解決・下書き）を組む
  - `FieldCoreProvider` / `useFieldCore` / `useFieldCoreContext`
  - `useOfflineQueue()` / `useQueueJob()`
  - `useNetworkStatus()` / `useSignedUrl()` / `useSignedUrls()` / `useDraft()`
  - `createDraftStore()` / `createFileUrlResolver()`

  **下書きの永続化（`useDraft`）**

  Zebra 端末は WebView をバックグラウンドで kill する。点検の途中で端末を
  胸ポケットに入れた瞬間に入力が消えるなら、「圏外で入力を継続する」は成立しない。
  デバウンスして保存し、**画面を離れるときは待たずに書く**
  （`visibilitychange` / `pagehide`）。デバウンス待ちの時間がそのまま消えた入力になるため。

  **`useNetworkStatus` は `navigator.onLine` を信じない**

  `onLine` は「インタフェースが繋がっているか」しか見ておらず、
  弱電界・死んだゲートウェイ・認証切れのリダイレクトをすべて `true` と報告する。
  `false` は信用してよいが、**真だけが疑わしい**ので実際に叩いて確かめる。

  **`useSignedUrl` は往復を減らす**

  非公開バケットなので表示のたびに署名の発行が要る。
  素朴に書くと一覧に 20 枚あれば 20 往復するため、同じティックの要求をまとめ、
  期限内は使い回す。期限の 30 秒手前で捨てるので「表示した瞬間に切れていた」も避ける。

  **IndexedDB スキーマ v2**

  `drafts` ストアを追加。移行では既存のストアに触らない
  （未送信ジョブは端末にしか無いデータのため）。

## 0.3.0

### Minor Changes

- 6aca7cd: M3（サーバ側）: Supabase Storage 実装 + Route Handler + S3 実装。

  ```ts
  // app/api/uploads/sign/route.ts
  import {
    createSignUploadRoute,
    supabaseStorageFromEnv,
  } from "@palomapf-dev/pf-field-core/server";

  export const POST = createSignUploadRoute({
    provider: supabaseStorageFromEnv(), // SUPABASE_URL / SUPABASE_SECRET_KEY / SUPABASE_BUCKET
    appId: "pf-setsubi",
    authorize: async (request) => {
      const session = await requireSession(request);
      return session
        ? { userId: session.userId, companyId: session.companyId }
        : undefined;
    },
  });
  ```

  **新しい公開 API（`/server` サブパス）**

  - `createSupabaseStorageProvider()` / `supabaseStorageFromEnv()`
  - `createSignUploadRoute()` / `createSignViewRoute()` — 2 本の Route Handler
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
  防御にならない。守っているのは `authorize()`・サーバ側パス生成・閲覧時の会社照合の 3 つだけ。
  RLS ポリシーを未作成にしているのは anon からの直接操作を全拒否するためで、
  サーバ経路の安全性とは別の話。詳細は `docs/supabase-setup.md`。

  **S3 実装の署名は AWS 公式の計算例と一致することを検証済み**（SigV4 を自前実装しているため）。

  **未確認**: 実エンドポイントでの確認（3-b）は未実行。
  開発環境から `*.supabase.co` へ到達できないため。
  `pnpm verify:supabase` を鍵のある環境で 1 回流せば確定する。
  外れうるのは `bodyMode`（`binary` / `form-data`）だけで、
  その場合の変更は `server/supabase.ts` の 1 箇所に閉じ、端末側は影響を受けない。

- 6aca7cd: M3（端末側）: 送信ランナー — 署名 → アップロード → 本体送信。

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

  **M3 の必須要件 3 点は実装で満たしている**

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
