# pf-field-core

現場系アプリ4本（**pf-setsubi / pf-hinshitsu / pf-zaiko / pf-keisoku**）が共通で使う
オフライン・アップロード基盤ライブラリ。

Zebra Android ハンディ端末で、工場建屋内の圏外・弱電界エリアでも
点検結果と現場写真を取りこぼさずにサーバへ届けることを目的とする。

- 設計: [`docs/DESIGN.md`](docs/DESIGN.md)
- 認証まわりの調査結果: [`docs/auth-findings.md`](docs/auth-findings.md)
- アプリへの組み込み手順: [`docs/integration-nextjs.md`](docs/integration-nextjs.md)
- 運用（監視イベント・多タブ・容量・障害時）: [`docs/operations.md`](docs/operations.md)

## 現在の状態

**M0（基盤整備）完了。** 使えるのは以下。

| 機能 | 状態 |
|---|---|
| 型の契約（キュー / ストレージ / 送信 / 設定 / SW / スキャナ） | ✅ |
| 指数バックオフの計算 | ✅ |
| エラー分類（再試行可 / 人手が要る） | ✅ |
| 画像処理の機能検出（実機診断用） | ✅ |
| 画像圧縮（EXIF・向きの焼き込み・品質の二分探索） | ✅ |
| Worker へのオフロード | M1b（実測しだい）|
| IndexedDB キュー | M2 |
| 署名付きURL・送信ランナー | M3 |
| React フック | M4 |
| Service Worker / Background Sync | M5 |
| DataWedge 連携 | M6 |

マイルストーンの定義は [`docs/DESIGN.md` §4](docs/DESIGN.md#4-実装順序とマイルストーン)。

## 構成

```
packages/field-core/   @palomapf-dev/pf-field-core（配布物）
apps/playground/       検証用 Next.js アプリ（実機診断・E2E の対象）
test/e2e/              Playwright
docs/                  設計・調査・手順
```

## 開発

```bash
pnpm install
pnpm build        # packages/field-core を dist へ
pnpm verify       # 型検査 + Lint + ユニットテスト + ビルド（CI と同じ）
pnpm test:e2e     # Playwright（playground を本番ビルドして実行）
pnpm playground   # 検証アプリの開発サーバ（http://localhost:5190）
```

`apps/playground` は `exports` マップ経由で `dist` を読む。実アプリと同じ経路なので、
**`pnpm build` を先に走らせること**（`pnpm test:e2e` は自動で行う）。

### 実機での確認

Zebra 端末で playground を開いて、2つの画面から実測値を採る。

| 画面 | 用途 |
|---|---|
| `/diagnostics` | `imageOrientation: 'from-image'` の対応可否など、画像処理まわりの対応状況を JSON で採取 |
| `/bench` | テスト画像6枚（4000x3000 を含む、向き 1/3/6/8）または端末の写真で圧縮を計測。<br>所要時間・出力サイズ・向きの一致・**メインスレッドの詰まり**を表示 |

`/bench` の「メインスレッドの詰まり」が Worker オフロード（M1b）を入れるかどうかの判断材料。
デスクトップ Chromium では 0ms（詰まりなし）だった。

### ブラウザを別管理している環境

`PLAYWRIGHT_CHROMIUM_EXECUTABLE` に実行ファイルのパスを渡すと、
Playwright 管理の Chromium ではなくそちらを使う。

```bash
PLAYWRIGHT_CHROMIUM_EXECUTABLE=/path/to/chrome pnpm test:e2e
```

## リリース

[changesets](https://github.com/changesets/changesets) で運用する。

```bash
pnpm changeset      # 変更内容を記録（PR に含める）
```

`main` にマージされると Release ワークフローが「バージョン更新」PR を作り、
その PR をマージすると GitHub Packages へ公開される。

版数は `package.json` からビルド時に `VERSION` へ差し込まれる。手で書かないこと。

> **リポジトリ設定が必要**: Settings → Actions → General → Workflow permissions の
> 「Allow GitHub Actions to create and approve pull requests」を有効にしておく。
> 無効だと、ブランチ `changeset-release/main` の push までは成功するが PR 作成で失敗する。
> その場合はそのブランチから手で PR を作ってマージすれば publish まで進む。

`1.0.0` に到達するまでは `0.x`。破壊的変更もマイナーで出す。

## ライセンス

社内利用限定（UNLICENSED）。
