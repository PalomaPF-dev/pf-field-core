import type { PathContext } from "./types.js";

/**
 * バケット内の保存パスを組み立てる。
 *
 * 規約（確定）:
 *   `<companyId>/<appId>/<YYYY>/<MM>/<jobId>/<attachmentId>`
 *
 * 先頭が `companyId` なのはテナント分離のため。ここが崩れると
 * 「他社の写真が見える」に直結するので、**組み立ては必ずサーバ側**で行い、
 * クライアントから来た値は一切使わない（ファイル名も使わない）。
 *
 * 日付を挟むのは、1つのプレフィックス配下が際限なく増えるのを避けるため。
 * オブジェクトストレージは列挙がプレフィックス単位になるので、
 * 月で割っておかないと後々の棚卸しが重くなる。
 */

/** パス構成要素として安全な文字だけに落とす。区切りの `/` を持ち込ませない */
export function sanitizeSegment(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^\.+/, "");
  return cleaned.slice(0, 128);
}

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

/**
 * 既定のパス生成。
 *
 * `companyId` が無い場合は**例外にする**。既定値で埋めると、
 * 全社ぶんが同じプレフィックスに落ちてテナント分離が静かに消える。
 * 落ちて気づくほうが、混ざって気づかないより圧倒的にましな種類の失敗。
 */
export function defaultObjectPath(ctx: PathContext): string {
  const companyId = ctx.auth.companyId ?? ctx.auth.tenantId;
  if (typeof companyId !== "string" || companyId.length === 0) {
    throw new Error(
      "companyId が特定できません。テナント分離ができないため保存先を決められません",
    );
  }

  const year = ctx.at.getUTCFullYear();
  const month = pad2(ctx.at.getUTCMonth() + 1);

  return [
    sanitizeSegment(companyId),
    sanitizeSegment(ctx.appId),
    String(year),
    month,
    sanitizeSegment(ctx.jobId),
    sanitizeSegment(ctx.attachmentId),
  ].join("/");
}

/** パスから会社を取り出す。閲覧要求が自社のものか確かめるのに使う */
export function companyIdOfPath(path: string): string | undefined {
  const [companyId] = path.split("/");
  return companyId || undefined;
}
