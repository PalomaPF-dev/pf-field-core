export interface ScanEvent {
  /** normalize 適用後の値 */
  data: string;
  /** prefix / suffix を含む生の入力 */
  raw: string;
  source: "keyboard" | "bridge" | "manual";
  /** DataWedge の suffix で symbology を送る設定にした場合のみ */
  symbology?: string;
  receivedAt: number;
  /** 入力に要した時間。人手入力との判別根拠として残す */
  durationMs: number;
}

export interface ScannerOptions {
  /**
   * 既定は `detectCapabilities().hardwareScanner`。
   *
   * DataWedge は Zebra 専用なので **iOS では自動的に false** になる。
   * アプリは `capabilities.hardwareScanner` を見て、false のときは
   * 手入力の UI を出し、`submitManual()` で値を流し込むこと。
   */
  enabled?: boolean;
  /** これ未満の長さはスキャンとみなさない。既定 4 */
  minLength?: number;
  /** キー間隔がこれ以下ならスキャナ由来とみなす。既定 40ms */
  maxIntervalMs?: number;
  terminator?: "Enter" | "Tab" | RegExp;
  /**
   * DataWedge のプロファイルで付与した接頭辞・接尾辞。
   * 設定されていればヒューリスティックより優先する（決定的なので誤検知が無い）。
   */
  prefix?: string;
  suffix?: string;
  /** input / textarea にフォーカスがあるときは無視する。既定 true */
  ignoreWhileTyping?: boolean;
  normalize?: (raw: string) => string;
  validate?: (data: string) => boolean;
  onInvalid?: (raw: string) => void;
}

export interface ScannerListener {
  start(): void;
  stop(): void;
  /**
   * 手入力した値をスキャン結果として流す（`source: "manual"` になる）。
   *
   * ハードウェアスキャナが無い端末（iOS）でのフォールバック経路であり、
   * テストからスキャンを再現するのにも使う。
   * 受け側は `source` を見れば手入力かどうかを区別できる。
   */
  submitManual(data: string): void;
}

export const DEFAULT_SCANNER_OPTIONS = {
  enabled: true,
  minLength: 4,
  maxIntervalMs: 40,
  terminator: "Enter",
  ignoreWhileTyping: true,
} as const;
