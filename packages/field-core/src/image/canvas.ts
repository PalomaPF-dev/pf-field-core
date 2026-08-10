import { FieldCoreError } from "../shared/errors.js";
import type { ImageRenderer } from "./types.js";
import type { OrientationTransform } from "./orientation.js";

/**
 * OffscreenCanvas と HTMLCanvasElement の差を吸収する。
 *
 * 描画は1回で終わらせ、エンコードだけを品質を変えて複数回呼べる形にしてある。
 * 品質の二分探索で毎回描き直すと、弱い端末では時間が線形に増えるため。
 */
export interface RenderSurface {
  readonly kind: ImageRenderer;
  readonly width: number;
  readonly height: number;
  /** 向きの変換と拡縮を適用して1回だけ描く */
  drawOriented(source: CanvasImageSource, drawWidth: number, drawHeight: number, transform: OrientationTransform): void;
  encode(mimeType: string, quality: number): Promise<Blob>;
  dispose(): void;
}

type OffscreenCanvasCtor = new (width: number, height: number) => OffscreenCanvas;

function offscreenCanvasCtor(): OffscreenCanvasCtor | null {
  const ctor = (globalThis as unknown as Record<string, unknown>)["OffscreenCanvas"];
  return typeof ctor === "function" ? (ctor as OffscreenCanvasCtor) : null;
}

export function createRenderSurface(width: number, height: number): RenderSurface {
  const Offscreen = offscreenCanvasCtor();
  if (Offscreen) {
    const canvas = new Offscreen(width, height);
    const context = canvas.getContext("2d");
    if (context) return offscreenSurface(canvas, context as OffscreenCanvasRenderingContext2D);
  }

  if (typeof document !== "undefined" && typeof document.createElement === "function") {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (context) return htmlSurface(canvas, context);
  }

  throw new FieldCoreError(
    "unsupported_environment",
    "画像を描画できる canvas がありません（OffscreenCanvas も HTMLCanvasElement も使えません）",
  );
}

function applyDraw(
  context: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D,
  source: CanvasImageSource,
  drawWidth: number,
  drawHeight: number,
  transform: OrientationTransform,
): void {
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  const [a, b, c, d, e, f] = transform.matrix;
  context.setTransform(a, b, c, d, e, f);
  context.drawImage(source, 0, 0, drawWidth, drawHeight);
  context.setTransform(1, 0, 0, 1, 0, 0);
}

function offscreenSurface(
  canvas: OffscreenCanvas,
  context: OffscreenCanvasRenderingContext2D,
): RenderSurface {
  return {
    kind: "offscreen-main",
    width: canvas.width,
    height: canvas.height,
    drawOriented: (source, drawWidth, drawHeight, transform) =>
      applyDraw(context, source, drawWidth, drawHeight, transform),
    encode: (mimeType, quality) => canvas.convertToBlob({ type: mimeType, quality }),
    dispose: () => {
      // 参照を切って GC を助ける（弱い端末では効く）
      canvas.width = 0;
      canvas.height = 0;
    },
  };
}

function htmlSurface(canvas: HTMLCanvasElement, context: CanvasRenderingContext2D): RenderSurface {
  return {
    kind: "canvas",
    width: canvas.width,
    height: canvas.height,
    drawOriented: (source, drawWidth, drawHeight, transform) =>
      applyDraw(context, source, drawWidth, drawHeight, transform),
    encode: (mimeType, quality) =>
      new Promise<Blob>((resolve, reject) => {
        canvas.toBlob(
          (blob) => {
            if (blob) resolve(blob);
            else reject(new FieldCoreError("unsupported_environment", "canvas のエンコードに失敗しました"));
          },
          mimeType,
          quality,
        );
      }),
    dispose: () => {
      canvas.width = 0;
      canvas.height = 0;
    },
  };
}
