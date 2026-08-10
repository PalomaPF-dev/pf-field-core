import { afterEach, describe, expect, it, vi } from "vitest";
import { getImageCapabilities, probeImageCapabilities } from "../src/image/capabilities.js";

/**
 * OffscreenCanvas 相当のスタブ。
 *
 * 実ブラウザの挙動を2点そのまま再現している。ここを甘くすると検出のバグを取り逃がす:
 *   - コンテキストを取らずに convertToBlob を呼ぶと InvalidStateError
 *   - 未対応の形式を渡すと PNG にフォールバックする（例外にはならない）
 */
function stubOffscreenCanvas(options?: { webp?: boolean }) {
  class FakeOffscreenCanvas {
    #context: object | null = null;
    constructor(
      public width: number,
      public height: number,
    ) {}
    getContext(kind: string): object | null {
      if (kind !== "2d") return null;
      this.#context = {};
      return this.#context;
    }
    async convertToBlob(o?: { type?: string }): Promise<Blob> {
      if (this.#context === null) {
        const e = new Error('"OffscreenCanvas" has no rendering context.');
        e.name = "InvalidStateError";
        throw e;
      }
      const type = o?.type ?? "image/png";
      if (type === "image/webp" && options?.webp === false) {
        return new Blob([new Uint8Array([1])], { type: "image/png" });
      }
      return new Blob([new Uint8Array([1])], { type });
    }
  }
  vi.stubGlobal("OffscreenCanvas", FakeOffscreenCanvas);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("getImageCapabilities", () => {
  it("何も無い環境では renderer が unavailable になる", () => {
    vi.stubGlobal("OffscreenCanvas", undefined);
    vi.stubGlobal("Worker", undefined);
    vi.stubGlobal("createImageBitmap", undefined);
    vi.stubGlobal("document", undefined);

    const caps = getImageCapabilities();
    expect(caps.offscreenCanvas).toBe(false);
    expect(caps.htmlCanvas).toBe(false);
    expect(caps.renderer).toBe("unavailable");
  });

  it("OffscreenCanvas があれば OffscreenCanvas 経路を選ぶ", () => {
    stubOffscreenCanvas();
    vi.stubGlobal("Worker", class {});
    vi.stubGlobal("createImageBitmap", () => Promise.resolve({}));

    const caps = getImageCapabilities();
    expect(caps.offscreenCanvas).toBe(true);
    expect(caps.convertToBlob).toBe(true);
    // Worker オフロードは未実装（M1b）。Worker があっても offscreen-worker とは言わない
    expect(caps.renderer).toBe("offscreen-main");
    expect(caps.worker).toBe(true);
  });

  it("Worker の有無は renderer の選択を変えない（まだ使っていないため）", () => {
    stubOffscreenCanvas();
    vi.stubGlobal("Worker", undefined);
    vi.stubGlobal("createImageBitmap", () => Promise.resolve({}));

    const caps = getImageCapabilities();
    expect(caps.renderer).toBe("offscreen-main");
    expect(caps.worker).toBe(false);
  });

  it("OffscreenCanvas が無ければ HTMLCanvasElement に落ちる", () => {
    vi.stubGlobal("OffscreenCanvas", undefined);
    vi.stubGlobal("Worker", class {});
    vi.stubGlobal("createImageBitmap", () => Promise.resolve({}));
    vi.stubGlobal("document", { createElement: () => ({}) });

    const caps = getImageCapabilities();
    expect(caps.htmlCanvas).toBe(true);
    expect(caps.renderer).toBe("canvas");
  });

  it("同期版は imageOrientationFromImage を主張しない", () => {
    // 実際に呼ばないと分からないので、常に false（probe で確かめる）
    expect(getImageCapabilities().imageOrientationFromImage).toBe(false);
  });
});

describe("probeImageCapabilities", () => {
  it("from-image を受け付ける環境では true になる", async () => {
    const spy = vi.fn(async () => ({ close: () => {} }));
    vi.stubGlobal("createImageBitmap", spy);
    stubOffscreenCanvas();
    vi.stubGlobal("Worker", class {});

    const caps = await probeImageCapabilities();

    expect(caps.imageOrientationFromImage).toBe(true);
    expect(spy).toHaveBeenCalledWith(expect.any(Blob), { imageOrientation: "from-image" });
  });

  it("未対応の環境（enum 不一致で TypeError）では false になる", async () => {
    // WebIDL の enum に 'from-image' が無いブラウザは TypeError を投げる。
    // UA 判定ではなくこの挙動で見分ける
    vi.stubGlobal("createImageBitmap", async () => {
      throw new TypeError("The provided value 'from-image' is not a valid enum value");
    });
    vi.stubGlobal("OffscreenCanvas", undefined);
    vi.stubGlobal("document", undefined);

    const caps = await probeImageCapabilities();
    expect(caps.imageOrientationFromImage).toBe(false);
  });

  it("WebP をエンコードできるかを実際に確かめる", async () => {
    vi.stubGlobal("createImageBitmap", async () => ({ close: () => {} }));
    stubOffscreenCanvas({ webp: true });
    vi.stubGlobal("Worker", class {});

    expect((await probeImageCapabilities()).webp).toBe(true);

    stubOffscreenCanvas({ webp: false });
    expect((await probeImageCapabilities()).webp).toBe(false);
  });

  it("検出が失敗しても例外を投げない", async () => {
    vi.stubGlobal("createImageBitmap", () => {
      throw new Error("壊れている");
    });
    vi.stubGlobal("OffscreenCanvas", undefined);
    vi.stubGlobal("document", undefined);

    await expect(probeImageCapabilities()).resolves.toBeTruthy();
  });
});
