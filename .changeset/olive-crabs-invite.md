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

**その他**

- E2E に WebKit（iPhone 13）プロジェクトを追加。エンジン差のある値は断定せず不変条件で検証する
- `ScannerListener.simulate()` を `submitManual()` に改名（手入力フォールバックの経路であることを明示）
