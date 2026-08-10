import { FieldCoreError } from "./errors.js";

/**
 * クライアント発行の UUID v4。**冪等キーそのもの**なので、弱い乱数は使わない。
 *
 * 端末が数十台あり、同じジョブIDが衝突すると「別の点検結果が同一レコードとして
 * 弾かれる」というデータ欠損に直結する。Math.random() へのフォールバックは
 * 用意せず、暗号乱数が無い環境では明示的に失敗させる。
 * （全アプリ HTTPS = secure context なので crypto は必ず存在する）
 */
export function uuid(): string {
  const c = globalThis.crypto as Crypto | undefined;

  if (c && typeof c.randomUUID === "function") {
    return c.randomUUID();
  }

  if (c && typeof c.getRandomValues === "function") {
    const b = c.getRandomValues(new Uint8Array(16));
    // RFC 4122 §4.4: version=4, variant=10xx
    b[6] = ((b[6] as number) & 0x0f) | 0x40;
    b[8] = ((b[8] as number) & 0x3f) | 0x80;
    const hex: string[] = [];
    for (let i = 0; i < 16; i++) hex.push((b[i] as number).toString(16).padStart(2, "0"));
    return (
      hex.slice(0, 4).join("") +
      "-" +
      hex.slice(4, 6).join("") +
      "-" +
      hex.slice(6, 8).join("") +
      "-" +
      hex.slice(8, 10).join("") +
      "-" +
      hex.slice(10, 16).join("")
    );
  }

  throw new FieldCoreError(
    "unsupported_environment",
    "暗号乱数（crypto.getRandomValues）が利用できません。HTTPS（secure context）で実行してください",
  );
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}
