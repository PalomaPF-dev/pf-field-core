import { afterEach, describe, expect, it, vi } from "vitest";
import { UploadFailure, uploadToTarget } from "../src/storage/transport.js";
import type { UploadTarget } from "../src/storage/types.js";

/**
 * 転送1回ぶんの検証。
 *
 * ここは XHR を使う。fetch がリクエストボディの送信進捗を取れないためで、
 * 代わりに **XHR はリダイレクトを黙って追う**という別の危険を抱え込む。
 * 追った先がログイン画面だと 200 が返り、成功と誤認しうる。
 * その誤認が起きないことを、ここで押さえる。
 */

interface StubOptions {
  status?: number;
  responseText?: string;
  /** リダイレクトを追った結果の URL */
  responseURL?: string;
  /** 'error' | 'timeout' | 'abort' */
  fail?: "error" | "timeout" | "abort";
  /** 進捗イベントを流す */
  progress?: { loaded: number; total: number }[];
}

/** 送信に使われたものを覚えておくスタブ */
function stubXhr(options: StubOptions) {
  const sent: { method: string; url: string; headers: Record<string, string>; body: unknown }[] = [];

  class StubXhr {
    status = options.status ?? 200;
    responseText = options.responseText ?? "";
    responseURL = options.responseURL ?? "";
    timeout = 0;
    upload = new EventTarget();
    #listeners = new Map<string, ((event: Event) => void)[]>();
    #method = "";
    #url = "";
    #headers: Record<string, string> = {};

    open(method: string, url: string) {
      this.#method = method;
      this.#url = url;
    }
    setRequestHeader(key: string, value: string) {
      this.#headers[key] = value;
    }
    addEventListener(type: string, handler: (event: Event) => void) {
      const list = this.#listeners.get(type) ?? [];
      list.push(handler);
      this.#listeners.set(type, list);
    }
    abort() {
      this.#emit("abort");
    }
    #emit(type: string) {
      for (const handler of this.#listeners.get(type) ?? []) handler(new Event(type));
    }
    send(body: unknown) {
      sent.push({ method: this.#method, url: this.#url, headers: this.#headers, body });
      queueMicrotask(() => {
        for (const step of options.progress ?? []) {
          const event = new Event("progress") as Event & { lengthComputable: boolean; loaded: number; total: number };
          Object.assign(event, { lengthComputable: true, ...step });
          this.upload.dispatchEvent(event);
        }
        this.#emit(options.fail ?? "load");
      });
    }
  }

  vi.stubGlobal("XMLHttpRequest", StubXhr);
  return sent;
}

function target(overrides?: Partial<UploadTarget>): UploadTarget {
  return {
    attachmentId: "att-1",
    ref: { provider: "supabase", bucket: "field-uploads", path: "app/2026/08/a.jpg" },
    request: { url: "https://storage.example.com/upload/a.jpg", method: "PUT", bodyMode: "binary" },
    expiresAt: Date.now() + 60_000,
    ...overrides,
  };
}

const blob = new Blob([new Uint8Array(500)], { type: "image/jpeg" });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("転送", () => {
  it("記述子どおりに PUT する", async () => {
    const sent = stubXhr({ status: 200 });

    const result = await uploadToTarget(target(), blob, "a.jpg", { headers: { "X-App": "t" } });

    expect(result.bytes).toBe(500);
    expect(sent[0]!.method).toBe("PUT");
    expect(sent[0]!.url).toBe("https://storage.example.com/upload/a.jpg");
    expect(sent[0]!.headers["X-App"]).toBe("t");
    expect(sent[0]!.body).toBe(blob);
  });

  it("form-data のときは file を最後に積む（S3 の POST policy の要件）", async () => {
    const sent = stubXhr({ status: 204 });

    await uploadToTarget(
      target({
        request: {
          url: "https://s3.example.com/bucket",
          method: "POST",
          bodyMode: "form-data",
          formFields: { key: "app/a.jpg", policy: "xxx" },
        },
      }),
      blob,
      "a.jpg",
      { headers: {} },
    );

    const form = sent[0]!.body as FormData;
    expect([...form.keys()]).toEqual(["key", "policy", "file"]);
  });

  it("★ ログイン画面へ追われていたら成功にしない", async () => {
    // XHR は redirect: "manual" を指定できず、黙って追う。
    // 追跡が起きたことは responseURL でしか分からない
    stubXhr({
      status: 200,
      responseURL: "https://storage.example.com/login?next=%2Fupload",
    });

    await expect(
      uploadToTarget(target(), blob, "a.jpg", { headers: {} }),
    ).rejects.toMatchObject({ queueError: { kind: "auth", retryable: false } });
  });

  it("クエリだけが違うのは追跡ではない（署名の正規化）", async () => {
    stubXhr({
      status: 200,
      responseURL: "https://storage.example.com/upload/a.jpg?token=abc",
    });

    await expect(
      uploadToTarget(target(), blob, "a.jpg", { headers: {} }),
    ).resolves.toMatchObject({ bytes: 500 });
  });

  it("409 は「前回の再試行が実は成功していた」= 成功として扱う", async () => {
    stubXhr({ status: 409 });

    const result = await uploadToTarget(target(), blob, "a.jpg", { headers: {} });
    expect(result.alreadyExisted).toBe(true);
  });

  it("403 は待っても直らない側に分類する", async () => {
    stubXhr({ status: 403, responseText: "expired" });

    await expect(
      uploadToTarget(target(), blob, "a.jpg", { headers: {} }),
    ).rejects.toMatchObject({ queueError: { kind: "auth", retryable: false } });
  });

  it("500 は待てば直る側に分類する", async () => {
    stubXhr({ status: 500 });

    await expect(
      uploadToTarget(target(), blob, "a.jpg", { headers: {} }),
    ).rejects.toMatchObject({ queueError: { kind: "server", retryable: true } });
  });

  it("通信エラーは圏外扱い（待てば直る）", async () => {
    stubXhr({ fail: "error" });

    await expect(
      uploadToTarget(target(), blob, "a.jpg", { headers: {} }),
    ).rejects.toMatchObject({ queueError: { kind: "network", retryable: true } });
  });

  it("タイムアウトは待てば直る、中止は消費しない", async () => {
    stubXhr({ fail: "timeout" });
    await expect(
      uploadToTarget(target(), blob, "a.jpg", { headers: {} }),
    ).rejects.toMatchObject({ queueError: { kind: "timeout", retryable: true } });

    vi.unstubAllGlobals();
    stubXhr({ fail: "abort" });
    await expect(
      uploadToTarget(target(), blob, "a.jpg", { headers: {} }),
    ).rejects.toMatchObject({ queueError: { kind: "aborted", retryable: false } });
  });

  it("期限切れの記述子は投げずに再発行させる", async () => {
    const sent = stubXhr({ status: 200 });

    const failure = await uploadToTarget(target({ expiresAt: Date.now() - 1 }), blob, "a.jpg", {
      headers: {},
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(UploadFailure);
    expect((failure as UploadFailure).queueError).toMatchObject({
      kind: "expired",
      retryable: true,
    });
    // 1バイトも送っていない
    expect(sent).toHaveLength(0);
  });

  it("進捗を報告する", async () => {
    stubXhr({
      status: 200,
      progress: [
        { loaded: 100, total: 500 },
        { loaded: 300, total: 500 },
      ],
    });

    const seen: number[] = [];
    await uploadToTarget(target(), blob, "a.jpg", {
      headers: {},
      onProgress: (loaded) => seen.push(loaded),
    });

    // 途中経過が出て、最後は必ず全量で締める
    expect(seen).toEqual([100, 300, 500]);
  });
});
