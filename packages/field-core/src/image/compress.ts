import { FieldCoreError } from "../shared/errors.js";
import { createRenderSurface, type RenderSurface } from "./canvas.js";
import { decodeImage, type DecodedImage } from "./decode.js";
import { readExif } from "./exif.js";
import {
  orientationTransform,
  orientedSize,
  scaledSize,
  scaleToFit,
  swapsAxes,
} from "./orientation.js";
import { searchQuality } from "./quality-search.js";
import {
  DEFAULT_COMPRESS_OPTIONS,
  type CompressedImage,
  type CompressImageOptions,
  type ImageRenderer,
} from "./types.js";

/** 品質を下げきってもまだ大きいときに、長辺へ掛ける倍率 */
const SHRINK_FACTOR = 0.85;

function elapsed(): () => number {
  const hasPerf = typeof performance !== "undefined" && typeof performance.now === "function";
  const start = hasPerf ? performance.now() : Date.now();
  return () => Math.round((hasPerf ? performance.now() : Date.now()) - start);
}

/**
 * 写真を圧縮する。
 *
 * 流れ:
 *   EXIF を読む → デコード → 長辺を maxEdge に収める → 向きを焼き込んで1回描く
 *   → 目標バイト数に入る品質を二分探索 → 入らなければ寸法を落として一度だけ再挑戦
 *
 * 失敗にはしない方針を通してある。目標に収まらなくても、収まらなかった結果を返す。
 * 現場では「420KB になったので送りません」より「420KB で送る」ほうが正しい。
 */
export async function compressImage(
  input: Blob,
  options?: CompressImageOptions,
): Promise<CompressedImage> {
  const stopwatch = elapsed();
  const o = resolveOptions(options);
  o.signal?.throwIfAborted();

  if (!(input instanceof Blob)) {
    throw new FieldCoreError("invalid_argument", "compressImage には Blob を渡してください");
  }
  if (input.size === 0) {
    throw new FieldCoreError("invalid_argument", "空のファイルは圧縮できません");
  }
  if (input.type && !input.type.startsWith("image/")) {
    throw new FieldCoreError(
      "invalid_argument",
      `画像ではありません（${input.type}）。圧縮を飛ばす場合は compress: false を指定してください`,
    );
  }

  const exif = await readExif(input);
  o.signal?.throwIfAborted();

  o.onProgress?.({ phase: "decode", pass: 0 });
  const decoded = await decodeImage(input);

  try {
    o.signal?.throwIfAborted();

    // デコーダが向きを適用済みなら、こちらで回してはいけない（二重に回る）
    const orientation = exif.orientation;
    const applyOrientationHere = !decoded.orientationApplied && orientation !== 1;

    const oriented = decoded.orientationApplied
      ? { width: decoded.width, height: decoded.height }
      : orientedSize(orientation, decoded.width, decoded.height);

    const passthrough = (passes: number): CompressedImage => ({
      blob: input,
      width: oriented.width,
      height: oriented.height,
      bytes: input.size,
      quality: 1,
      passes,
      original: {
        bytes: input.size,
        width: oriented.width,
        height: oriented.height,
        type: input.type,
      },
      orientation,
      ...(exif.capturedAt !== undefined ? { capturedAt: exif.capturedAt } : {}),
      renderer: "passthrough",
      durationMs: stopwatch(),
    });

    // すでに十分小さく、向きの焼き込みも要らないなら再エンコードしない。
    // 触らないほうが画質が落ちない
    if (canPassThrough(input, o, oriented, orientation)) {
      return passthrough(0);
    }

    let maxEdge = o.maxEdge;
    let remainingPasses = o.maxPasses;
    let totalPasses = 0;
    let result: Awaited<ReturnType<typeof renderAndSearch>> | null = null;

    // 1回目で収まらず、かつ「品質を下げきってもまだ大きい」ときだけ寸法を落として再挑戦する
    for (let attempt = 0; attempt < 2; attempt++) {
      o.signal?.throwIfAborted();
      result = await renderAndSearch(decoded, {
        options: o,
        orientation,
        applyOrientationHere,
        maxEdge,
        maxPasses: remainingPasses,
      });

      totalPasses += result.search.passes;
      remainingPasses -= result.search.passes;

      if (result.search.reason !== "quality-floor") break;
      if (remainingPasses < 1) break;
      maxEdge = Math.round(maxEdge * SHRINK_FACTOR);
    }

    if (result === null) {
      throw new FieldCoreError("unsupported_environment", "画像の圧縮に失敗しました");
    }

    /**
     * 圧縮した結果のほうが大きくなったなら、元をそのまま送る。
     *
     * 長辺だけがわずかに超過している写真（1600px を 1440px にする等）でよく起きる。
     * 縮小の効果より再エンコードの劣化のほうが大きく、
     * 「画質を落としたのにファイルは太った」という最悪の取引になる。
     * 向きを焼き込む必要がある場合は対象外（回っていない写真を送るわけにいかない）。
     */
    if (
      orientation === 1 &&
      input.type === o.mimeType &&
      input.size <= o.targetBytes.max &&
      result.search.blob.size >= input.size
    ) {
      return passthrough(totalPasses);
    }

    return {
      blob: result.search.blob,
      width: result.outputWidth,
      height: result.outputHeight,
      bytes: result.search.blob.size,
      quality: result.search.quality,
      passes: totalPasses,
      original: {
        bytes: input.size,
        width: oriented.width,
        height: oriented.height,
        type: input.type,
      },
      orientation,
      ...(exif.capturedAt !== undefined ? { capturedAt: exif.capturedAt } : {}),
      renderer: result.renderer,
      durationMs: stopwatch(),
    };
  } finally {
    decoded.release();
  }
}

/**
 * 複数枚を**直列で**圧縮する。
 * 弱い端末で並列に走らせると、デコード中のビットマップが同時に何枚もメモリに乗って
 * WebView ごと落ちることがあるため。
 */
export async function compressImages(
  inputs: Blob[],
  options?: CompressImageOptions,
): Promise<CompressedImage[]> {
  const out: CompressedImage[] = [];
  for (const input of inputs) {
    options?.signal?.throwIfAborted();
    out.push(await compressImage(input, options));
  }
  return out;
}

interface RenderParams {
  options: ResolvedOptions;
  orientation: number;
  applyOrientationHere: boolean;
  maxEdge: number;
  maxPasses: number;
}

async function renderAndSearch(decoded: DecodedImage, params: RenderParams) {
  const { options: o, orientation, applyOrientationHere, maxEdge, maxPasses } = params;

  const oriented = applyOrientationHere
    ? orientedSize(orientation, decoded.width, decoded.height)
    : { width: decoded.width, height: decoded.height };

  const scale = scaleToFit(oriented.width, oriented.height, maxEdge);

  // 描画サイズは「回転前」の寸法。キャンバスは回転後の寸法
  const draw = scaledSize(decoded.width, decoded.height, scale);
  const rotates = applyOrientationHere && swapsAxes(orientation);
  const outputWidth = rotates ? draw.height : draw.width;
  const outputHeight = rotates ? draw.width : draw.height;

  o.onProgress?.({ phase: "resize", pass: 0 });

  let surface: RenderSurface | null = null;
  try {
    surface = createRenderSurface(outputWidth, outputHeight);
    const transform = applyOrientationHere
      ? orientationTransform(orientation, draw.width, draw.height)
      : orientationTransform(1, draw.width, draw.height);

    surface.drawOriented(decoded.source, draw.width, draw.height, transform);

    const activeSurface = surface;
    const search = await searchQuality(
      (quality) => {
        o.onProgress?.({ phase: "encode", pass: 0 });
        return activeSurface.encode(o.mimeType, quality);
      },
      {
        initialQuality: o.quality,
        minQuality: o.qualityRange.min,
        maxQuality: o.qualityRange.max,
        targetBytes: o.targetBytes,
        maxPasses,
        ...(o.signal ? { signal: o.signal } : {}),
        onPass: (pass) => o.onProgress?.({ phase: "encode", pass }),
      },
    );

    return {
      search,
      outputWidth,
      outputHeight,
      renderer: surface.kind as ImageRenderer,
    };
  } finally {
    surface?.dispose();
  }
}

function canPassThrough(
  input: Blob,
  o: ResolvedOptions,
  oriented: { width: number; height: number },
  orientation: number,
): boolean {
  if (orientation !== 1) return false;
  if (input.type !== o.mimeType) return false;
  if (input.size > o.targetBytes.max) return false;
  return Math.max(oriented.width, oriented.height) <= o.maxEdge;
}

interface ResolvedOptions {
  maxEdge: number;
  quality: number;
  targetBytes: { min: number; max: number };
  qualityRange: { min: number; max: number };
  maxPasses: number;
  mimeType: string;
  signal?: AbortSignal;
  onProgress?: CompressImageOptions["onProgress"];
}

function resolveOptions(options?: CompressImageOptions): ResolvedOptions {
  const targetBytes =
    options?.targetBytes === false
      ? { min: 0, max: Number.POSITIVE_INFINITY }
      : (options?.targetBytes ?? DEFAULT_COMPRESS_OPTIONS.targetBytes);

  const qualityRange = options?.qualityRange ?? DEFAULT_COMPRESS_OPTIONS.qualityRange;

  const resolved: ResolvedOptions = {
    maxEdge: options?.maxEdge ?? DEFAULT_COMPRESS_OPTIONS.maxEdge,
    quality: options?.quality ?? DEFAULT_COMPRESS_OPTIONS.quality,
    targetBytes,
    qualityRange,
    // 目標を切ったなら再探索は要らない
    maxPasses: options?.targetBytes === false ? 1 : (options?.maxPasses ?? DEFAULT_COMPRESS_OPTIONS.maxPasses),
    mimeType: options?.mimeType ?? DEFAULT_COMPRESS_OPTIONS.mimeType,
  };

  if (resolved.maxEdge < 1) {
    throw new FieldCoreError("invalid_argument", `maxEdge が不正です: ${resolved.maxEdge}`);
  }
  if (resolved.maxPasses < 1) {
    throw new FieldCoreError("invalid_argument", `maxPasses が不正です: ${resolved.maxPasses}`);
  }
  if (qualityRange.min > qualityRange.max) {
    throw new FieldCoreError(
      "invalid_argument",
      `qualityRange が不正です: min=${qualityRange.min} > max=${qualityRange.max}`,
    );
  }

  if (options?.signal) resolved.signal = options.signal;
  if (options?.onProgress) resolved.onProgress = options.onProgress;
  return resolved;
}
