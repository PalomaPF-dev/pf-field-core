import { afterEach, describe, expect, it, vi } from "vitest";
import { createFileUrlResolver } from "../src/storage/url-resolver.js";
import type { StoredObjectRef } from "../src/storage/types.js";
import { setClock } from "../src/shared/clock.js";

/**
 * 閲覧用URLの解決。
 *
 * バケットが非公開なので、写真を1枚出すたびに署名の発行が要る。
 * 素朴に書くと一覧に20枚あれば20往復する。弱電界では往復が最大のコストなので、
 * まとめること・使い回すことがそのまま体感に出る。
 */

function ref(path: string): StoredObjectRef {
  return { provider: "supabase", bucket: "field-uploads", path };
}

function stubFetch(handler: (body: { refs: StoredObjectRef[] }) => unknown) {
  const calls: { refs: StoredObjectRef[] }[] = [];
  const fn = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { refs: StoredObjectRef[] };
    calls.push(body);
    return {
      status: 200,
      json: async () => handler(body),
    } as unknown as Response;
  });
  vi.stubGlobal("fetch", fn);
  return calls;
}

/** 要求されたぶんをそのまま返す既定の応答 */
function echo(expiresAt: number) {
  return (body: { refs: StoredObjectRef[] }) => ({
    urls: body.refs.map((r) => ({
      ref: r,
      url: `https://signed.example.com/${r.path}?token=${r.path}`,
      expiresAt,
    })),
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("閲覧用URLの解決", () => {
  it("同じティックの要求を1回にまとめる", async () => {
    const calls = stubFetch(echo(Date.now() + 300_000));
    const resolver = createFileUrlResolver({ batchWindowMs: 1 });

    const urls = await Promise.all([
      resolver.resolve(ref("a.jpg")),
      resolver.resolve(ref("b.jpg")),
      resolver.resolve(ref("c.jpg")),
    ]);

    // ★ 3枚でも往復は1回
    expect(calls).toHaveLength(1);
    expect(calls[0]!.refs).toHaveLength(3);
    expect(urls[0]).toContain("a.jpg");
    expect(urls[2]).toContain("c.jpg");
  });

  it("期限内は使い回す（再描画のたびに発行しない）", async () => {
    const calls = stubFetch(echo(Date.now() + 300_000));
    const resolver = createFileUrlResolver({ batchWindowMs: 1 });

    await resolver.resolve(ref("a.jpg"));
    await resolver.resolve(ref("a.jpg"));
    await resolver.resolve(ref("a.jpg"));

    expect(calls).toHaveLength(1);
  });

  it("期限が近いものは使い回さない", async () => {
    const at = 1_000_000;
    const restore = setClock({ now: () => at });
    try {
      // 残り10秒。描画してから読み込まれる間に切れうる
      const calls = stubFetch(echo(at + 10_000));
      const resolver = createFileUrlResolver({ batchWindowMs: 1 });

      await resolver.resolve(ref("a.jpg"));
      await resolver.resolve(ref("a.jpg"));

      expect(calls).toHaveLength(2);
    } finally {
      restore();
    }
  });

  it("上限を超えたら分割して投げる", async () => {
    const calls = stubFetch(echo(Date.now() + 300_000));
    const resolver = createFileUrlResolver({ batchWindowMs: 1, maxBatchSize: 2 });

    await Promise.all([
      resolver.resolve(ref("a")),
      resolver.resolve(ref("b")),
      resolver.resolve(ref("c")),
    ]);

    expect(calls).toHaveLength(2);
    expect(calls[0]!.refs).toHaveLength(2);
    expect(calls[1]!.refs).toHaveLength(1);
  });

  it("1枚が出せなくても、残りは出す", async () => {
    // b だけ返さない
    stubFetch((body) => ({
      urls: body.refs
        .filter((r) => r.path !== "b")
        .map((r) => ({ ref: r, url: `https://x/${r.path}`, expiresAt: Date.now() + 300_000 })),
    }));
    const resolver = createFileUrlResolver({ batchWindowMs: 1 });

    const resolved = await resolver.resolveMany([ref("a"), ref("b"), ref("c")]);

    // 一覧が丸ごと崩れるより、出せるものを出す
    expect(resolved.map((r) => r.ref.path).sort()).toEqual(["a", "c"]);
  });

  it("invalidate で作り直す", async () => {
    const calls = stubFetch(echo(Date.now() + 300_000));
    const resolver = createFileUrlResolver({ batchWindowMs: 1 });

    await resolver.resolve(ref("a.jpg"));
    resolver.invalidate(ref("a.jpg"));
    await resolver.resolve(ref("a.jpg"));

    expect(calls).toHaveLength(2);
  });

  it("ログイン画面へのリダイレクトを URL として扱わない", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ status: 0, type: "opaqueredirect" }) as unknown as Response),
    );
    const resolver = createFileUrlResolver({ batchWindowMs: 1 });

    await expect(resolver.resolve(ref("a.jpg"))).rejects.toThrow();
  });
});
