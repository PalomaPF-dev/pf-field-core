import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDraftStore, type DraftStore } from "../src/draft/store.js";
import { openFieldDB, type FieldDB } from "../src/db/open.js";
import { setClock } from "../src/shared/clock.js";

/**
 * 下書きの検証。
 *
 * 「圏外で入力を継続する」の土台。Zebra 端末は WebView をバックグラウンドで
 * kill するので、書きかけが端末に残っていないと成立しない。
 */

let dbCounter = 0;
let db: FieldDB;
let drafts: DraftStore;

beforeEach(async () => {
  dbCounter++;
  db = await openFieldDB(`pf-field-draft-${dbCounter}`);
  drafts = await createDraftStore({ appId: "test", db });
});

afterEach(async () => {
  await drafts.destroy();
  db.close();
});

describe("下書き", () => {
  it("保存して読み戻せる", async () => {
    const saved = await drafts.save({
      type: "setsubi.inspection",
      value: { equipmentId: "EQ-1", note: "書きかけ" },
      label: "設備No.1",
    });

    const restored = await drafts.get<{ equipmentId: string; note: string }>(saved.draftId);
    expect(restored?.value).toEqual({ equipmentId: "EQ-1", note: "書きかけ" });
    expect(restored?.label).toBe("設備No.1");
  });

  it("同じ draftId への保存は上書きし、createdAt は保つ", async () => {
    const clock = { t: 1_000 };
    const restore = setClock({ now: () => clock.t });
    try {
      const first = await drafts.save({ type: "t", value: { n: 1 }, draftId: "d-1" });
      clock.t = 5_000;
      const second = await drafts.save({ type: "t", value: { n: 2 }, draftId: "d-1" });

      expect(second.createdAt).toBe(first.createdAt);
      expect(second.updatedAt).toBe(5_000);
      expect((await drafts.list()).length).toBe(1);
    } finally {
      restore();
    }
  });

  it("新しいものから並べる（書きかけを上に出すため）", async () => {
    const clock = { t: 1_000 };
    const restore = setClock({ now: () => clock.t });
    try {
      await drafts.save({ type: "t", value: 1, draftId: "old" });
      clock.t = 9_000;
      await drafts.save({ type: "t", value: 2, draftId: "new" });

      expect((await drafts.list()).map((d) => d.draftId)).toEqual(["new", "old"]);
    } finally {
      restore();
    }
  });

  it("種別で絞れる", async () => {
    await drafts.save({ type: "setsubi.inspection", value: 1 });
    await drafts.save({ type: "zaiko.count", value: 2 });

    expect(await drafts.list("setsubi.inspection")).toHaveLength(1);
  });

  it("破棄できる（送信を頼まれたら役目を終える）", async () => {
    const saved = await drafts.save({ type: "t", value: 1 });
    await drafts.remove(saved.draftId);
    expect(await drafts.get(saved.draftId)).toBeUndefined();
  });

  it("古いものだけを片付ける", async () => {
    const clock = { t: 1_000_000 };
    const restore = setClock({ now: () => clock.t });
    try {
      await drafts.save({ type: "t", value: 1, draftId: "old" });
      clock.t += 60_000;
      await drafts.save({ type: "t", value: 2, draftId: "fresh" });

      // 30秒より古いもの = old だけ
      const purged = await drafts.purgeOlderThan(30_000);
      expect(purged).toBe(1);
      expect((await drafts.list()).map((d) => d.draftId)).toEqual(["fresh"]);
    } finally {
      restore();
    }
  });

  it("接続を渡した場合は閉じない（キューと共有しているため）", async () => {
    await drafts.destroy();
    // 閉じられていれば例外になる
    await expect(drafts.save({ type: "t", value: 1 })).resolves.toBeTruthy();
  });
});
