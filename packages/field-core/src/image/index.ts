/**
 * 画像圧縮。
 *
 * 長辺 1440px / JPEG 品質 0.75 を起点に、200〜400KB へ収まるまで品質を二分探索する。
 * EXIF Orientation は焼き込む（canvas 再エンコードで EXIF 自体は落ちるため）。
 * 撮影時刻だけは `capturedAt` として拾い上げ、構造化データ側でサーバへ送る。
 *
 * Worker へのオフロードは未実装（M1b）。OffscreenCanvas 経路では
 * デコードもエンコードも非同期なのでメインスレッドは概ね空くはずで、
 * 実機での実測（playground の /bench）を見てから入れるか決める。
 */

export type {
  CanvasRenderer,
  CompressedImage,
  CompressImageOptions,
  CompressMimeType,
  CompressProgress,
  ImageCapabilities,
  ImageRenderer,
} from "./types.js";
export { DEFAULT_COMPRESS_OPTIONS } from "./types.js";

export { compressImage, compressImages } from "./compress.js";

export { getImageCapabilities, probeImageCapabilities } from "./capabilities.js";

export type { ExifSummary } from "./exif.js";
export { parseExif, parseExifDateTime, readExif, readExifOrientation } from "./exif.js";

export type { OrientationTransform } from "./orientation.js";
export {
  orientationTransform,
  orientedSize,
  scaledSize,
  scaleToFit,
  swapsAxes,
} from "./orientation.js";

export type { QualitySearchOptions, QualitySearchReason, QualitySearchResult } from "./quality-search.js";
export { searchQuality } from "./quality-search.js";
