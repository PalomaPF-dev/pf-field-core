import { build } from "esbuild";
import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";

/**
 * `pf-field-sw build` — アプリの `worker/sw.ts` を1本の `public/sw.js` に束ねる。
 *
 * 自前で持つ理由（設計の決定 §5-5）:
 *   Service Worker は Next.js のバンドル対象外なので、別に束ねる必要がある。
 *   workbox を入れると設定と生成物が一気に増えるが、こちらが要るのは
 *   「1ファイルに束ねて、precache する資産の一覧を差し込む」だけ。
 *   esbuild を直接呼べば数十行で済み、生成物も読める大きさに収まる。
 */

export interface BuildSwOptions {
  entry: string;
  out: string;
  /** precache 対象を探す起点。既定 'public' */
  publicDir?: string;
  /** precache に含める拡張子 */
  include?: string[];
  minify?: boolean;
  /** ビルド識別子。各資産の版数が変わればキャッシュが入れ替わる */
  buildId?: string;
}

export interface BuildSwResult {
  outFile: string;
  bytes: number;
  precacheCount: number;
}

const DEFAULT_INCLUDE = [".js", ".css", ".woff2", ".png", ".svg", ".ico", ".webmanifest"];

/** precache する資産と、その内容から求めた版数 */
async function collectPrecache(
  publicDir: string,
  include: string[],
): Promise<{ url: string; revision: string }[]> {
  if (!existsSync(publicDir)) return [];

  const entries: { url: string; revision: string }[] = [];

  async function walk(dir: string): Promise<void> {
    for (const name of await readdir(dir)) {
      const full = join(dir, name);
      const info = await stat(full);

      if (info.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!include.includes(extname(name))) continue;
      // 自分自身は precache しない（更新できなくなる）
      if (name === "sw.js") continue;

      const content = await readFile(full);
      entries.push({
        url: `/${relative(publicDir, full).split("\\").join("/")}`,
        // 内容そのものから求める。ビルド番号だと中身が同じでも入れ替わる
        revision: createHash("sha256").update(content).digest("hex").slice(0, 16),
      });
    }
  }

  await walk(publicDir);
  return entries.sort((a, b) => (a.url < b.url ? -1 : 1));
}

export async function buildServiceWorker(options: BuildSwOptions): Promise<BuildSwResult> {
  const entry = resolve(options.entry);
  const out = resolve(options.out);
  const publicDir = resolve(options.publicDir ?? "public");

  if (!existsSync(entry)) {
    throw new Error(`エントリが見つかりません: ${options.entry}`);
  }

  const precache = await collectPrecache(publicDir, options.include ?? DEFAULT_INCLUDE);
  const buildId =
    options.buildId ??
    createHash("sha256")
      .update(precache.map((entry) => entry.revision).join(""))
      .digest("hex")
      .slice(0, 12);

  await build({
    entryPoints: [entry],
    outfile: out,
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2020",
    minify: options.minify ?? true,
    sourcemap: false,
    // Service Worker には window も document も無い。
    // 間違って参照しているコードは、ここで置き換えず素直に壊す
    define: {
      "process.env.NODE_ENV": '"production"',
      __PF_FIELD_PRECACHE__: JSON.stringify(precache),
      __PF_FIELD_BUILD_ID__: JSON.stringify(buildId),
    },
  });

  const written = await readFile(out);
  return { outFile: out, bytes: written.byteLength, precacheCount: precache.length };
}
