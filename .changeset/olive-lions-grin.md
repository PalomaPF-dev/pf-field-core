---
"@palomapf-dev/pf-field-core": minor
---

M6（前半）: マスタのローカルキャッシュ。圏外で点検を新規に開始するための土台。

```tsx
const { items } = useMaster<Equipment>("equipment");
const { prefetch } = usePrefetchMedia();

// 点検開始時に、その点検のぶんだけ先読みする
await prefetch({ groupId: sheetId, refs: [normalSampleRef, pinMapRef] });

const { url, showOnlineOnlyNotice, reportUnavailable } = useCachedMedia(ref);
{url ? <img src={url} onError={reportUnavailable} />
     : showOnlineOnlyNotice && <p>オンライン時に表示されます</p>}
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

マスタ用の枠は未送信ジョブとは**別**（既定60MB、古い順に破棄）。
マスタは取り直せるが未送信は端末にしか無いので、同じ枠で数えてはいけない。
