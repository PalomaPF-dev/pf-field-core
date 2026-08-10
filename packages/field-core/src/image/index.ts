/**
 * 画像圧縮。
 *
 * M0 では機能検出のみ。compressImage 本体は M1 で入る。
 * 機能検出を先に出しているのは、Zebra 端末の WebView バージョンが未確定で、
 * 実機で採取した結果を見てからフォールバック経路の優先度を決めたいため。
 */

export type {
  CompressedImage,
  CompressImageOptions,
  CompressMimeType,
  CompressProgress,
  ImageCapabilities,
  ImageRenderer,
} from "./types.js";
export { DEFAULT_COMPRESS_OPTIONS } from "./types.js";

export { getImageCapabilities, probeImageCapabilities } from "./capabilities.js";
