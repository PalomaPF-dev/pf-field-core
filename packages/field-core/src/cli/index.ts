/**
 * `pf-field-sw` — Service Worker のビルド CLI。
 * 各アプリの prebuild で `worker/sw.ts` → `public/sw.js` と precache manifest を生成する。
 *
 * 実装は M5。M0 では、配線が正しいこと（bin が解決でき、実行できること）だけを確かめる。
 */

const HELP = `pf-field-sw — Service Worker ビルド CLI

  使い方:
    pf-field-sw build [--entry worker/sw.ts] [--out public/sw.js]

  状態:
    未実装です（M5 で実装予定）。
    現時点では設計の確認用に bin の配線だけが入っています。
    設計は docs/DESIGN.md §2.5 を参照してください。
`;

export function run(argv: string[]): number {
  const command = argv[2];

  if (command === undefined || command === "--help" || command === "-h") {
    process.stdout.write(HELP);
    return 0;
  }

  if (command === "--version" || command === "-v") {
    process.stdout.write("0.0.1\n");
    return 0;
  }

  if (command === "build") {
    process.stderr.write(
      "pf-field-sw build は未実装です（M5 で実装予定）。\n" +
        "M4 までは Service Worker を使わない構成で動作します。\n",
    );
    return 1;
  }

  process.stderr.write(`不明なコマンドです: ${command}\n\n${HELP}`);
  return 2;
}

process.exitCode = run(process.argv);
