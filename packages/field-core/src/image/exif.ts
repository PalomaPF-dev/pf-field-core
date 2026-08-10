/**
 * JPEG の EXIF から、圧縮に必要な最小限だけを読む。
 *
 * 読むのは2つ:
 *   - Orientation (0x0112) — 向きを焼き込むために要る
 *   - DateTimeOriginal (0x9003) — canvas 再エンコードで EXIF は落ちるので、
 *     撮影時刻だけは構造化データ側へ持ち上げてサーバへ送る
 *
 * 汎用の EXIF ライブラリは入れない。現場写真の JPEG から2タグ取るだけに
 * 数十KB のバンドルを増やす価値がないため。壊れた入力では例外を投げず
 * 「不明（orientation=1）」に倒す — 写真が1枚も送れなくなるほうが害が大きい。
 */

export interface ExifSummary {
  /** 1..8。読めなければ 1 */
  orientation: number;
  /**
   * DateTimeOriginal を epoch ms にしたもの。
   * EXIF のこのタグはタイムゾーンを持たないため**端末ローカル時刻として解釈する**。
   * 厳密な時刻が要る用途にはサーバ側の受信時刻を使うこと。
   */
  capturedAt?: number;
  /** EXIF が見つかったか（診断用） */
  found: boolean;
}

const NO_EXIF: ExifSummary = { orientation: 1, found: false };

/** EXIF は先頭に来る。全体を読み込まないための上限。 */
const DEFAULT_SCAN_BYTES = 128 * 1024;

const TAG_ORIENTATION = 0x0112;
const TAG_EXIF_IFD_POINTER = 0x8769;
const TAG_DATE_TIME_ORIGINAL = 0x9003;

export async function readExif(input: Blob, scanBytes = DEFAULT_SCAN_BYTES): Promise<ExifSummary> {
  try {
    const head = input.size > scanBytes ? input.slice(0, scanBytes) : input;
    const buffer = await head.arrayBuffer();
    return parseExif(new DataView(buffer));
  } catch {
    return NO_EXIF;
  }
}

export async function readExifOrientation(input: Blob): Promise<number> {
  return (await readExif(input)).orientation;
}

/** DataView から直接読む（テストと Worker 用）。 */
export function parseExif(view: DataView): ExifSummary {
  const app1 = findApp1(view);
  if (app1 === null) return NO_EXIF;
  return parseTiff(view, app1);
}

/**
 * JPEG のマーカーを辿って APP1(Exif) の TIFF 先頭オフセットを探す。
 * 見つからなければ null。
 */
function findApp1(view: DataView): number | null {
  if (view.byteLength < 4) return null;
  // SOI
  if (view.getUint16(0) !== 0xffd8) return null;

  let offset = 2;
  while (offset + 4 <= view.byteLength) {
    const marker = view.getUint16(offset);
    // マーカーは必ず 0xFF で始まる。ずれたら諦める
    if ((marker & 0xff00) !== 0xff00) return null;

    // SOS (0xFFDA) 以降は画像データ。EXIF はここより前にしかない
    if (marker === 0xffda) return null;

    const segmentLength = view.getUint16(offset + 2);
    if (segmentLength < 2) return null;

    if (marker === 0xffe1) {
      const dataStart = offset + 4;
      // "Exif\0\0"
      if (
        dataStart + 6 <= view.byteLength &&
        view.getUint32(dataStart) === 0x45786966 &&
        view.getUint16(dataStart + 4) === 0x0000
      ) {
        return dataStart + 6;
      }
    }

    offset += 2 + segmentLength;
  }
  return null;
}

function parseTiff(view: DataView, tiffStart: number): ExifSummary {
  if (tiffStart + 8 > view.byteLength) return NO_EXIF;

  const byteOrder = view.getUint16(tiffStart);
  let littleEndian: boolean;
  if (byteOrder === 0x4949) littleEndian = true; // "II"
  else if (byteOrder === 0x4d4d) littleEndian = false; // "MM"
  else return NO_EXIF;

  if (view.getUint16(tiffStart + 2, littleEndian) !== 0x002a) return NO_EXIF;

  const ifd0 = tiffStart + view.getUint32(tiffStart + 4, littleEndian);

  const result: ExifSummary = { orientation: 1, found: true };

  const ifd0Entries = readIfd(view, tiffStart, ifd0, littleEndian);
  if (ifd0Entries === null) return NO_EXIF;

  const orientation = ifd0Entries.get(TAG_ORIENTATION);
  if (orientation && orientation.type === 3) {
    const value = readShort(view, orientation, littleEndian);
    if (value !== null && value >= 1 && value <= 8) result.orientation = value;
  }

  // 撮影時刻は Exif SubIFD の中にある
  const pointer = ifd0Entries.get(TAG_EXIF_IFD_POINTER);
  if (pointer && (pointer.type === 4 || pointer.type === 3)) {
    const subIfdOffset =
      pointer.type === 4
        ? view.getUint32(pointer.valueOffset, littleEndian)
        : view.getUint16(pointer.valueOffset, littleEndian);
    const subEntries = readIfd(view, tiffStart, tiffStart + subIfdOffset, littleEndian);
    const dateEntry = subEntries?.get(TAG_DATE_TIME_ORIGINAL);
    if (dateEntry && dateEntry.type === 2) {
      const text = readAscii(view, dateEntry);
      const at = parseExifDateTime(text);
      if (at !== null) result.capturedAt = at;
    }
  }

  return result;
}

interface IfdEntry {
  type: number;
  count: number;
  /** 値そのもの、または値の位置（4バイトに収まらない場合）を指す絶対オフセット */
  valueOffset: number;
}

function readIfd(
  view: DataView,
  tiffStart: number,
  ifdOffset: number,
  littleEndian: boolean,
): Map<number, IfdEntry> | null {
  if (ifdOffset < 0 || ifdOffset + 2 > view.byteLength) return null;

  const count = view.getUint16(ifdOffset, littleEndian);
  // 壊れたファイルで巨大な count を読んで固まらないよう上限を設ける
  if (count > 512) return null;
  if (ifdOffset + 2 + count * 12 > view.byteLength) return null;

  const entries = new Map<number, IfdEntry>();
  for (let i = 0; i < count; i++) {
    const entry = ifdOffset + 2 + i * 12;
    const tag = view.getUint16(entry, littleEndian);
    const type = view.getUint16(entry + 2, littleEndian);
    const valueCount = view.getUint32(entry + 4, littleEndian);
    const inlineSize = typeSize(type) * valueCount;

    const valueOffset =
      inlineSize <= 4 ? entry + 8 : tiffStart + view.getUint32(entry + 8, littleEndian);

    if (valueOffset < 0 || valueOffset >= view.byteLength) continue;
    entries.set(tag, { type, count: valueCount, valueOffset });
  }
  return entries;
}

function typeSize(type: number): number {
  switch (type) {
    case 1: // BYTE
    case 2: // ASCII
    case 6: // SBYTE
    case 7: // UNDEFINED
      return 1;
    case 3: // SHORT
    case 8: // SSHORT
      return 2;
    case 4: // LONG
    case 9: // SLONG
    case 11: // FLOAT
      return 4;
    case 5: // RATIONAL
    case 10: // SRATIONAL
    case 12: // DOUBLE
      return 8;
    default:
      return 1;
  }
}

function readShort(view: DataView, entry: IfdEntry, littleEndian: boolean): number | null {
  if (entry.valueOffset + 2 > view.byteLength) return null;
  return view.getUint16(entry.valueOffset, littleEndian);
}

function readAscii(view: DataView, entry: IfdEntry): string {
  const end = Math.min(entry.valueOffset + entry.count, view.byteLength);
  let out = "";
  for (let i = entry.valueOffset; i < end; i++) {
    const code = view.getUint8(i);
    if (code === 0) break;
    out += String.fromCharCode(code);
  }
  return out;
}

/**
 * "YYYY:MM:DD HH:MM:SS" を epoch ms にする。
 * EXIF のこのタグはタイムゾーンを持たないので端末ローカル時刻として解釈する。
 */
export function parseExifDateTime(text: string): number | null {
  const m = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(text.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  const date = new Date(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(h),
    Number(mi),
    Number(s),
  );
  const time = date.getTime();
  if (Number.isNaN(time)) return null;
  // 「0000:00:00 00:00:00」を入れてくる機種がある。明らかに嘘の値は捨てる
  if (Number(y) < 1990) return null;
  return time;
}
