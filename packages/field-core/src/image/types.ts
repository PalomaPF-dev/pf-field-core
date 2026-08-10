export type CompressMimeType = "image/jpeg" | "image/webp";

export interface CompressImageOptions {
  /** 長辺の最大 px。既定 1440（1280〜1600 の中央値） */
  maxEdge?: number;
  /** 初期 JPEG 品質。既定 0.75 */
  quality?: number;
  /** 目標バイト数レンジ。false で品質の再探索をしない */
  targetBytes?: { min: number; max: number } | false;
  /** 再探索でとりうる品質の範囲。既定 { min: 0.45, max: 0.85 } */
  qualityRange?: { min: number; max: number };
  /** エンコードの試行回数の上限。既定 4 */
  maxPasses?: number;
  /** 既定 'image/jpeg'。WebP は実機の互換確認後に検討する */
  mimeType?: CompressMimeType;
  /** Worker で処理する。既定 true（不可なら自動でメインスレッドに落ちる） */
  useWorker?: boolean;
  signal?: AbortSignal;
  onProgress?: (progress: CompressProgress) => void;
}

export interface CompressProgress {
  phase: "decode" | "resize" | "encode";
  /** 何回目のエンコードか（1 始まり） */
  pass: number;
}

export type ImageRenderer = "offscreen-worker" | "offscreen-main" | "canvas";

export interface CompressedImage {
  blob: Blob;
  width: number;
  height: number;
  bytes: number;
  /** 最終的に採用した品質 */
  quality: number;
  /** 実際のエンコード回数 */
  passes: number;
  original: { bytes: number; width: number; height: number; type: string };
  /** 検出した EXIF Orientation (1..8)。不明なら 1 */
  orientation: number;
  /**
   * EXIF DateTimeOriginal（epoch ms）。
   * canvas で再エンコードすると EXIF は落ちるため、撮影時刻の証跡として
   * 構造化データ側へ持ち上げてサーバへ送る。
   */
  capturedAt?: number;
  renderer: ImageRenderer;
  durationMs: number;
}

/**
 * 実行環境が持つ画像処理機能。
 * Zebra 端末の WebView バージョンが確定していないため、実機で採取してログに残す。
 */
export interface ImageCapabilities {
  createImageBitmap: boolean;
  /** createImageBitmap(blob, { imageOrientation: 'from-image' }) が使えるか（Chrome 79+） */
  imageOrientationFromImage: boolean;
  offscreenCanvas: boolean;
  /** OffscreenCanvas.convertToBlob が使えるか */
  convertToBlob: boolean;
  htmlCanvas: boolean;
  worker: boolean;
  webp: boolean;
  /** 上記から決まる、実際に使われるレンダラ */
  renderer: ImageRenderer | "unavailable";
}

export const DEFAULT_COMPRESS_OPTIONS: Required<
  Pick<CompressImageOptions, "maxEdge" | "quality" | "maxPasses" | "mimeType" | "useWorker">
> & {
  targetBytes: { min: number; max: number };
  qualityRange: { min: number; max: number };
} = {
  maxEdge: 1440,
  quality: 0.75,
  targetBytes: { min: 200_000, max: 400_000 },
  qualityRange: { min: 0.45, max: 0.85 },
  maxPasses: 4,
  mimeType: "image/jpeg",
  useWorker: true,
};
