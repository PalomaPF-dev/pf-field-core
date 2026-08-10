/**
 * EXIF を持つ JPEG のヘッダを組み立てるテスト用ヘルパ。
 *
 * パーサとは独立に、TIFF/EXIF の仕様どおりバイトを積んでいる
 * （同じ実装を裏返しただけのテストにしないため）。
 */
export interface BuildExifJpegOptions {
  orientation?: number;
  dateTimeOriginal?: string;
  littleEndian?: boolean;
  /** APP1 の前に別のセグメント（APP0/JFIF 等）を挟む */
  precedingSegments?: number[];
  /** SOS 以降の詰め物のバイト数。Blob サイズを稼ぎたいときに使う */
  padBytes?: number;
}

/** SOI(2) + APP1 マーカーと長さ(4) + "Exif\0\0"(6) */
export const TIFF_START = 12;

export function buildExifJpeg(options?: BuildExifJpegOptions): Uint8Array<ArrayBuffer> {
  const littleEndian = options?.littleEndian ?? true;
  const orientation = options?.orientation;
  const dateText = options?.dateTimeOriginal;

  const entries: { tag: number; type: number; count: number; value: number }[] = [];
  if (orientation !== undefined) entries.push({ tag: 0x0112, type: 3, count: 1, value: orientation });

  const ifd0Start = 8;
  const dateStringLength = dateText ? dateText.length + 1 : 0;
  const entryCount = entries.length + (dateText ? 1 : 0);
  const subIfdStart = ifd0Start + 2 + entryCount * 12 + 4;
  const dateValueOffset = subIfdStart + 2 + 12 + 4;

  if (dateText) entries.push({ tag: 0x8769, type: 4, count: 1, value: subIfdStart });

  const tiffSize = dateText ? dateValueOffset + dateStringLength : subIfdStart;
  const tiff = new Uint8Array(tiffSize);
  const view = new DataView(tiff.buffer);

  view.setUint16(0, littleEndian ? 0x4949 : 0x4d4d);
  view.setUint16(2, 0x002a, littleEndian);
  view.setUint32(4, ifd0Start, littleEndian);

  view.setUint16(ifd0Start, entries.length, littleEndian);
  entries.forEach((entry, i) => {
    const at = ifd0Start + 2 + i * 12;
    view.setUint16(at, entry.tag, littleEndian);
    view.setUint16(at + 2, entry.type, littleEndian);
    view.setUint32(at + 4, entry.count, littleEndian);
    if (entry.type === 3) {
      // SHORT は 4 バイト値領域の先頭 2 バイトに入る
      view.setUint16(at + 8, entry.value, littleEndian);
    } else {
      view.setUint32(at + 8, entry.value, littleEndian);
    }
  });
  view.setUint32(ifd0Start + 2 + entries.length * 12, 0, littleEndian);

  if (dateText) {
    view.setUint16(subIfdStart, 1, littleEndian);
    const at = subIfdStart + 2;
    view.setUint16(at, 0x9003, littleEndian);
    view.setUint16(at + 2, 2, littleEndian); // ASCII
    view.setUint32(at + 4, dateStringLength, littleEndian);
    view.setUint32(at + 8, dateValueOffset, littleEndian);
    view.setUint32(subIfdStart + 2 + 12, 0, littleEndian);
    for (let i = 0; i < dateText.length; i++) {
      tiff[dateValueOffset + i] = dateText.charCodeAt(i);
    }
    tiff[dateValueOffset + dateText.length] = 0;
  }

  const exifHeader = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00]; // "Exif\0\0"
  const app1Length = 2 + exifHeader.length + tiff.length;

  const bytes: number[] = [0xff, 0xd8]; // SOI
  if (options?.precedingSegments) bytes.push(...options.precedingSegments);
  bytes.push(0xff, 0xe1, (app1Length >> 8) & 0xff, app1Length & 0xff);
  bytes.push(...exifHeader);
  bytes.push(...tiff);
  bytes.push(0xff, 0xda, 0x00, 0x02); // SOS（以降は画像データという合図）

  const head = new Uint8Array(bytes);
  if (!options?.padBytes) return head;

  const out = new Uint8Array(head.length + options.padBytes);
  out.set(head, 0);
  return out;
}

export function exifJpegBlob(options?: BuildExifJpegOptions): Blob {
  const bytes = buildExifJpeg(options);
  return new Blob([bytes], { type: "image/jpeg" });
}
