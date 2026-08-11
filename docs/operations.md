# 運用ガイド（監視・多タブ・容量・障害時）

現場で何かが起きたときに、**画面とログのどこを見れば原因に辿り着けるか**をまとめたもの。
API の使い方は [integration-nextjs.md](./integration-nextjs.md)、
設計の背景は [DESIGN.md](./DESIGN.md) にある。

---

## 1. 監視イベント（`onEvent`）

`FieldCoreConfig.onEvent` に渡すと、キューの内部で起きたことが流れてくる。
`type` で絞れば `data` の中身が型で確定する。

```ts
import { isFieldCoreEvent, type FieldCoreEvent } from "@palomapf-dev/pf-field-core";

const config = {
  // …
  onEvent: (event: FieldCoreEvent) => {
    if (event.type === "job.failed") {
      // event.data.kind は QueueErrorKind に確定している
      metrics.increment(`queue.failed.${event.data.kind}`);
    }
  },
};

// 配列から絞り込むとき
const failures = events.filter(isFieldCoreEvent("job.failed"));
```

`onEvent` の中で投げた例外は握りつぶされる。**監視の都合で送信を止めない**ため。

### 一覧

| `type` | いつ出るか | `data` |
|---|---|---|
| `job.enqueued` | ジョブを受け付けた | `jobId` / `type` / `attachments` / `totalBytes` |
| `job.retried` | 1件を手動で再送に戻した | `jobId` |
| `job.retried-all` | 一括で戻した（再ログイン後の救済） | `count` / `includeBlocked` / `skippedEntitlement` |
| `job.canceled` | 利用者が破棄した | `jobId` |
| `job.removed` | 一覧から削除した | `jobId` |
| `job.purged` | 成功済みを保持期間経過で片付けた | `count` |
| `job.succeeded` | サーバに届いた | `jobId` / `serverId?` |
| `job.failed` | 送信に失敗した | `jobId` / `kind` / `retryable` / `status` |
| `job.recovered` | 落ちた WebView が残した「送信中」を回収した | `count` |
| `sync.started` | ランナーが1周を始めた | `trigger` / `force` |
| `sync.finished` | 1周が終わった | `FlushResult` + `trigger` / `durationMs` |
| `sync.locked` | 他タブ・SW が送信中なので何もしなかった | `trigger` |
| `token.expired` | 送信トークンが期限切れだった | `jobId` |
| `token.cleared` | 未送信が無くなったのでトークンを破棄した | `count` |
| `clock.untrusted` | 端末時計のずれが測れず、期限判定を保留した | `jobId` |
| `storage.evicted` | ブラウザに保存データを消された痕跡を見つけた | `lostJobs` / `lastSeenAt` / `message` |
| `storage.not-persisted` | 永続化が拒否された | （なし） |

### 現場の報告からの引き方

| 現場の言い分 | 最初に見るイベント | 見どころ |
|---|---|---|
| 「送信が終わらない」 | `sync.finished` | `reason` が `unreachable` なら圏外側、`locked` なら他タブが送っている |
| 「何度ログインしても減らない」 | `job.failed` | `kind: "entitlement"` なら再ログインでは直らない（§4） |
| 「昨日撮ったぶんが消えた」 | `storage.evicted` | 出ていれば端末側の消失。出ていなければアプリのバグを疑う |
| 「送信中のまま止まる」 | `job.recovered` | 出ていれば WebView が落ちていた。次の周で送られる |
| 「iPhone だけ消える」 | `storage.not-persisted` | 永続化拒否。7日ルールに当たっている（§3） |

> `at` は**端末時計**の epoch ms。端末はずれることがあるので、
> サーバ側のログと突き合わせるときは `clock.untrusted` の有無も一緒に見る。

---

## 2. 多タブ・Service Worker

同じ端末で複数のタブ（や Service Worker）が同時に動くことを前提にしている。
噛み合わせは**排他**と**通知**の2つに分かれる。

### 排他 — 二重に送らない

送信ランナーは Web Locks（無ければ IndexedDB のリース）で1つに絞られる。
取れなかった側は `sync.locked` を出して**何もせずに戻る**。異常ではない。

サーバ側は冪等キー（`jobId`）で重複を吸収するが、
弱電界では無駄な通信そのものが害なので端末側でも絞っている。

リースの寿命は 30 秒。端末が落ちて解放できなかった場合も、
30 秒経てば他のタブが引き継げる。

### 通知 — 送った結果を他のタブへ伝える

排他だけだと、送信した側のタブは 0 件になり、
開いたままのもう一方は未送信バッジを抱えて残る。
現場から見ると「片方の画面では送れていない」になる。

そのため BroadcastChannel で変更を配っている。
受信側は 150ms ぶんをまとめて1回だけ数え直す。
Service Worker から送った場合も同じ経路で画面に届く。

BroadcastChannel が無い環境では黙って無効になる（単一タブの動作は変わらない）。
アプリ側の設定項目は無い（切る理由が無いため）。
`createOfflineQueue()` を直に呼ぶテストでだけ `crossTab: false` で止められる。

---

## 3. 容量

### 2つの上限

| | 何を見るか | 既定 | 超えたら |
|---|---|---|---|
| 端末の空き | `navigator.storage.estimate()` | 警告 50MB / 停止 20MB | `enqueue` を断る |
| 滞留量 | 未送信のジョブ数・添付枚数・バイト数 | 200件 / 200枚 / 160MB | `enqueue` を断る |

> **滞留量の既定は暫定値。** 実機の実測が出るまでの見積りで、確定値ではない。
> 上の 200枚 / 160MB は `createFieldCore()` 経由の値（1ジョブぶんの上限 × 20）。
> `createOfflineQueue()` を直に呼ぶと `DEFAULT_RETENTION` の 300枚 / 120MB になる
> （端末容量から積んだ別の見積り）。
> pf-setsubi の Android 実機パイロットの実測で**両方を揃えて**確定する予定なので、
> 変えるときは `src/core.ts` の `retention` と `src/db/quota.ts` の
> `DEFAULT_RETENTION` を必ず一緒に見ること。

マスタキャッシュの枠（既定 60MB）は**これとは別**。
マスタは取り直せるが未送信は端末にしか無いので、同じ枠で数えてはいけない。

```ts
const config = {
  storageQuota: {
    warnBelowBytes: 50 * 1024 * 1024,
    blockBelowBytes: 20 * 1024 * 1024,
  },
  queue: {
    // 滞留の上限はこの2つから決まる（1ジョブぶんの上限 × 20 が全体の上限）
    maxAttachmentsPerJob: 10,
    maxTotalAttachmentBytes: 8 * 1024 * 1024,
    // 成功したジョブを残す期間
    purgeSucceededAfterMs: 7 * 24 * 60 * 60 * 1000,
  },
};
```

### 逼迫したときの振る舞い

1. `enqueue` の直前に空きを測る
2. 逼迫していれば、まず**成功済みのジョブ**を片付ける（`purgeSucceeded(0)`）
3. それでも足りなければ **`FieldCoreError("quota_exceeded")` を投げて断る**

**未送信を自動で捨てることはしない。** 端末にしか無いデータで、捨てたら撮り直せない。
断って利用者に伝えるほうが正しい。

「撮る」は断られても「送る」は通る。ここを塞ぐと容量の減った端末が永久に回復できなくなる。

### UI に出すもの

`useOfflineQueue()` の `storage`（`StorageHealth`）を見る。

- `level: "warn"` — まだ入るが早めに送ってほしい。`reason` をそのまま出せる
- `level: "critical"` — もう入らない。**撮影の前に**出すこと。撮ってから断ると撮り直しになる
- `persistenceDenied: true` — iOS で珍しくない。7日使わないと消される可能性がある

---

## 4. 障害別の見え方と対処

### 認証切れ（401）

`blocked(auth)` に落ちる。写真も入力値も**端末に残る**。
`requiresReauth(error)` が `true` なので、再ログイン導線を出してよい。
再ログイン後は `retryAll({ includeBlocked: true })` で戻せる。

`blocked` のあいだは何度 `flush()` しても再試行しない。通らない通信を繰り返さないため。

### 利用権なし（403 `not_entitled`）

`blocked(entitlement)`。**再ログインしても直らない。**
`requiresAdmin(error)` が `true`。管理者への連絡を促す文言にする。

`retryAll()` は既定でこれを対象外にする。
分類だけ直しても救済導線が戻してしまえば、同じ理由で `blocked` に返るだけで
現場は無限に再ログインを繰り返すことになる。
利用権が付与されたあとは `retryAll({ includeBlocked: true, includeEntitlement: true })`。

> アップロード脚（署名付きURL）の 403 は意味が違い、署名の失効がほとんど。
> こちらは `expired` / 再試行可に分類される。恒久エラーにすると、
> 数秒後に成功したはずのジョブを失う。

### 端末時計のずれ

送信トークンの `expiresAt` はサーバ時刻で発行される。
端末時計と比べると、ずれた端末では有効なトークンを期限切れと誤判定し、
**一度も送信を試みないまま `blocked(auth)` に落ちる**。

サーバ応答の `Date` ヘッダからずれを測り、**測れていないうちは期限切れを理由に止めない**。
認証の正否を決めるのはサーバであって端末時計ではない。
このとき `clock.untrusted` が出る。

`describeClockSkew()` で「時計が約N分ずれています」と画面に出せる。

### ストレージ消失

iOS Safari の7日ルール、または端末の容量逼迫でブラウザが IndexedDB を捨てることがある。
localStorage に残した目印との差分で検知し、`storage.evicted` を出す（検知は best-effort）。

消えたものは戻せない。`storage.not-persisted` が出ている端末では、
未送信を長く抱えさせないよう UI で送信を促す。

---

## 5. 困ったときの確認手順

1. `useOfflineQueue()` の `counts` と `storage.level` を見る（画面に出ているはず）
2. `job.failed` の `kind` を見る — `auth` / `entitlement` / `network` で対処が違う
3. `sync.finished` の `reason` を見る — `unreachable` は圏外、`locked` は他タブ
4. `storage.evicted` が出ていないか見る — 出ていれば端末側の消失
5. ここまでで説明がつかなければ、`jobId` を添えて開発側へ
