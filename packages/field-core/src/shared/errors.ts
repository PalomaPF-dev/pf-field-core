/**
 * ライブラリ全体で投げる例外の基底。
 * `code` で機械的に分岐できるようにし、メッセージは人間向けに日本語で書く
 * （現場のユーザーに出す文言はアプリ側で作るが、開発者が見るログは読めるほうがよい）。
 */
export class FieldCoreError extends Error {
  readonly code: FieldCoreErrorCode;

  constructor(code: FieldCoreErrorCode, message: string, options?: ErrorOptions) {
    // cause は ES2022 の Error が持つので自前で再定義しない
    super(message, options);
    this.name = "FieldCoreError";
    this.code = code;
  }
}

export type FieldCoreErrorCode =
  /** configureFieldCore() より前に getFieldCore() が呼ばれた */
  | "not_configured"
  /** 実行環境に必要な API が無い（crypto、IndexedDB など） */
  | "unsupported_environment"
  /** 引数・設定が不正 */
  | "invalid_argument"
  /** 端末のストレージ残量が足りない */
  | "quota_exceeded"
  /** 未実装（マイルストーン未到達）*/
  | "not_implemented";

/** そのマイルストーンではまだ実装されていない機能を明示的に示す。 */
export class NotImplementedError extends FieldCoreError {
  constructor(feature: string, milestone: string) {
    super("not_implemented", `${feature} は未実装です（${milestone} で実装予定）`);
    this.name = "NotImplementedError";
  }
}

export function isFieldCoreError(e: unknown): e is FieldCoreError {
  return e instanceof FieldCoreError;
}
