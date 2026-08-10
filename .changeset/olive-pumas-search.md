---
"@palomapf-dev/pf-field-core": minor
---

M1: 画像圧縮を実装した。

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
