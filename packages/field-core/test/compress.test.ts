import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { compressImage, compressImages } from "../src/image/compress.js";
import { resetDecodeCapabilityCache } from "../src/image/decode.js";
import { FieldCoreError } from "../src/shared/errors.js";
import { exifJpegBlob } from "./helpers/exif-jpeg.js";

/**
 * ブラウザの画像 API を差し替えて、compressImage の「段取り」を検証する。
 *
 * 実際の画質・実行時間は、この層では測れない（それは playground の /bench と
 * 実機での確認が受け持つ）。ここで確かめたいのは、寸法・向き・再エンコードの
 * 要否といった判断が正しいかどうか。
 */

interface DrawCall {
  drawWidth: number;
  drawHeight: number;
  matrix: number[];
}

interface Harness {
  canvases: { width: number; height: number }[];
  draws: DrawCall[];
  encodes: { type: string; quality: number }[];
}

function stubBrowser(config: {
  /** デコード結果の寸法 */
  bitmap: { width: number; height: number };
  /** createImageBitmap が imageOrientation:'from-image' を受け付けるか */
  fromImageSupported?: boolean;
  /** 品質に対する出力サイズ */
  sizeAt?: (quality: number) => number;
}): Harness {
  const harness: Harness = { canvases: [], draws: [], encodes: [] };
  const sizeAt = config.sizeAt ?? (() => 300_000);
  const fromImageSupported = config.fromImageSupported ?? true;

  vi.stubGlobal("createImageBitmap", async (_blob: Blob, options?: { imageOrientation?: string }) => {
    if (options?.imageOrientation === "from-image" && !fromImageSupported) {
      throw new TypeError("'from-image' is not a valid enum value");
    }
    return { width: config.bitmap.width, height: config.bitmap.height, close: () => {} };
  });

  class FakeOffscreenCanvas {
    #context: object | null = null;
    constructor(
      public width: number,
      public height: number,
    ) {
      harness.canvases.push({ width, height });
    }
    getContext(kind: string) {
      if (kind !== "2d") return null;
      let pending: number[] = [1, 0, 0, 1, 0, 0];
      this.#context = {
        imageSmoothingEnabled: true,
        imageSmoothingQuality: "high",
        setTransform: (a: number, b: number, c: number, d: number, e: number, f: number) => {
          pending = [a, b, c, d, e, f];
        },
        drawImage: (_src: unknown, _x: number, _y: number, w: number, h: number) => {
          harness.draws.push({ drawWidth: w, drawHeight: h, matrix: pending });
        },
      };
      return this.#context;
    }
    async convertToBlob(o?: { type?: string; quality?: number }): Promise<Blob> {
      if (this.#context === null) {
        const e = new Error("no rendering context");
        e.name = "InvalidStateError";
        throw e;
      }
      const quality = o?.quality ?? 1;
      harness.encodes.push({ type: o?.type ?? "image/png", quality });
      return new Blob([new Uint8Array(Math.round(sizeAt(quality)))], {
        type: o?.type ?? "image/jpeg",
      });
    }
  }

  vi.stubGlobal("OffscreenCanvas", FakeOffscreenCanvas);
  vi.stubGlobal("document", undefined);
  return harness;
}

function jpeg(size: number): Blob {
  // EXIF を持たない最小の JPEG ヘッダ + 詰め物（parseExif は orientation=1 を返す）
  const header = new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0x00, 0x02]);
  return new Blob([header, new Uint8Array(Math.max(0, size - header.length))], {
    type: "image/jpeg",
  });
}

beforeEach(() => {
  resetDecodeCapabilityCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetDecodeCapabilityCache();
});

describe("compressImage", () => {
  it("長辺を maxEdge に収める", async () => {
    const h = stubBrowser({ bitmap: { width: 4000, height: 3000 } });
    const result = await compressImage(jpeg(3_000_000), { maxEdge: 1440 });

    expect(result.width).toBe(1440);
    expect(result.height).toBe(1080);
    expect(h.canvases[0]).toEqual({ width: 1440, height: 1080 });
    expect(h.draws[0]?.drawWidth).toBe(1440);
  });

  it("小さい写真を引き伸ばさない", async () => {
    // 拡大しても情報は増えず、ファイルだけ太る
    const h = stubBrowser({ bitmap: { width: 800, height: 600 }, sizeAt: () => 500_000 });
    const result = await compressImage(jpeg(600_000), { maxEdge: 1440 });

    expect(result.width).toBe(800);
    expect(h.canvases[0]).toEqual({ width: 800, height: 600 });
  });

  it("元の画像がすでに条件を満たすなら再エンコードしない", async () => {
    // 触らないほうが画質が落ちない
    const h = stubBrowser({ bitmap: { width: 1200, height: 900 } });
    const input = jpeg(250_000);
    const result = await compressImage(input, { maxEdge: 1440 });

    expect(result.renderer).toBe("passthrough");
    expect(result.passes).toBe(0);
    expect(result.blob).toBe(input);
    expect(h.encodes).toHaveLength(0);
  });

  it("圧縮したほうが大きくなるなら元をそのまま使う", async () => {
    // 長辺だけがわずかに超過している写真でよく起きる。
    // 画質を落としたのにファイルは太る、という最悪の取引を避ける
    const h = stubBrowser({ bitmap: { width: 1600, height: 1200 }, sizeAt: () => 320_000 });
    const input = jpeg(195_000);
    const result = await compressImage(input, { maxEdge: 1440 });

    expect(result.renderer).toBe("passthrough");
    expect(result.blob).toBe(input);
    expect(result.bytes).toBe(195_000);
    // 一度は試している（試さないと大きくなると分からない）
    expect(h.encodes.length).toBeGreaterThan(0);
    expect(result.passes).toBeGreaterThan(0);
  });

  it("向きの焼き込みが要るなら、大きくなっても再エンコードを使う", async () => {
    // 回っていない写真を送るわけにいかない
    stubBrowser({ bitmap: { width: 1600, height: 1200 }, sizeAt: () => 320_000, fromImageSupported: false });
    const input = exifJpegBlob({ orientation: 6, padBytes: 195_000 });
    const result = await compressImage(input, { maxEdge: 1440 });

    expect(result.renderer).toBe("offscreen-main");
    expect(result.bytes).toBe(320_000);
  });

  it("大きすぎる元画像は再エンコードする", async () => {
    const h = stubBrowser({ bitmap: { width: 1200, height: 900 } });
    const result = await compressImage(jpeg(900_000), { maxEdge: 1440 });

    expect(result.renderer).toBe("offscreen-main");
    expect(h.encodes.length).toBeGreaterThan(0);
  });

  describe("EXIF の向き", () => {
    /** 指定した向きの EXIF を持つ JPEG */
    function orientedJpeg(orientation: number, size = 3_000_000): Blob {
      return exifJpegBlob({ orientation, padBytes: size });
    }

    it("デコーダが向きを適用できるなら、こちらでは回さない", async () => {
      // from-image 対応時、bitmap は既に回転済みで返る（縦横も入れ替わっている）
      const h = stubBrowser({
        bitmap: { width: 3000, height: 4000 },
        fromImageSupported: true,
      });
      const result = await compressImage(orientedJpeg(6), { maxEdge: 1440 });

      expect(result.orientation).toBe(6);
      // 恒等変換のまま（二重に回さない）
      expect(h.draws[0]?.matrix).toEqual([1, 0, 0, 1, 0, 0]);
      expect(result.width).toBe(1080);
      expect(result.height).toBe(1440);
    });

    it("デコーダが対応していなければ自前で回す", async () => {
      const h = stubBrowser({
        bitmap: { width: 4000, height: 3000 }, // 回転前の寸法で返ってくる
        fromImageSupported: false,
      });
      const result = await compressImage(orientedJpeg(6), { maxEdge: 1440 });

      expect(result.orientation).toBe(6);
      // キャンバスは縦横が入れ替わる
      expect(h.canvases[0]).toEqual({ width: 1080, height: 1440 });
      expect(result.width).toBe(1080);
      expect(result.height).toBe(1440);
      // 恒等変換ではない
      expect(h.draws[0]?.matrix).not.toEqual([1, 0, 0, 1, 0, 0]);
    });

    it("向きが 1 以外なら、小さい写真でも再エンコードして焼き込む", async () => {
      // そのまま返すと、送った先で横倒しのまま表示される
      const h = stubBrowser({ bitmap: { width: 1200, height: 900 }, fromImageSupported: false });
      const result = await compressImage(orientedJpeg(8, 250_000), { maxEdge: 1440 });

      expect(result.renderer).not.toBe("passthrough");
      expect(h.encodes.length).toBeGreaterThan(0);
    });
  });

  it("品質を下げきっても大きい場合は寸法を落として再挑戦する", async () => {
    // どの品質でも 1MB を超える → 長辺を縮めるしかない
    const h = stubBrowser({ bitmap: { width: 4000, height: 3000 }, sizeAt: () => 1_200_000 });
    await compressImage(jpeg(5_000_000), { maxEdge: 1440, maxPasses: 4 });

    expect(h.canvases.length).toBeGreaterThan(1);
    expect(h.canvases[1]!.width).toBeLessThan(h.canvases[0]!.width);
  });

  describe("撮影時刻", () => {
    it("EXIF から拾い上げて結果に載せる", async () => {
      // canvas 再エンコードで EXIF は落ちるので、ここで拾わないと撮影時刻が失われる
      stubBrowser({ bitmap: { width: 4000, height: 3000 } });
      const input = exifJpegBlob({
        orientation: 1,
        dateTimeOriginal: "2026:08:10 14:32:05",
        padBytes: 3_000_000,
      });
      const result = await compressImage(input, { maxEdge: 1440 });

      expect(result.capturedAt).toBeDefined();
      const d = new Date(result.capturedAt as number);
      expect(d.getFullYear()).toBe(2026);
      expect(d.getHours()).toBe(14);
    });

    it("EXIF が無ければ undefined のまま（嘘の時刻を作らない）", async () => {
      stubBrowser({ bitmap: { width: 1200, height: 900 } });
      const result = await compressImage(jpeg(250_000));
      expect(result.capturedAt).toBeUndefined();
    });
  });

  it("元の寸法とサイズを記録する", async () => {
    stubBrowser({ bitmap: { width: 4000, height: 3000 } });
    const result = await compressImage(jpeg(3_000_000), { maxEdge: 1440 });

    expect(result.original).toEqual({
      bytes: 3_000_000,
      width: 4000,
      height: 3000,
      type: "image/jpeg",
    });
    expect(result.bytes).toBe(result.blob.size);
  });

  describe("入力の検証", () => {
    it("画像でない Blob は明示的に断る", async () => {
      stubBrowser({ bitmap: { width: 10, height: 10 } });
      const pdf = new Blob([new Uint8Array(100)], { type: "application/pdf" });
      await expect(compressImage(pdf)).rejects.toThrow(FieldCoreError);
      await expect(compressImage(pdf)).rejects.toThrow(/compress: false/);
    });

    it("空のファイルを断る", async () => {
      stubBrowser({ bitmap: { width: 10, height: 10 } });
      await expect(compressImage(new Blob([], { type: "image/jpeg" }))).rejects.toThrow(
        FieldCoreError,
      );
    });

    it("不正な maxEdge を断る", async () => {
      stubBrowser({ bitmap: { width: 10, height: 10 } });
      await expect(compressImage(jpeg(1000), { maxEdge: 0 })).rejects.toThrow(/maxEdge/);
    });
  });

  it("中止できる", async () => {
    stubBrowser({ bitmap: { width: 4000, height: 3000 } });
    const controller = new AbortController();
    controller.abort();

    await expect(compressImage(jpeg(3_000_000), { signal: controller.signal })).rejects.toThrow();
  });

  it("targetBytes:false なら1回だけエンコードする", async () => {
    const h = stubBrowser({ bitmap: { width: 4000, height: 3000 }, sizeAt: () => 900_000 });
    const result = await compressImage(jpeg(3_000_000), { targetBytes: false, quality: 0.7 });

    expect(h.encodes).toHaveLength(1);
    expect(h.encodes[0]?.quality).toBe(0.7);
    expect(result.passes).toBe(1);
  });

  it("進捗を通知する", async () => {
    stubBrowser({ bitmap: { width: 4000, height: 3000 } });
    const phases: string[] = [];
    await compressImage(jpeg(3_000_000), { onProgress: (p) => phases.push(p.phase) });

    expect(phases).toContain("decode");
    expect(phases).toContain("resize");
    expect(phases).toContain("encode");
  });
});

describe("compressImages", () => {
  it("直列に処理する（弱い端末でメモリを溢れさせない）", async () => {
    const h = stubBrowser({ bitmap: { width: 4000, height: 3000 } });
    const results = await compressImages([jpeg(3_000_000), jpeg(3_000_000), jpeg(3_000_000)]);

    expect(results).toHaveLength(3);
    // 同時に3枚ぶんのキャンバスを抱えていない
    expect(h.canvases).toHaveLength(3);
  });

  it("途中で中止できる", async () => {
    stubBrowser({ bitmap: { width: 4000, height: 3000 } });
    const controller = new AbortController();
    controller.abort();

    await expect(
      compressImages([jpeg(3_000_000)], { signal: controller.signal }),
    ).rejects.toThrow();
  });
});
