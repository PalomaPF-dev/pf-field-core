---
"@palomapf-dev/pf-field-core": patch
---

M0（基盤整備）: パッケージの骨格と、後続のマイルストーンが向かう型の契約を用意した。

- 単一パッケージ + サブパス exports（`.` / `./image` / `./storage` / `./react` / `./scanner` / `./sw` / `./server`）。ESM のみを出力する
- キュー・ストレージ・送信・設定・Service Worker・スキャナの型を確定
- 指数バックオフ（full jitter）— 既定は 2秒から倍々、上限5分、10回で打ち切り
- エラー分類 — 「待てば直る見込みがあるか」だけで再試行と `blocked` を分ける
- 画像処理の機能検出（`getImageCapabilities` / `probeImageCapabilities`）と `useImageCapabilities`
