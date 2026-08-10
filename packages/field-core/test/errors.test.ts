import { describe, expect, it } from "vitest";
import {
  classifyHttpStatus,
  classifyThrown,
  isPermanent,
  queueErrorFromResponse,
  queueErrorFromThrown,
} from "../src/queue/errors.js";
import { FieldCoreError } from "../src/shared/errors.js";

describe("classifyHttpStatus", () => {
  it("5xx は待てば直る見込みがあるので再試行する", () => {
    for (const status of [500, 502, 503, 504]) {
      expect(classifyHttpStatus(status)).toEqual({ kind: "server", retryable: true });
    }
  });

  it("408 / 425 / 429 は再試行する", () => {
    expect(classifyHttpStatus(408).retryable).toBe(true);
    expect(classifyHttpStatus(408).kind).toBe("timeout");
    expect(classifyHttpStatus(425).retryable).toBe(true);
    expect(classifyHttpStatus(429).retryable).toBe(true);
  });

  it("401 / 403 は auth かつ再試行しない（再ログインが要る）", () => {
    expect(classifyHttpStatus(401)).toEqual({ kind: "auth", retryable: false });
    expect(classifyHttpStatus(403)).toEqual({ kind: "auth", retryable: false });
  });

  it("入力不備の 4xx は validation かつ再試行しない", () => {
    for (const status of [400, 413, 415, 422]) {
      expect(classifyHttpStatus(status)).toEqual({ kind: "validation", retryable: false });
    }
  });

  it("404 は設定ミスなので黙って再試行しない", () => {
    // 待っても直らない。未送信バッジに居座らせず blocked にして気づかせる
    expect(classifyHttpStatus(404).retryable).toBe(false);
  });

  it("507 は quota として扱う", () => {
    expect(classifyHttpStatus(507)).toEqual({ kind: "quota", retryable: false });
    // 5xx の一般則に飲み込まれていないこと
    expect(classifyHttpStatus(507).retryable).toBe(false);
  });

  it("その他の 4xx は再試行しない", () => {
    expect(classifyHttpStatus(418).retryable).toBe(false);
    expect(classifyHttpStatus(451).retryable).toBe(false);
  });
});

describe("classifyThrown", () => {
  it("fetch のネットワーク失敗（TypeError）は再試行する", () => {
    expect(classifyThrown(new TypeError("Failed to fetch"))).toEqual({
      kind: "network",
      retryable: true,
    });
  });

  it("AbortError は既定では利用者のキャンセル扱いで再試行しない", () => {
    const e = new Error("aborted");
    e.name = "AbortError";
    expect(classifyThrown(e)).toEqual({ kind: "aborted", retryable: false });
  });

  it("タイムアウト由来だと分かっている中断は再試行する", () => {
    const e = new Error("aborted");
    e.name = "AbortError";
    expect(classifyThrown(e, { timedOut: true })).toEqual({ kind: "timeout", retryable: true });
  });

  it("端末のストレージ不足は再試行しない", () => {
    const e = new FieldCoreError("quota_exceeded", "空き容量が足りません");
    expect(classifyThrown(e)).toEqual({ kind: "quota", retryable: false });
  });

  it("想定外の例外は再試行に倒す（maxAttempts で頭打ちになり failed に落ちる）", () => {
    expect(classifyThrown(new Error("なにか"))).toEqual({ kind: "unknown", retryable: true });
    expect(classifyThrown("文字列が投げられた")).toEqual({ kind: "unknown", retryable: true });
  });
});

describe("queueErrorFromResponse", () => {
  it("ステータスと本文の先頭をメッセージに含める", () => {
    const e = queueErrorFromResponse(422, "Unprocessable Entity", "点検値が範囲外です");
    expect(e.kind).toBe("validation");
    expect(e.retryable).toBe(false);
    expect(e.httpStatus).toBe(422);
    expect(e.message).toContain("422");
    expect(e.message).toContain("点検値が範囲外です");
  });

  it("本文が長くても切り詰める", () => {
    const e = queueErrorFromResponse(500, "Internal Server Error", "x".repeat(5000));
    expect(e.message.length).toBeLessThan(300);
  });

  it("at に時刻が入る", () => {
    const e = queueErrorFromResponse(503);
    expect(e.at).toBeGreaterThan(0);
  });
});

describe("queueErrorFromThrown", () => {
  it("例外のメッセージを引き継ぐ", () => {
    const e = queueErrorFromThrown(new TypeError("Failed to fetch"));
    expect(e.kind).toBe("network");
    expect(e.message).toBe("Failed to fetch");
    expect(e.httpStatus).toBeUndefined();
  });
});

describe("isPermanent", () => {
  it("再試行不可なものだけ true", () => {
    expect(isPermanent(queueErrorFromResponse(401))).toBe(true);
    expect(isPermanent(queueErrorFromResponse(503))).toBe(false);
  });
});
