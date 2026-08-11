import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMasterCache, type MasterCache } from "../src/master/cache.js";
import { openFieldDB, type FieldDB } from "../src/db/open.js";
import type { StoredObjectRef } from "../src/storage/types.js";
import { noopLogger } from "../src/shared/logger.js";

/**
 * マスタのローカルキャッシュ（M6）。
 *
 * 目的は「圏外で点検を新規に開始できる」こと。
 * キューと逆で、マスタは**いつでも取り直せる**ので容量が苦しければ捨ててよい。
 * ここで確かめるのは、その判断が正しく効いているかと、
 * **UI が「オンライン時に表示されます」を出せる状態を返すか**。
 */

function ref(path: string): StoredObjectRef {
  return { provider: "supabase", bucket: "field-uploads", path };
}

function setOnline(value: boolean) {
  vi.stubGlobal("navigator", { onLine: value });
}

/** 画像を返す fetch。呼ばれた URL を覚える */
function stubFetch(bytes = 1000, status = 200) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      calls.push(String(input));
      return {
        status,
        headers: { get: () => "image/jpeg" },
        arrayBuffer: async () => new ArrayBuffer(bytes),
      } as unknown as Response;
    }),
  );
  return calls;
}

let dbCounter = 0;
let db: FieldDB;
let cache: MasterCache;

beforeEach(async () => {
  dbCounter++;
  db = await openFieldDB(`pf-field-master-${dbCounter}`);
  setOnline(true);
  cache = await createMasterCache({ appId: "test", db, scope: "paloma/f1", logger: noopLogger });
});

afterEach(async () => {
  await cache.destroy();
  db.close();
  vi.unstubAllGlobals();
});

describe("一覧系マスタ", () => {
  it("全置換で保存し、読み戻せる", async () => {
    await cache.put({ collection: "equipment", items: [{ id: "EQ-1" }, { id: "EQ-2" }] });
    expect(await cache.get<{ id: string }>("equipment")).toHaveLength(2);

    // 差分ではなく丸ごと置き換える
    await cache.put({ collection: "equipment", items: [{ id: "EQ-9" }] });
    expect(await cache.get<{ id: string }>("equipment")).toEqual([{ id: "EQ-9" }]);
  });

  it("スコープが違えば別物として持つ", async () => {
    await cache.put({ collection: "equipment", items: [{ id: "A" }] });

    const other = await createMasterCache({ appId: "test", db, scope: "other/f9" });
    expect(await other.get("equipment")).toBeUndefined();
    await other.destroy();
  });

  it("版が同じなら書き換えない", async () => {
    let calls = 0;
    const withFetch = await createMasterCache({
      appId: "test",
      db,
      scope: "paloma/f1",
      fetchCollections: async () => {
        calls++;
        return [{ collection: "equipment", items: [{ id: "EQ-1" }], version: "v1" }];
      },
    });

    expect((await withFetch.refresh()).updated).toEqual(["equipment"]);
    expect((await withFetch.refresh()).updated).toEqual([]);
    expect(calls).toBe(2);
    await withFetch.destroy();
  });

  it("★ 取得に失敗しても既存のキャッシュを消さない", async () => {
    await cache.put({ collection: "equipment", items: [{ id: "EQ-1" }] });

    const failing = await createMasterCache({
      appId: "test",
      db,
      scope: "paloma/f1",
      logger: noopLogger,
      fetchCollections: async () => {
        throw new Error("圏外");
      },
    });

    const result = await failing.refresh();
    expect(result.skipped).toBe(true);
    // 消えていたら、圏外で点検を開始できなくなる
    expect(await cache.get("equipment")).toHaveLength(1);
    await failing.destroy();
  });

  it("圏外では取りに行かない", async () => {
    setOnline(false);
    let called = false;
    const offline = await createMasterCache({
      appId: "test",
      db,
      scope: "paloma/f1",
      fetchCollections: async () => {
        called = true;
        return [];
      },
    });

    expect((await offline.refresh()).skipped).toBe(true);
    expect(called).toBe(false);
    await offline.destroy();
  });
});

describe("メディアの先読み", () => {
  it("点検開始時に該当分だけ取る", async () => {
    const calls = stubFetch();

    const result = await cache.prefetch({
      groupId: "sheet-1",
      refs: [ref("a.jpg"), ref("b.jpg")],
    });

    expect(result).toMatchObject({ fetched: 2, reused: 0, failed: 0 });
    expect(calls).toHaveLength(2);
  });

  it("既にあるものは取り直さない", async () => {
    stubFetch();
    await cache.prefetch({ groupId: "sheet-1", refs: [ref("a.jpg")] });

    const calls = stubFetch();
    const result = await cache.prefetch({ groupId: "sheet-1", refs: [ref("a.jpg")] });

    expect(result.reused).toBe(1);
    expect(calls).toHaveLength(0);
  });

  it("1枚取れなくても点検は開始できる", async () => {
    stubFetch(1000, 500);
    const result = await cache.prefetch({ groupId: "sheet-1", refs: [ref("a.jpg")] });

    // 例外にしない。失敗の件数だけ返す
    expect(result.failed).toBe(1);
    expect(result.fetched).toBe(0);
  });

  it("括り単位で捨てられる", async () => {
    stubFetch();
    await cache.prefetch({ groupId: "sheet-1", refs: [ref("a.jpg"), ref("b.jpg")] });
    await cache.prefetch({ groupId: "sheet-2", refs: [ref("c.jpg")] });

    expect(await cache.purgeGroup("sheet-1")).toBe(2);
    expect((await cache.stats()).assets.count).toBe(1);
  });

  it("上限を超えたら古い順に捨てる", async () => {
    const small = await createMasterCache({
      appId: "test",
      db,
      scope: "paloma/f1",
      logger: noopLogger,
      limits: { maxAssetBytes: 2500 },
    });

    stubFetch(1000);
    await small.prefetch({ groupId: "g1", refs: [ref("a.jpg"), ref("b.jpg"), ref("c.jpg")] });

    const stats = await small.stats();
    // 未送信ジョブの添付には触らず、マスタだけを削って収める
    expect(stats.assets.bytes).toBeLessThanOrEqual(2500);
    await small.destroy();
  });

  it("1つの括りで持ちすぎない", async () => {
    const capped = await createMasterCache({
      appId: "test",
      db,
      scope: "paloma/f1",
      logger: noopLogger,
      limits: { maxAssetsPerGroup: 2 },
    });

    stubFetch(100);
    const result = await capped.prefetch({
      groupId: "g1",
      refs: [ref("a"), ref("b"), ref("c"), ref("d")],
    });

    expect(result.fetched).toBe(2);
    await capped.destroy();
  });
});

describe("★ 表示可否の判定（UI の文言を決める）", () => {
  it("端末にあれば cached", async () => {
    stubFetch();
    await cache.prefetch({ groupId: "sheet-1", refs: [ref("a.jpg")] });

    // URL.createObjectURL は Node に無いので差し替える
    vi.stubGlobal("URL", { ...URL, createObjectURL: () => "blob:x" });

    const availability = await cache.availability(ref("a.jpg"));
    expect(availability.state).toBe("cached");
  });

  it("端末に無くてもオンラインなら online（いま取りに行ける）", async () => {
    const withUrls = await createMasterCache({
      appId: "test",
      db,
      scope: "paloma/f1",
      urls: {
        resolve: async () => "https://signed.example.com/a.jpg",
        resolveMany: async () => [],
        invalidate: () => {},
      },
    });

    expect(await withUrls.availability(ref("nope.jpg"))).toEqual({
      state: "online",
      url: "https://signed.example.com/a.jpg",
    });
    await withUrls.destroy();
  });

  it("★ 圏外で端末にも無ければ unavailable（オンライン時に表示されます）", async () => {
    setOnline(false);

    const availability = await cache.availability(ref("nope.jpg"));

    // ここが「読み込み失敗」や「画像がありません」になってはいけない。
    // 現場ではデータの不備に見えてしまう
    expect(availability).toEqual({ state: "unavailable", reason: "offline" });
  });

  it("圏外でも、先読み済みなら表示できる", async () => {
    stubFetch();
    await cache.prefetch({ groupId: "sheet-1", refs: [ref("a.jpg")] });

    setOnline(false);
    vi.stubGlobal("URL", { ...URL, createObjectURL: () => "blob:x" });

    // これが成り立たないと、先読みした意味が無い
    expect((await cache.availability(ref("a.jpg"))).state).toBe("cached");
  });
});
