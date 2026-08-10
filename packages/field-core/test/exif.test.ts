import { describe, expect, it } from "vitest";
import { parseExif, parseExifDateTime, readExif } from "../src/image/exif.js";
import { buildExifJpeg, TIFF_START } from "./helpers/exif-jpeg.js";

function toView(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

describe("parseExif", () => {
  it.each([1, 2, 3, 4, 5, 6, 7, 8])("向き %i を読める（リトルエンディアン）", (orientation) => {
    const result = parseExif(toView(buildExifJpeg({ orientation })));
    expect(result.found).toBe(true);
    expect(result.orientation).toBe(orientation);
  });

  it.each([1, 6, 8])("向き %i を読める（ビッグエンディアン）", (orientation) => {
    // 一眼レフや一部のスマホは "MM" で書く
    const result = parseExif(toView(buildExifJpeg({ orientation, littleEndian: false })));
    expect(result.orientation).toBe(orientation);
  });

  it("APP1 の前に別セグメントがあっても見つけられる", () => {
    // JFIF の APP0 が先に来るのが普通
    const app0 = [0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0];
    const result = parseExif(toView(buildExifJpeg({ orientation: 6, precedingSegments: app0 })));
    expect(result.orientation).toBe(6);
  });

  it("撮影時刻を読める", () => {
    const result = parseExif(toView(buildExifJpeg({ orientation: 1, dateTimeOriginal: "2026:08:10 14:32:05" })));
    expect(result.capturedAt).toBeDefined();
    const d = new Date(result.capturedAt as number);
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(7); // 8月
    expect(d.getDate()).toBe(10);
    expect(d.getHours()).toBe(14);
  });

  it("Orientation タグが無ければ 1 として扱う", () => {
    const result = parseExif(toView(buildExifJpeg({ dateTimeOriginal: "2026:08:10 14:32:05" })));
    expect(result.orientation).toBe(1);
    expect(result.capturedAt).toBeDefined();
  });

  it("範囲外の Orientation は 1 に丸める", () => {
    expect(parseExif(toView(buildExifJpeg({ orientation: 0 }))).orientation).toBe(1);
    expect(parseExif(toView(buildExifJpeg({ orientation: 99 }))).orientation).toBe(1);
  });

  describe("壊れた入力", () => {
    // 写真1枚が読めないことより、写真を1枚も送れなくなるほうが害が大きい。
    // どんな入力でも例外は投げず「不明」に倒す
    it("EXIF が無い JPEG", () => {
      const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0x00, 0x02]);
      expect(parseExif(toView(bytes))).toEqual({ orientation: 1, found: false });
    });

    it("JPEG ですらないデータ", () => {
      const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); // PNG
      expect(parseExif(toView(bytes)).orientation).toBe(1);
    });

    it("空", () => {
      expect(parseExif(toView(new Uint8Array(0))).orientation).toBe(1);
    });

    it("途中で切れた APP1", () => {
      const full = buildExifJpeg({ orientation: 6 });
      const truncated = full.slice(0, 20);
      expect(() => parseExif(toView(truncated))).not.toThrow();
      expect(parseExif(toView(truncated)).orientation).toBe(1);
    });

    it("組み立てたヘッダの TIFF 位置が想定どおり（この後の破壊テストの前提）", () => {
      const bytes = buildExifJpeg({ orientation: 6 });
      // "II" または "MM" が来ているはず
      expect([0x49, 0x4d]).toContain(bytes[TIFF_START]);
      expect(bytes[TIFF_START]).toBe(bytes[TIFF_START + 1]);
    });

    it("TIFF のマジックが壊れている", () => {
      const bytes = buildExifJpeg({ orientation: 6 });
      bytes[TIFF_START] = 0x00;
      bytes[TIFF_START + 1] = 0x00;
      expect(parseExif(toView(bytes)).orientation).toBe(1);
    });

    it("IFD のエントリ数が異常に大きい", () => {
      // 壊れたファイルで巨大なループに入らないこと
      const bytes = buildExifJpeg({ orientation: 6 });
      new DataView(bytes.buffer).setUint16(TIFF_START + 8, 60000, true);
      expect(parseExif(toView(bytes)).orientation).toBe(1);
    });
  });
});

describe("readExif", () => {
  it("Blob から読める", async () => {
    const blob = new Blob([buildExifJpeg({ orientation: 6 })], { type: "image/jpeg" });
    expect((await readExif(blob)).orientation).toBe(6);
  });

  it("先頭だけを読む（大きな画像を丸ごとメモリに載せない）", async () => {
    const header = buildExifJpeg({ orientation: 8 });
    const padding = new Uint8Array(2 * 1024 * 1024);
    const blob = new Blob([header, padding], { type: "image/jpeg" });

    const result = await readExif(blob, 4096);
    expect(result.orientation).toBe(8);
  });

  it("読めない Blob でも例外を投げない", async () => {
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: "application/octet-stream" });
    await expect(readExif(blob)).resolves.toEqual({ orientation: 1, found: false });
  });
});

describe("parseExifDateTime", () => {
  it("EXIF の書式を解釈する", () => {
    const at = parseExifDateTime("2026:08:10 14:32:05");
    expect(at).not.toBeNull();
    expect(new Date(at as number).getFullYear()).toBe(2026);
  });

  it("明らかに嘘の値は捨てる", () => {
    // 時計が初期化されていない端末が "0000:00:00 00:00:00" を書くことがある
    expect(parseExifDateTime("0000:00:00 00:00:00")).toBeNull();
    expect(parseExifDateTime("1970:01:01 00:00:00")).toBeNull();
  });

  it("書式が違えば null", () => {
    expect(parseExifDateTime("2026-08-10T14:32:05Z")).toBeNull();
    expect(parseExifDateTime("")).toBeNull();
    expect(parseExifDateTime("なにか")).toBeNull();
  });
});
