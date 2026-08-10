import { describe, expect, it } from "vitest";
import {
  backoffDelay,
  backoffSchedule,
  DEFAULT_BACKOFF,
  DEFAULT_MAX_ATTEMPTS,
  nextAttemptAt,
} from "../src/queue/backoff.js";

/** jitter を無効化して決定的に見るためのヘルパ */
const noJitter = { jitter: "none" } as const;

describe("backoffDelay", () => {
  it("1回目の失敗では baseMs を返す", () => {
    expect(backoffDelay(1, noJitter)).toBe(DEFAULT_BACKOFF.baseMs);
  });

  it("失敗のたびに factor 倍になる", () => {
    expect(backoffDelay(2, noJitter)).toBe(4_000);
    expect(backoffDelay(3, noJitter)).toBe(8_000);
    expect(backoffDelay(4, noJitter)).toBe(16_000);
  });

  it("maxMs で頭打ちになる", () => {
    expect(backoffDelay(20, noJitter)).toBe(DEFAULT_BACKOFF.maxMs);
    expect(backoffDelay(200, noJitter)).toBe(DEFAULT_BACKOFF.maxMs);
  });

  it("factor^n が Infinity になっても maxMs を超えない", () => {
    // 1000 回目ともなると Math.pow は Infinity になる。NaN を返さないことを確かめる
    const d = backoffDelay(1000, noJitter);
    expect(Number.isFinite(d)).toBe(true);
    expect(d).toBe(DEFAULT_BACKOFF.maxMs);
  });

  it("attempt が 1 未満でも 1 として扱う", () => {
    expect(backoffDelay(0, noJitter)).toBe(DEFAULT_BACKOFF.baseMs);
    expect(backoffDelay(-5, noJitter)).toBe(DEFAULT_BACKOFF.baseMs);
    expect(backoffDelay(1.9, noJitter)).toBe(DEFAULT_BACKOFF.baseMs);
  });

  describe("full jitter", () => {
    it("random=0 なら 0 を返す（端末が一斉に殺到しないための下限）", () => {
      expect(backoffDelay(5, undefined, () => 0)).toBe(0);
    });

    it("random=1 なら上限そのものを返す", () => {
      expect(backoffDelay(3, undefined, () => 1)).toBe(8_000);
    });

    it("常に [0, 上限] の範囲に収まる", () => {
      for (let attempt = 1; attempt <= 12; attempt++) {
        const cap = backoffDelay(attempt, noJitter);
        for (let i = 0; i < 50; i++) {
          const d = backoffDelay(attempt, undefined, Math.random);
          expect(d).toBeGreaterThanOrEqual(0);
          expect(d).toBeLessThanOrEqual(cap);
        }
      }
    });
  });

  it("不正な設定は RangeError にする", () => {
    expect(() => backoffDelay(1, { factor: 0.5 })).toThrow(RangeError);
    expect(() => backoffDelay(1, { baseMs: -1 })).toThrow(RangeError);
    expect(() => backoffDelay(1, { maxMs: Number.NaN })).toThrow(RangeError);
  });
});

describe("nextAttemptAt", () => {
  it("基準時刻に待ち時間を足した値を返す", () => {
    expect(nextAttemptAt(2, 1_000_000, noJitter)).toBe(1_004_000);
  });
});

describe("backoffSchedule", () => {
  it("既定設定は 2s から始まる", () => {
    const s = backoffSchedule();
    expect(s).toHaveLength(DEFAULT_MAX_ATTEMPTS);
    expect(s[0]).toBe(2_000);
  });

  it("打ち切りまでに maxMs へ到達する（到達しないと maxMs が死んだ設定になる）", () => {
    // ここが効いていないと「上限5分」と書いてあるのに一度も5分にならない、という状態になる
    const s = backoffSchedule();
    expect(s.at(-1)).toBe(DEFAULT_BACKOFF.maxMs);
    expect(s.filter((ms) => ms === DEFAULT_BACKOFF.maxMs).length).toBeGreaterThanOrEqual(2);
  });

  it("合計で15〜25分ねばる", () => {
    // 圏外は試行回数を消費しないので、これは「サーバに届くが失敗し続けている」時間
    const totalMinutes = backoffSchedule().reduce((a, b) => a + b, 0) / 60_000;
    expect(totalMinutes).toBeGreaterThan(15);
    expect(totalMinutes).toBeLessThan(25);
  });

  it("単調非減少である", () => {
    const s = backoffSchedule(12);
    for (let i = 1; i < s.length; i++) {
      expect(s[i]).toBeGreaterThanOrEqual(s[i - 1] as number);
    }
  });
});
