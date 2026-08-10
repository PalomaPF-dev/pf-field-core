---
"@palomapf-dev/pf-field-core": minor
---

iOS 対応: 端末能力の公開 API と、Background Sync 非対応時のフォールバック。

現場端末は将来的に Zebra Android だが、当面は iPhone も併用する。
両者は送信の振る舞いが根本的に違う（Background Sync の有無）ため、
UI が出し分けられるように能力判定を公開した。

**`capabilities`（他アプリの UI 実装が依存するインターフェース）**

```ts
import { useCapabilities } from "@palomapf-dev/pf-field-core/react";

const { capabilities, syncDescription } = useCapabilities();

{capabilities.requiresForegroundToSend && (
  <p>送信完了までアプリを開いたままにしてください</p>
)}
{capabilities.hardwareScanner ? <ScannerInput /> : <ManualInput />}
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
書き込みごと失敗し、**写真を1枚も預かれない**。WebKit を E2E に入れて発覚した。

`StoredBlob` を `{ data: ArrayBuffer; contentType: string }` に変更し、
読み出し時に `Blob` を組み立て直す。公開 API（`getAttachmentBlob()`）の戻り値は
`Blob` のままなので**利用側の変更は不要**。0.1.0 までに保存された Blob 形式の
レコードもそのまま読める（更新した端末が未送信の写真を失わないため）。

同じ理由で、書き込みトランザクションの内側では IndexedDB 以外の `await` をしない
（Safari はそこでトランザクションを確定させる）。

**その他**

- E2E に WebKit（iPhone 13）プロジェクトを追加。エンジン差のある値は断定せず不変条件で検証する
- `ScannerListener.simulate()` を `submitManual()` に改名（手入力フォールバックの経路であることを明示）
