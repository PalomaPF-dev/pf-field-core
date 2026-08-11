# pf-field-core

現場系アプリ4本（**pf-setsubi / pf-hinshitsu / pf-zaiko / pf-keisoku**）が共通で使う
オフライン・アップロード基盤ライブラリ。

Zebra Android ハンディ端末と iPhone で、工場建屋内の圏外・弱電界エリアでも
点検結果と現場写真を取りこぼさずにサーバへ届けることを目的とする。

- 設計: [`docs/DESIGN.md`](docs/DESIGN.md)
- 認証まわりの調査結果: [`docs/auth-findings.md`](docs/auth-findings.md)
- アプリへの組み込み手順: [`docs/integration-nextjs.md`](docs/integration-nextjs.md)
- 運用（監視イベント・多タブ・容量・障害時）: [`docs/operations.md`](docs/operations.md)

## 現在の状態

**`0.7.0`（M0〜M7 完了、DataWedge を除く）。**

| 機能 | 状態 | 入口 |
|---|---|---|
| 画像圧縮（EXIF・向きの焼き込み・品質の二分探索） | ✅ | `/image` |
| IndexedDB キュー（滞留上限・排他・送信トークン） | ✅ | `createFieldCore()` |
| 署名付きURL・送信ランナー（Supabase / S3） | ✅ | `/storage`, `/server` |
| React バインディング（Provider・各フック・下書き） | ✅ | `/react` |
| Service Worker / Background Sync（iOS フォールバック込み） | ✅ | `/sw`, `pf-field-sw build` |
| マスタのローカルキャッシュ（一覧の全置換・メディアの先読み） | ✅ | `useMaster` / `useCachedMedia` |
| 端末能力の検出（Android / iOS の出し分け） | ✅ | `/` の `capabilities` |
| 監視イベント・多タブ同期・障害系 | ✅ | [`docs/operations.md`](docs/operations.md) |
| **DataWedge 連携** | **Zebra 実機の到着待ち** | `/scanner`（型のみ） |
| Worker へのオフロード | M1b（実機の実測しだい・現状は不要） | — |

未確定の項目（実機・実環境の確認待ち）:

- **実 Supabase での署名〜転送の疎通**（`pnpm verify:supabase`）
- **滞留上限の既定値** — 200枚 / 160MB は暫定値。実測後に確定する（[operations.md](docs/operations.md#3-容量)）
- **圧縮の実機実測** — デスクトップでは中央値 150ms。Zebra 実機での採取が要る

`1.0.0` は「4アプリが同一メジャーで動く」ことへの約束になるので、
DataWedge と pf-setsubi の実地投入が済むまで出さない。

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

> **⚠ リポジトリ設定が未了のあいだの運用**
>
> Settings → Actions → General → Workflow permissions の
> 「Allow GitHub Actions to create and approve pull requests」が**無効**だと、
> Release ワークフローはバージョン更新 PR を作れずに**失敗する**。
>
> このとき `main` の Actions は「機能 PR をマージ → 赤（PR を作れない）」
> 「バージョン PR をマージ → 緑（publish 成功）」が交互に並ぶ。
> **publish 自体は成功している**が、赤が常態化するので本物の失敗を見落としやすい。
> 設定を有効にすれば解消する。
>
> 有効にするまでは、手で次を行えば publish まで進む:
>
> ```bash
> git checkout -b claude/version-x.y.z origin/main
> pnpm version-packages      # changeset を消化して版数を上げる
> git add .changeset packages/field-core/CHANGELOG.md packages/field-core/package.json
> git commit -m "chore: バージョン更新 — @palomapf-dev/pf-field-core x.y.z"
> git push -u origin claude/version-x.y.z
> # この PR を main へマージすると Release が publish まで進む
> ```

`1.0.0` に到達するまでは `0.x`。破壊的変更もマイナーで出す。

## ライセンス

社内利用限定（UNLICENSED）。
