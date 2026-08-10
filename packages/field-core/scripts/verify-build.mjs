#!/usr/bin/env node
/**
 * ビルド成果物の検査。
 *
 * ここで見ているのは「型検査もユニットテストも通るのに、配ったら壊れている」たぐいの事故:
 *   - "use client" が落ちて、React フックが Server Component 扱いになる
 *   - CLI の shebang が落ちて、bin として実行できない
 *   - exports に書いたのに dist にファイルが無い
 * いずれも実際に一度は踏んだことのある類なので、ビルドの一部として毎回確かめる。
 */
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(packageRoot, "dist");
const pkg = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));

const failures = [];

function check(condition, message) {
  if (!condition) failures.push(message);
}

// 1. exports に書いたファイルがすべて存在する
for (const [subpath, value] of Object.entries(pkg.exports)) {
  if (subpath === "./package.json" || typeof value === "string") continue;
  for (const file of [value.types, value.default].filter(Boolean)) {
    check(existsSync(join(packageRoot, file)), `exports "${subpath}" のファイルが無い: ${file}`);
  }
}

// 2. bin が存在し、shebang を持つ
const binPath = join(packageRoot, pkg.bin["pf-field-sw"]);
if (existsSync(binPath)) {
  const head = readFileSync(binPath, "utf8").slice(0, 64);
  check(head.startsWith("#!"), "CLI に shebang がありません（bin として実行できません）");
} else {
  failures.push(`bin が無い: ${pkg.bin["pf-field-sw"]}`);
}

// 3. React エントリの先頭に "use client" がある
const reactPath = join(dist, "react.js");
if (existsSync(reactPath)) {
  const head = readFileSync(reactPath, "utf8").trimStart().slice(0, 32);
  check(
    head.startsWith('"use client"') || head.startsWith("'use client'"),
    'dist/react.js の先頭に "use client" がありません（tsup の banner が落ちています）',
  );
} else {
  failures.push("dist/react.js が無い");
}

// 4. クライアント向けの出力にサーバ専用の環境変数名が混ざっていない
for (const name of ["index.js", "image.js", "storage.js", "react.js", "scanner.js", "sw.js"]) {
  const file = join(dist, name);
  if (!existsSync(file)) continue;
  const source = readFileSync(file, "utf8");
  for (const secret of ["SUPABASE_SECRET_KEY", "SUPABASE_SERVICE_ROLE_KEY"]) {
    check(
      !source.includes(secret),
      `dist/${name} に ${secret} への参照があります（サーバ専用コードが混ざっています）`,
    );
  }
}

// 5. 出力に package.json の版数が焼き込まれている
//    （VERSION を手で書いていた頃、changesets のバージョン更新と取り残されてずれた）
const indexPath = join(dist, "index.js");
if (existsSync(indexPath)) {
  const source = readFileSync(indexPath, "utf8");
  check(
    source.includes(`"${pkg.version}"`) || source.includes(`'${pkg.version}'`),
    `dist/index.js に版数 ${pkg.version} が焼き込まれていません（define の設定を確認してください）`,
  );
}

if (failures.length > 0) {
  console.error("ビルド成果物の検査に失敗しました:");
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}

console.log("ビルド成果物の検査: OK");
