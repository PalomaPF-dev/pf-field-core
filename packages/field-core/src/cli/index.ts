import { buildServiceWorker } from "./build-sw.js";
import { VERSION } from "../version.js";

/**
 * `pf-field-sw` — Service Worker のビルド CLI。
 * 各アプリの prebuild で `worker/sw.ts` → `public/sw.js` を生成する。
 */

const HELP = `pf-field-sw — Service Worker ビルド CLI

  使い方:
    pf-field-sw build [オプション]

  オプション:
    --entry <path>    入力。既定 worker/sw.ts
    --out <path>      出力。既定 public/sw.js
    --public <path>   precache を探す起点。既定 public
    --build-id <id>   ビルド識別子。既定は資産の内容から求める
    --no-minify       圧縮しない（デバッグ用）

  組み込み例（package.json）:
    "prebuild": "pf-field-sw build"

  設計は docs/DESIGN.md §2.5 を参照。
`;

function flag(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

export async function run(argv: string[]): Promise<number> {
  const command = argv[2];

  if (command === undefined || command === "--help" || command === "-h") {
    process.stdout.write(HELP);
    return 0;
  }

  if (command === "--version" || command === "-v") {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }

  if (command === "build") {
    try {
      const result = await buildServiceWorker({
        entry: flag(argv, "--entry") ?? "worker/sw.ts",
        out: flag(argv, "--out") ?? "public/sw.js",
        publicDir: flag(argv, "--public") ?? "public",
        minify: !argv.includes("--no-minify"),
        ...(flag(argv, "--build-id") ? { buildId: flag(argv, "--build-id")! } : {}),
      });

      process.stdout.write(
        `Service Worker を生成しました: ${result.outFile}\n` +
          `  ${(result.bytes / 1024).toFixed(1)}KB / precache ${result.precacheCount} 件\n`,
      );
      return 0;
    } catch (error) {
      process.stderr.write(
        `Service Worker のビルドに失敗しました: ${
          error instanceof Error ? error.message : String(error)
        }\n`,
      );
      return 1;
    }
  }

  process.stderr.write(`不明なコマンドです: ${command}\n\n${HELP}`);
  return 2;
}

void run(process.argv).then((code) => {
  process.exitCode = code;
});
