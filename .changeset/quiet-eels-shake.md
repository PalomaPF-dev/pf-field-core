---
"@palomapf-dev/pf-field-core": minor
---

M7（堅牢化）: 監視イベントの型付け、タブ間の状態同期、障害系の固め。

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
}

// 配列から絞るとき
const failures = events.filter(isFieldCoreEvent("job.failed"));
```

**実行時の形は 0.6.0 までと同じ**（`{ type, at, data? }`）なので、
既に `onEvent` を繋いでいるアプリは無改修で動く。

新設したイベント:

| `type` | 意味 |
|---|---|
| `sync.started` / `sync.finished` | ランナー1周の開始と結果（`FlushResult` + `durationMs`）|
| `sync.locked` | 他タブ・SW が送信中なので何もしなかった。**異常ではない** |

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

- BroadcastChannel で変更を配る。受信側は 150ms ぶんをまとめて1回だけ数え直す
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
