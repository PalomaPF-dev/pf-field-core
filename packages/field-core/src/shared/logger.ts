export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

export interface FieldLogger {
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

const ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

/**
 * 既定のロガー。level 未満は捨てる。
 *
 * 現場端末では DevTools を開けないことが多いので、既定は warn 以上に絞り、
 * 詳細が要るときだけアプリ側が debug に切り替える運用を想定している。
 */
export function createLogger(level: LogLevel = "warn", prefix = "[pf-field-core]"): FieldLogger {
  const threshold = ORDER[level];
  const write =
    (fn: (...args: unknown[]) => void, at: LogLevel) =>
    (message: string, context?: Record<string, unknown>) => {
      if (ORDER[at] < threshold) return;
      if (context === undefined) fn(`${prefix} ${message}`);
      else fn(`${prefix} ${message}`, context);
    };

  return {
    debug: write(console.debug.bind(console), "debug"),
    info: write(console.info.bind(console), "info"),
    warn: write(console.warn.bind(console), "warn"),
    error: write(console.error.bind(console), "error"),
  };
}

/** テストや silent 運用向け。 */
export const noopLogger: FieldLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};
