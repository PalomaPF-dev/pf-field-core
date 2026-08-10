import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { VERSION } from "../src/version.js";
import tsupConfig from "../tsup.config.js";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, "..");
const srcRoot = join(packageRoot, "src");

const pkg = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
  name: string;
  version: string;
  type: string;
  bin: Record<string, string>;
  exports: Record<string, { types?: string; default?: string } | string>;
  publishConfig?: { registry?: string };
};

/** tsup の config 配列から、出力名 → エントリのソースパスを集める */
function collectTsupEntries(): Map<string, string> {
  const configs = Array.isArray(tsupConfig) ? tsupConfig : [tsupConfig];
  const out = new Map<string, string>();
  for (const config of configs) {
    const entry = (config as { entry?: Record<string, string> }).entry;
    if (!entry) continue;
    for (const [name, source] of Object.entries(entry)) out.set(name, source);
  }
  return out;
}

describe("パッケージ版数", () => {
  it("VERSION が package.json と一致する", () => {
    // 実機ログの版数表示が嘘にならないよう、ここで縛る
    expect(VERSION).toBe(pkg.version);
  });
});

describe("公開エントリ", () => {
  const entries = collectTsupEntries();

  it("GitHub Packages のスコープと一致する名前になっている", () => {
    // GitHub Packages はスコープが org 名と一致していないと publish できない
    expect(pkg.name).toBe("@palomapf-dev/pf-field-core");
    expect(pkg.publishConfig?.registry).toBe("https://npm.pkg.github.com");
  });

  it("ESM のみを出す（exports に require 条件を持たない）", () => {
    expect(pkg.type).toBe("module");
    for (const [subpath, value] of Object.entries(pkg.exports)) {
      if (typeof value === "string") continue;
      expect(value, `${subpath} に require 条件がある`).not.toHaveProperty("require");
    }
  });

  it("exports の各サブパスに対応する tsup エントリがある", () => {
    for (const [subpath, value] of Object.entries(pkg.exports)) {
      if (subpath === "./package.json" || typeof value === "string") continue;
      const outFile = value.default;
      expect(outFile, `${subpath} に default が無い`).toBeTruthy();
      const name = outFile!.replace(/^\.\/dist\//, "").replace(/\.js$/, "");
      expect(entries.has(name), `${subpath} に対応する tsup エントリが無い (${name})`).toBe(true);
    }
  });

  it("tsup の各エントリのソースが実在する", () => {
    for (const [name, source] of entries) {
      expect(
        statSync(join(packageRoot, source)).isFile(),
        `${name} のソースが無い: ${source}`,
      ).toBe(true);
    }
  });

  it("bin が cli エントリを指している", () => {
    expect(pkg.bin["pf-field-sw"]).toBe("./dist/cli.js");
    expect(entries.has("cli")).toBe(true);
  });

  it("型定義のパスが出力ファイルと対応している", () => {
    for (const [subpath, value] of Object.entries(pkg.exports)) {
      if (subpath === "./package.json" || typeof value === "string") continue;
      expect(value.types).toBe(value.default!.replace(/\.js$/, ".d.ts"));
    }
  });
});

// ---------------------------------------------------------------------------
// サーバ専用コードがクライアント向けエントリに混ざらないことの検証。
//
// ./server は SUPABASE_SECRET_KEY を読む。ここが端末に配られるバンドルへ
// 紛れ込むと鍵が漏れるので、静的にモジュールグラフを辿って遮断を確かめる。
// ---------------------------------------------------------------------------

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...listSourceFiles(full));
    else if (name.endsWith(".ts") || name.endsWith(".tsx")) out.push(full);
  }
  return out;
}

/** `from "..."` と 動的 import の相対指定だけを拾う */
function importedSpecifiers(source: string): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(/from\s+["']([^"']+)["']/g)) out.push(m[1] as string);
  for (const m of source.matchAll(/import\(\s*["']([^"']+)["']\s*\)/g)) out.push(m[1] as string);
  return out.filter((s) => s.startsWith("."));
}

function resolveSpecifier(fromFile: string, specifier: string): string | null {
  const base = resolve(dirname(fromFile), specifier);
  for (const candidate of [
    base.replace(/\.js$/, ".ts"),
    base.replace(/\.js$/, ".tsx"),
    `${base}.ts`,
    `${base}.tsx`,
    join(base, "index.ts"),
  ]) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      /* 次の候補へ */
    }
  }
  return null;
}

function reachableFrom(entryFiles: string[]): Set<string> {
  const seen = new Set<string>();
  const queue = [...entryFiles];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    const source = readFileSync(file, "utf8");
    for (const specifier of importedSpecifiers(source)) {
      const resolved = resolveSpecifier(file, specifier);
      if (resolved && !seen.has(resolved)) queue.push(resolved);
    }
  }
  return seen;
}

describe("サーバ専用コードの遮断", () => {
  const clientEntries = [
    "src/index.ts",
    "src/image/index.ts",
    "src/storage/index.ts",
    "src/react/index.ts",
    "src/scanner/index.ts",
    "src/sw/index.ts",
  ].map((p) => join(packageRoot, p));

  it("クライアント向けエントリから src/server/ に到達しない", () => {
    // 型だけの import でも失格にしている。実行時には消えるが、
    // 「サーバ側の型をクライアントで使いたい」場面は共有の型を切り出すべき合図なので、
    // ここで気づけるようにしておく。
    const reachable = reachableFrom(clientEntries);
    const leaked = [...reachable]
      .filter((f) => f.startsWith(join(srcRoot, "server")))
      .map((f) => relative(packageRoot, f));

    expect(leaked, `クライアント向けエントリからサーバ専用モジュールに到達できる`).toEqual([]);
  });

  it("src/server/ 以外にサーバ専用の鍵の参照が無い", () => {
    const secrets = ["SUPABASE_SECRET_KEY", "SUPABASE_SERVICE_ROLE_KEY"];
    const offenders = listSourceFiles(srcRoot)
      .filter((f) => !f.startsWith(join(srcRoot, "server")))
      .filter((f) => {
        const source = readFileSync(f, "utf8");
        return secrets.some((secret) => source.includes(secret));
      })
      .map((f) => relative(packageRoot, f));

    expect(offenders).toEqual([]);
  });
});
