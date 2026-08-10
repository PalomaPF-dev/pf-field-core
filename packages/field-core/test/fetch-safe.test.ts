import { describe, expect, it, vi } from "vitest";
import {
  classifyResponse,
  responseError,
  safeFetch,
  SAFE_FETCH_INIT,
} from "../src/net/fetch-safe.js";

/**
 * 送信経路の応答判定。
 *
 * ここが緩むと**点検結果が消える**。セッション切れでログイン画面へ 302 され、
 * それを追いかけて 200 の HTML を受け取り、成功と誤認してジョブを削除する、という筋。
 */

describe("SAFE_FETCH_INIT", () => {
  it("リダイレクトを追いかけない", () => {
    // 追いかけると、ログイン画面の HTML が 200 で返って res.ok が true になる
    expect(SAFE_FETCH_INIT.redirect).toBe("manual");
  });
});

describe("classifyResponse", () => {
  it("2xx は成功", () => {
    expect(classifyResponse({ status: 200 })).toBeNull();
    expect(classifyResponse({ status: 201 })).toBeNull();
    expect(classifyResponse({ status: 204 })).toBeNull();
  });

  it("opaqueredirect は認証切れ（成功にしない）", () => {
    // redirect: "manual" の下でログイン画面へ飛ばされるとこの形になる
    const result = classifyResponse({ status: 0, type: "opaqueredirect" });
    expect(result).toEqual({ kind: "auth", retryable: false });
  });

  it("redirected が立っていれば認証切れ扱い", () => {
    // redirect: "manual" を付け忘れた場合の保険。
    // 200 でも中身はログイン画面なので、成功にしてはいけない
    expect(classifyResponse({ status: 200, redirected: true })).toEqual({
      kind: "auth",
      retryable: false,
    });
  });

  it("3xx が素通しで見えた場合も認証切れ扱い", () => {
    for (const status of [301, 302, 303, 307, 308]) {
      expect(classifyResponse({ status })).toEqual({ kind: "auth", retryable: false });
    }
  });

  it("401 は認証切れ（再ログインで復帰できる）", () => {
    expect(classifyResponse({ status: 401 })).toEqual({ kind: "auth", retryable: false });
  });

  it("★ 403 は利用権の問題。再ログインでは直らない", () => {
    expect(classifyResponse({ status: 403 })).toEqual({
      kind: "entitlement",
      retryable: false,
    });

    // 文言も「再ログインでは解決しない」と明示する
    const error = responseError({ status: 403 });
    expect(error?.message).toContain("管理者");
    expect(error?.message).toContain("再ログイン");
  });

  it("5xx は待てば直る", () => {
    expect(classifyResponse({ status: 503 })).toEqual({ kind: "server", retryable: true });
  });

  it("opaqueredirect でない status 0 は通信の失敗として再試行する", () => {
    expect(classifyResponse({ status: 0 })).toEqual({ kind: "network", retryable: true });
  });
});

describe("responseError", () => {
  it("認証切れは「ジョブを消さない」分類になる", () => {
    const error = responseError({ status: 0, type: "opaqueredirect" });
    expect(error).not.toBeNull();
    expect(error?.kind).toBe("auth");
    // retryable=false → blocked(auth)。破棄ではない
    expect(error?.retryable).toBe(false);
    expect(error?.message).toMatch(/ログイン/);
  });

  it("成功なら null", () => {
    expect(responseError({ status: 200 })).toBeNull();
  });

  it("サーバエラーは本文の先頭をメッセージに含める", () => {
    const error = responseError(
      { status: 500 },
      { statusText: "Internal Server Error", body: "DB がダウンしています" },
    );
    expect(error?.kind).toBe("server");
    expect(error?.message).toContain("DB がダウンしています");
  });
});

describe("safeFetch", () => {
  it("常に redirect: manual を付ける", async () => {
    const spy = vi.fn(async (_input: unknown, _init?: RequestInit) => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", spy);
    try {
      await safeFetch("/api/x", { method: "POST" });
      const init = spy.mock.calls[0]![1]!;
      expect(init.redirect).toBe("manual");
      expect(init.method).toBe("POST");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("呼び出し側が redirect を上書きできない", async () => {
    // 上書きできると、うっかり follow に戻して誤認事故が起きる
    const spy = vi.fn(async (_input: unknown, _init?: RequestInit) => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", spy);
    try {
      await safeFetch("/api/x", { redirect: "follow" } as never);
      const init = spy.mock.calls[0]![1]!;
      expect(init.redirect).toBe("manual");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("タイムアウトを指定できる", async () => {
    const spy = vi.fn(async (_input: unknown, _init?: RequestInit) => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", spy);
    try {
      await safeFetch("/api/x", { timeoutMs: 5_000 });
      const init = spy.mock.calls[0]![1]!;
      expect(init.signal).toBeInstanceOf(AbortSignal);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
