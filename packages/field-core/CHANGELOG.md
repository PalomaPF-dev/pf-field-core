# @palomapf-dev/pf-field-core

## 0.7.0

### Minor Changes

- b5aa162: M7（堅牢化）: 監視イベントの型付け、タブ間の状態同期、障害系の固め。

  ## 監視イベントに型が付いた

  `onEvent` は `{ type: string; data?: Record<string, unknown> }` だった。
  現場からの報告と突き合わせるとき、ログから何が起きたか読み取れず、
  `data` の中身も型で保証されていなかった。

  ```ts
  onEvent: (event) => {
    if (event.type === "job.failed") {
      // event.data.kind は QueueErrorKind に確定する
      metrics.increment(`queue.failed.${event.data.kind}`);
    }
  };

  // 配列から絞るとき
  const failures = events.filter(isFieldCoreEvent("job.failed"));
  ```

  **実行時の形は 0.6.0 までと同じ**（`{ type, at, data? }`）なので、
  既に `onEvent` を繋いでいるアプリは無改修で動く。

  新設したイベント:

  | `type`                           | 意味                                                      |
  | -------------------------------- | --------------------------------------------------------- |
  | `sync.started` / `sync.finished` | ランナー 1 周の開始と結果（`FlushResult` + `durationMs`） |
  | `sync.locked`                    | 他タブ・SW が送信中なので何もしなかった。**異常ではない** |

  一覧と、現場の言い分からの引き方は [運用ガイド](../docs/operations.md) に。

  ## タブ間で未送信の状態が揃うようになった（不具合修正）

  排他（`lock.ts`）は「二重に送らない」ためのもので、
  **送った結果を他のタブへ伝える役目は持っていなかった**。
  そのため送信した側のタブだけが 0 件になり、
  開いたままのもう一方は未送信バッジを抱えて残っていた。
  現場から見ると「片方の画面では送れていない」で、問い合わせになる。

  `use-queue.ts` には「送信は Service Worker からも別タブからも進む」と
  書いてあったが、`queue.subscribe()` は自分のインスタンスの変更でしか
  発火しておらず、設計意図とコードが食い違っていた。

  - BroadcastChannel で変更を配る。受信側は 150ms ぶんをまとめて 1 回だけ数え直す
  - Service Worker から送った場合も同じ経路で画面に届く
  - BroadcastChannel が無い環境では黙って無効になる（単一タブの動作は不変）

  アプリ側の設定項目は増えていない。

  ## 障害系

  「分類が正しいか」の先で、**障害のあと現場がどうなるか**を固めた。

  - 容量で断られても、既にある未送信は消えない（写真の実体まで確認）
  - **逼迫していても送信はできる。** ここを塞ぐと容量の減った端末が永久に戻れない
  - 空きが戻らないなら、未送信を捨てずに断る（端末にしか無いデータのため）
  - 認証切れで `blocked` になっても写真は残り、再ログイン後に送り切れる
  - `blocked` のあいだは何度 `flush()` しても再試行しない

  ## ドキュメント

  `docs/operations.md` を追加。監視イベント一覧、多タブの噛み合わせ、
  容量の調整、障害別の見え方と対処。

## 0.6.0

### Minor Changes

- 1f05dd4: M7（一部）: 認証エラーの 2 分類と、端末時計のずれへの耐性。

  ## 403 not_entitled を auth と分ける（**破壊的変更に近い挙動変更**）

  pf-portal の調査で、認証エラーが 2 種類あることが確定した。

  | 応答               | 意味               | 復帰                           |
  | ------------------ | ------------------ | ------------------------------ |
  | 401 `auth_expired` | 認証切れ           | **再ログインで復帰できる**     |
  | 403 `not_entitled` | 利用権・課金ゲート | **再ログインしても復帰しない** |

  これまで 401 と 403 はどちらも `kind: "auth"` に落ちていた。
  UI が再ログイン導線を出す条件をこれで判断していると、
  利用権が無いジョブにも導線が出て、**現場が無限に再ログインを繰り返す**。

  - `QueueErrorKind` に `"entitlement"` を追加
  - `requiresReauth(error)` / `requiresAdmin(error)` で UI が導線を出し分けられる
  - 403 の文言に「再ログインでは解決しません」を明記
  - **`retryAll()` は既定で entitlement を対象外にする**。
    分類だけ直しても、再ログイン後の救済導線が戻してしまえば同じ堂々巡りになる。
    管理者が利用権を付与したあとは `includeEntitlement: true` か個別の `retry()`
  - 本文の `{"error":"not_entitled"}` はステータスより優先する

  **アップロード経路の 403 は意味が違う。** 署名付き URL の失効がほとんどで、
  次回は再署名すれば通る。`expired` / 再試行可に分類する
  （これまでは恒久エラーとして扱っていた）。

  ## 端末時計のずれ

  送信トークンの `expiresAt` は**サーバ時刻**で発行されるのに、
  端末は**端末時計**と比べていた。ハンディ端末の時計は数時間ずれることがあり、
  有効なトークンを「期限切れ」と誤判定すると、
  M3 の最適化（期限切れなら通信しない）と噛み合って
  **一度も送信を試みないまま `blocked(auth)` に落ちる**。

  - サーバ応答の `Date` ヘッダからずれを測る（専用の往復は不要）
  - **測れていないうちは、期限切れを理由に送信を止めない。**
    認証の正否を決めるのはサーバであって端末時計ではない
  - `judgeExpiry()` は「期限切れか」と「その判断を信じてよいか」を返す
  - `describeClockSkew()` で「時計が約 N 分ずれています」と画面に出せる

- f64a529: M6（前半）: マスタのローカルキャッシュ。圏外で点検を新規に開始するための土台。

  ```tsx
  const { items } = useMaster<Equipment>("equipment");
  const { prefetch } = usePrefetchMedia();

  // 点検開始時に、その点検のぶんだけ先読みする
  await prefetch({ groupId: sheetId, refs: [normalSampleRef, pinMapRef] });

  const { url, showOnlineOnlyNotice, reportUnavailable } = useCachedMedia(ref);
  {
    url ? (
      <img src={url} onError={reportUnavailable} />
    ) : (
      showOnlineOnlyNotice && <p>オンライン時に表示されます</p>
    );
  }
  ```

  **新しい公開 API**

  - `core.master` / `createMasterCache()`
  - `useMaster()` / `useCachedMedia()` / `usePrefetchMedia()`
  - `config.master`（`scope` / `fetchCollections` / `limits`）
  - IndexedDB スキーマ v3（`masters` / `assets`。既存ストアには触らない）

  **方式**

  - 一覧系（設備台帳・点検表・職場）は**全置換**。起動時とオンライン復帰時に更新
  - メディア（正常見本・図面ピン）は**点検開始時に該当分だけ先読み**。
    全設備分は持たない（容量が持たない）
  - 取得範囲は会社・工場のスコープに限定する。
    容量のためだけでなく、**全社分を端末に置くとテナント分離が端末の中で崩れる**ため

  **表示可否**

  `MediaAvailability` の `unavailable` が「オンライン時に表示されます」を出す条件。
  「読み込み失敗」「画像がありません」と出してはいけない（データの不備に見える）。

  `navigator.onLine` は信じない。真でも実際には通らないことがあるため、
  `<img onError>` から `reportUnavailable()` を呼んで落とせる経路を用意した。

  **容量**

  マスタ用の枠は未送信ジョブとは**別**（既定 60MB、古い順に破棄）。
  マスタは取り直せるが未送信は端末にしか無いので、同じ枠で数えてはいけない。

## 0.5.0

### Minor Changes

- a7c7737: M4: React バインディングと下書きの永続化。

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

- a7c7737: M5: Service Worker と Background Sync（iOS フォールバック込み）。

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
