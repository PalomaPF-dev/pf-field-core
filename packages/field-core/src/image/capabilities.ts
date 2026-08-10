import type { CanvasRenderer, ImageCapabilities } from "./types.js";

/** 1x1 の有効な PNG。機能検出用の最小入力。 */
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

function base64ToBlob(base64: string, type: string): Blob {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
}

function globalValue(name: string): unknown {
  return (globalThis as unknown as Record<string, unknown>)[name];
}

function pickRenderer(caps: Omit<ImageCapabilities, "renderer">): CanvasRenderer | "unavailable" {
  if (!caps.createImageBitmap && !caps.htmlCanvas) return "unavailable";
  // Worker へのオフロードは未実装（M1b）。`worker` は素の機能有無として残し、
  // ここでは実際に走る経路だけを返す — 診断画面に嘘を出さないため
  if (caps.offscreenCanvas && caps.convertToBlob) return "offscreen-main";
  if (caps.htmlCanvas) return "canvas";
  return "unavailable";
}

/**
 * 同期的にわかる範囲の機能検出。
 *
 * `imageOrientationFromImage` だけは実際に呼んでみないと分からないので、
 * ここでは常に false を返す。確定値が要るときは probeImageCapabilities() を使う。
 */
export function getImageCapabilities(): ImageCapabilities {
  const offscreenCtor = globalValue("OffscreenCanvas");
  const offscreenCanvas = typeof offscreenCtor === "function";
  const offscreenProto = offscreenCanvas
    ? (offscreenCtor as unknown as { prototype?: Record<string, unknown> }).prototype
    : undefined;
  const convertToBlob = typeof offscreenProto?.["convertToBlob"] === "function";

  const htmlCanvas =
    typeof document !== "undefined" && typeof document.createElement === "function";

  const base = {
    createImageBitmap: typeof globalValue("createImageBitmap") === "function",
    imageOrientationFromImage: false,
    offscreenCanvas,
    convertToBlob,
    htmlCanvas,
    worker: typeof globalValue("Worker") === "function",
    // 実際にエンコードできるかは probe で確かめる。ここは存在のみ
    webp: true,
  };

  return { ...base, renderer: pickRenderer(base) };
}

/**
 * 実際に呼び出して確かめる機能検出。実機（Zebra 端末）で1回だけ走らせてログに残す用途。
 *
 * `imageOrientation: 'from-image'` は WebIDL の enum なので、未対応のブラウザでは
 * TypeError になる。これを利用して確実に判定する（UA 判定はしない）。
 */
export async function probeImageCapabilities(): Promise<ImageCapabilities> {
  const caps = getImageCapabilities();

  if (caps.createImageBitmap) {
    try {
      const blob = base64ToBlob(TINY_PNG_BASE64, "image/png");
      const bitmap = await createImageBitmap(blob, { imageOrientation: "from-image" });
      bitmap.close?.();
      caps.imageOrientationFromImage = true;
    } catch {
      caps.imageOrientationFromImage = false;
    }
  }

  caps.webp = await canEncodeWebp(caps);
  return { ...caps, renderer: pickRenderer(caps) };
}

async function canEncodeWebp(caps: ImageCapabilities): Promise<boolean> {
  try {
    if (caps.offscreenCanvas && caps.convertToBlob) {
      const canvas = new OffscreenCanvas(1, 1);
      // コンテキストを取らずに convertToBlob を呼ぶと InvalidStateError になる。
      // ここを忘れると「Chrome なのに WebP 非対応」と誤判定する
      canvas.getContext("2d");
      const blob = await canvas.convertToBlob({ type: "image/webp" });
      // 未対応の形式を渡すと PNG にフォールバックするので、返ってきた型で判定する
      return blob.type === "image/webp";
    }
    if (caps.htmlCanvas) {
      const canvas = document.createElement("canvas");
      canvas.width = 1;
      canvas.height = 1;
      return canvas.toDataURL("image/webp").startsWith("data:image/webp");
    }
  } catch {
    return false;
  }
  return false;
}
