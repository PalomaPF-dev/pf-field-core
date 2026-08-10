import { defineConfig, type Options } from "tsup";

/**
 * ESM のみを出力する。
 * 利用側は Next.js 16 / Node 20+ の4アプリに限られており、CJS を出す理由が無い。
 * 二重出力をやめることでビルド時間と dist サイズ、`require`/`import` の取り違えによる
 * 「同じモジュールが2つ読み込まれる」事故をまとめて避けられる。
 */
const shared: Options = {
  format: ["esm"],
  target: "es2022",
  platform: "neutral",
  dts: true,
  sourcemap: true,
  clean: false, // package.json の clean スクリプトが担当（複数 config が dist を消し合わないため）
  treeshake: true,
};

export default defineConfig([
  {
    ...shared,
    entry: {
      index: "src/index.ts",
      image: "src/image/index.ts",
      storage: "src/storage/index.ts",
      scanner: "src/scanner/index.ts",
      sw: "src/sw/index.ts",
      server: "src/server/index.ts",
    },
  },
  {
    ...shared,
    /**
     * React 用エントリは先頭の "use client" を残す必要がある。
     * ソース先頭のディレクティブは esbuild が保持してくれるが、
     * treeshake（rollup の後段パス）を通すと落ちるのでここだけ無効にする。
     * 落ちていないことは scripts/verify-build.mjs がビルドのたびに検査する。
     */
    entry: { react: "src/react/index.ts" },
    external: ["react"],
    treeshake: false,
  },
  {
    ...shared,
    // CLI は Node で直接実行する
    entry: { cli: "src/cli/index.ts" },
    platform: "node",
    banner: { js: "#!/usr/bin/env node" },
  },
]);
