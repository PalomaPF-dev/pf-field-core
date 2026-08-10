/**
 * パッケージ版数。実機のログに「どの版が入っているか」を残すために公開している。
 *
 * 値はビルド時に package.json から差し込む（tsup / vitest の define）。
 * ここを手で書くと changesets のバージョン更新と必ずずれる —
 * 実際、0.1.0 へ上げたときにこの定数だけ 0.0.1 のまま取り残された。
 */
declare const __PF_FIELD_CORE_VERSION__: string;

export const VERSION: string =
  typeof __PF_FIELD_CORE_VERSION__ === "string" ? __PF_FIELD_CORE_VERSION__ : "0.0.0-dev";
