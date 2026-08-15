import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFieldServiceWorker } from "../src/sw/service-worker.js";
import { requestQueueSync } from "../src/sw/register.js";
import type { OfflineQueue } from "../src/queue/types.js";

/**
 * Service Worker の検証。
 *
 * 実 SW は fake-indexeddb と同じ発想で、必要なグローバルだけを立てて叩く。
 * ここで見たいのは配線の正しさ:
 *   - Background Sync のタグで送信が走るか
 *   - 署名の発行・アップロードをキャッシュしていないか（**重要**）
 *   - iOS（Background Sync 無し）でどう答えるか
 */

interface Listener {
  (event: unknown): void;
}

class FakeCache {
  store = new Map<string, Response>();
  async match(key: RequestInfo | URL): Promise<Response | undefined> {
    return this.store.get(typeof key === "string" ? key : (key as Request).url ?? String(key));
  }
  async put(key: RequestInfo | URL, value: Response): Promise<void> {
    this.store.set(typeof key === "string" ? key : (key as Request).url ?? String(key), value);
  }
  added: string[] = [];
  async add(url: RequestInfo | URL): Promise<void> {
    this.added.push(String(url));
  }
}

function setupSw() {
  const listeners = new Map<string, Listener[]>();
  const caches = new Map<string, FakeCache>();
  const fetchMock = vi.fn(async (_input?: unknown) => new Response("ok", { status: 200 }));

  const global = {
    addEventListener(type: string, listener: Listener) {
      const list = listeners.get(type) ?? [];
      list.push(listener);
      listeners.set(type, list);
    },
    skipWaiting: vi.fn(async () => {}),
    clients: { claim: vi.fn(async () => {}), matchAll: vi.fn(async () => []) },
    registration: {},
    caches: {
      open: async (name: string) => {
        let cache = caches.get(name);
        if (!cache) {
          cache = new FakeCache();
          caches.set(name, cache);
        }
        return cache;
      },
      keys: async () => [...caches.keys()],
      delete: async (name: string) => caches.delete(name),
      match: async () => undefined,
    },
    fetch: fetchMock,
    location: { href: "https://app.example.com/" },
  };

  return {
    scope: global as unknown as Parameters<typeof createFieldServiceWorker>[1],
    listeners,
    caches,
    fetchMock,
    global,
    fire(type: string, event: Record<string, unknown>) {
      const waits: Promise<unknown>[] = [];
      const full = {
        ...event,
        waitUntil: (promise: Promise<unknown>) => waits.push(promise),
        respondWith: (response: Response | Promise<Response>) => {
          (event as { responded?: unknown }).responded = response;
          waits.push(Promise.resolve(response));
        },
      };
      for (const listener of listeners.get(type) ?? []) listener(full);
      return Promise.all(waits);
    },
  };
}

let harness: ReturnType<typeof setupSw>;

beforeEach(() => {
  harness = setupSw();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function fakeQueue(flush: () => Promise<void>): OfflineQueue {
  return {
    flush: vi.fn(async () => {
      await flush();
      return { attempted: 1, succeeded: 1, failed: 0, skipped: 0 };
    }),
    destroy: vi.fn(async () => {}),
  } as unknown as OfflineQueue;
}

describe("Service Worker", () => {
  it("Background Sync のタグでキューを流す", async () => {
    let flushed = 0;
    const queue = fakeQueue(async () => {
      flushed++;
    });

    createFieldServiceWorker({ appId: "test", version: "v1", createQueue: async () => queue }, harness.scope);

    await harness.fire("sync", { tag: "pf-field-queue" });
    expect(flushed).toBe(1);
    // 使い終わったら閉じる。SW は何度も起こされるので開きっぱなしにしない
    expect(queue.destroy).toHaveBeenCalled();
  });

  it("別のタグでは動かない", async () => {
    let flushed = 0;
    createFieldServiceWorker(
      { appId: "test", version: "v1", createQueue: async () => fakeQueue(async () => void flushed++) },
      harness.scope,
    );

    await harness.fire("sync", { tag: "someone-elses-tag" });
    expect(flushed).toBe(0);
  });

  it("画面からの「いま送って」で流す", async () => {
    let flushed = 0;
    createFieldServiceWorker(
      { appId: "test", version: "v1", createQueue: async () => fakeQueue(async () => void flushed++) },
      harness.scope,
    );

    await harness.fire("message", { data: { type: "pf-field-flush" } });
    expect(flushed).toBe(1);
  });

  it("送信に失敗したら waitUntil を reject させる（ブラウザに再試行させるため）", async () => {
    createFieldServiceWorker(
      {
        appId: "test",
        version: "v1",
        createQueue: async () => {
          throw new Error("キューを開けません");
        },
      },
      harness.scope,
    );

    // ここで握りつぶすと「一度きりで諦める」になる
    await expect(harness.fire("sync", { tag: "pf-field-queue" })).rejects.toThrow();
  });

  it("createQueue が無ければ sync を購読しない", () => {
    createFieldServiceWorker({ appId: "test", version: "v1" }, harness.scope);
    expect(harness.listeners.get("sync")).toBeUndefined();
  });

  it("★ 署名の発行・アップロードはキャッシュしない", async () => {
    createFieldServiceWorker(
      {
        appId: "test",
        version: "v1",
        api: {
          include: [/^\/api\//],
          exclude: [/^\/api\/(uploads|token|submit)/],
          cacheable: [/^\/api\/master/],
        },
      },
      harness.scope,
    );

    const event = {
      request: new Request("https://app.example.com/api/uploads/sign", { method: "GET" }),
    };
    await harness.fire("fetch", event);

    // respondWith を呼んでいない = SW が触らずネットワークへ素通し
    expect((event as { responded?: unknown }).responded).toBeUndefined();
  });

  it("既定では更新を勝手に適用しない", async () => {
    createFieldServiceWorker({ appId: "test", version: "v1" }, harness.scope);
    await harness.fire("install", {});
    // 入力途中でリロードされる事故を防ぐ
    expect(harness.global.skipWaiting).not.toHaveBeenCalled();
  });

  it("古い版のキャッシュだけを片付ける", async () => {
    harness.caches.set("pf-field-test-shell-v0", new FakeCache());
    harness.caches.set("pf-field-other-shell-v0", new FakeCache());

    createFieldServiceWorker({ appId: "test", version: "v1" }, harness.scope);
    await harness.fire("activate", {});

    expect(harness.caches.has("pf-field-test-shell-v0")).toBe(false);
    // 別アプリのものには触らない（バケットもキャッシュも4アプリ共用のため）
    expect(harness.caches.has("pf-field-other-shell-v0")).toBe(true);
  });

  it("★ install で precacheRoutes の HTML が参照する /_next/static も取り込む", async () => {
    // 実機で判明した欠陥の再発防止: /offline の HTML だけ precache しても
    // CSS / JS が無ければ圏外フォールバックは素の HTML で表示される
    harness.fetchMock.mockImplementation(async (input: unknown) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("/offline")) {
        return new Response(
          '<html><head><link rel="stylesheet" href="/_next/static/css/abc123.css"/>' +
            '<script src="/_next/static/chunks/main-xyz.js" defer></script></head>' +
            "<body>offline</body></html>",
          { status: 200, headers: { "Content-Type": "text/html" } },
        );
      }
      return new Response("ok", { status: 200 });
    });

    createFieldServiceWorker({ appId: "test", version: "v1" }, harness.scope);
    await harness.fire("install", {});

    const cache = harness.caches.get("pf-field-test-shell-v1")!;
    expect(await cache.match("/offline")).toBeTruthy();
    expect(cache.added).toContain("/_next/static/css/abc123.css");
    expect(cache.added).toContain("/_next/static/chunks/main-xyz.js");
  });

  it("/_next/static はキャッシュ優先で返す（圏外でも崩れない）", async () => {
    createFieldServiceWorker({ appId: "test", version: "v1" }, harness.scope);

    const assetUrl = "https://app.example.com/_next/static/css/abc123.css";
    const cache = new FakeCache();
    cache.store.set(assetUrl, new Response("body{color:red}", { status: 200 }));
    harness.caches.set("pf-field-test-shell-v1", cache);

    const event = { request: new Request(assetUrl, { method: "GET" }) };
    await harness.fire("fetch", event);

    const responded = await (event as { responded?: Promise<Response> | Response }).responded;
    expect(responded).toBeTruthy();
    expect(await (responded as Response).text()).toBe("body{color:red}");
    // キャッシュにあったのでネットワークへは行かない
    expect(harness.fetchMock).not.toHaveBeenCalled();
  });
});

describe("Background Sync のフォールバック", () => {
  it("★ 非対応（iOS）なら前面送信が要ると答える", async () => {
    // ServiceWorkerRegistration.prototype に sync が無い状態 = iOS
    vi.stubGlobal("navigator", { userAgent: "iPhone", maxTouchPoints: 5 });
    vi.stubGlobal("ServiceWorkerRegistration", function () {} as unknown);

    const result = await requestQueueSync();

    expect(result.registered).toBe(false);
    // 「送れない」ではない。「開いている間に送る」
    expect(result.requiresForeground).toBe(true);
    expect(result.reason).toBe("unsupported");
  });
});
