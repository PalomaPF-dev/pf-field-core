import { FieldCoreError } from "../shared/errors.js";

export interface DecodedImage {
  source: CanvasImageSource;
  /** デコード結果の寸法 */
  width: number;
  height: number;
  /**
   * デコーダ側が既に EXIF の向きを適用済みか。
   * true なら呼び出し側で回転を掛けてはいけない（二重に回る）。
   */
  orientationApplied: boolean;
  release(): void;
}

/**
 * Blob を canvas へ描ける形にデコードする。
 *
 * 優先順:
 *   1. createImageBitmap(blob, { imageOrientation: 'from-image' })  … Chrome 79+
 *   2. createImageBitmap(blob, { imageOrientation: 'none' })        … 向きは自前で適用する
 *   3. <img> + createObjectURL                                      … 最終手段
 *
 * 1 が使えるかは実際に呼んでみないと分からない（WebIDL の enum なので
 * 未対応なら TypeError になる）。判定結果はモジュール内に覚えて、
 * 1枚ごとに例外を投げ直さないようにしている。
 */
let fromImageSupported: boolean | null = null;

/** テスト用に検出結果を捨てる。 */
export function resetDecodeCapabilityCache(): void {
  fromImageSupported = null;
}

export async function decodeImage(
  blob: Blob,
  options?: { preferDecoderOrientation?: boolean },
): Promise<DecodedImage> {
  const preferDecoder = options?.preferDecoderOrientation ?? true;

  if (typeof createImageBitmap === "function") {
    if (preferDecoder && fromImageSupported !== false) {
      try {
        const bitmap = await createImageBitmap(blob, { imageOrientation: "from-image" });
        fromImageSupported = true;
        return bitmapResult(bitmap, true);
      } catch (error) {
        // enum 未対応なら TypeError。それ以外（壊れた画像など）は握りつぶさない
        if (error instanceof TypeError) fromImageSupported = false;
        else throw toDecodeError(error);
      }
    }

    try {
      const bitmap = await createImageBitmap(blob, { imageOrientation: "none" });
      return bitmapResult(bitmap, false);
    } catch (error) {
      throw toDecodeError(error);
    }
  }

  return decodeViaImgElement(blob);
}

function bitmapResult(bitmap: ImageBitmap, orientationApplied: boolean): DecodedImage {
  return {
    source: bitmap,
    width: bitmap.width,
    height: bitmap.height,
    orientationApplied,
    release: () => bitmap.close?.(),
  };
}

function toDecodeError(error: unknown): FieldCoreError {
  return new FieldCoreError("invalid_argument", "画像をデコードできませんでした", { cause: error });
}

/**
 * createImageBitmap が無い環境向け。
 *
 * この経路に落ちるのは Chrome 50 未満相当で、EXIF の自動適用（Chrome 81+）も
 * 入っていない世代なので、向きは呼び出し側が適用する前提でよい。
 */
async function decodeViaImgElement(blob: Blob): Promise<DecodedImage> {
  if (typeof document === "undefined" || typeof URL.createObjectURL !== "function") {
    throw new FieldCoreError(
      "unsupported_environment",
      "画像をデコードする手段がありません（createImageBitmap も document もありません）",
    );
  }

  const url = URL.createObjectURL(blob);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () =>
        reject(new FieldCoreError("invalid_argument", "画像をデコードできませんでした"));
      el.src = url;
    });
    return {
      source: image,
      width: image.naturalWidth || image.width,
      height: image.naturalHeight || image.height,
      orientationApplied: false,
      release: () => URL.revokeObjectURL(url),
    };
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
}
