# @palomapf-dev/pf-field-core

現場系アプリ（pf-setsubi / pf-hinshitsu / pf-zaiko / pf-keisoku）共通の
オフライン・アップロード基盤。

```bash
pnpm add @palomapf-dev/pf-field-core
```

取得には GitHub Packages の設定が要る。手順は
[`docs/integration-nextjs.md`](https://github.com/PalomaPF-dev/pf-field-core/blob/main/docs/integration-nextjs.md)。

## エントリ

| サブパス | 内容 | 実行環境 |
|---|---|---|
| `.` | 型の契約、バックオフ、エラー分類、下回り | どこでも |
| `./image` | 画像圧縮・機能検出 | ブラウザ / Worker |
| `./storage` | ストレージ抽象（`StorageAdapter`） | ブラウザ / SW |
| `./react` | React フック（`"use client"`） | ブラウザ |
| `./scanner` | DataWedge 連携 | ブラウザ |
| `./sw` | Service Worker ビルダー | Service Worker |
| `./server` | Route Handler・`StorageProvider` | **サーバ専用** |

`./server` は `SUPABASE_SECRET_KEY` を読む。
クライアントコンポーネントから import してはいけない
（ビルド時とテストで、他のエントリからここへ到達できないことを検査している）。

ESM のみを出力する。Next.js 16 / Node 20+ が前提。

## 現在の状態（M0）

型の契約・バックオフ・エラー分類・画像機能検出まで。
圧縮は M1、キューは M2、送信は M3、React フックは M4、Service Worker は M5、
DataWedge は M6。

設計は
[`docs/DESIGN.md`](https://github.com/PalomaPF-dev/pf-field-core/blob/main/docs/DESIGN.md)。
