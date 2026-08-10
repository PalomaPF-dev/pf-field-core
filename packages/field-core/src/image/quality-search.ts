export interface QualitySearchOptions {
  initialQuality: number;
  /** 品質の下限・上限 */
  minQuality: number;
  maxQuality: number;
  targetBytes: { min: number; max: number };
  /** エンコードを呼んでよい回数 */
  maxPasses: number;
  signal?: AbortSignal;
  onPass?: (pass: number) => void;
}

export type QualitySearchReason =
  /** 目標レンジに収まった */
  | "within-target"
  /** 品質を下げきっても大きすぎる → 寸法を落とすしかない */
  | "quality-floor"
  /** 品質を上げきっても小さい（＝これ以上良くしようがない。失敗ではない） */
  | "quality-ceiling"
  /** 試行回数を使い切った */
  | "passes-exhausted"
  /** 品質の刻みが細かくなりすぎて意味のある差が出ない */
  | "converged";

export interface QualitySearchResult {
  blob: Blob;
  quality: number;
  passes: number;
  reason: QualitySearchReason;
}

/** これ以上細かく刻んでもファイルサイズがほとんど動かない幅 */
const QUALITY_EPSILON = 0.02;

/**
 * 目標バイト数に入る JPEG 品質を二分探索で探す。
 *
 * 「収まらなかった」場合でも必ず何かを返す。現場では
 * 「420KB になってしまったので写真を送りません」より
 * 「420KB で送る」ほうが正しいため。呼び出し側は reason を見て、
 * 寸法を落として再挑戦するかどうかを決める。
 */
export async function searchQuality(
  encode: (quality: number) => Promise<Blob>,
  options: QualitySearchOptions,
): Promise<QualitySearchResult> {
  const { targetBytes, minQuality, maxQuality, maxPasses } = options;

  let low = minQuality;
  let high = maxQuality;
  let quality = clamp(options.initialQuality, minQuality, maxQuality);

  /**
   * 2手目は中点ではなく**境界そのもの**を試す。
   *
   * いきなり二分に入ると境界へ漸近するだけで到達せず、
   * 「品質を下げきってもまだ大きい（＝寸法を落とすしかない）」という判断が付かない。
   * 先に境界を叩けば、その判断が2回のエンコードで確定する。
   */
  let boundaryProbed = false;

  let best: { blob: Blob; quality: number } | null = null;
  let passes = 0;
  let reason: QualitySearchReason = "passes-exhausted";

  while (passes < maxPasses) {
    options.signal?.throwIfAborted();

    const blob = await encode(quality);
    passes++;
    options.onPass?.(passes);

    if (blob.size >= targetBytes.min && blob.size <= targetBytes.max) {
      return { blob, quality, passes, reason: "within-target" };
    }

    best = pickBetter(best, { blob, quality }, targetBytes.max);

    let next: number;
    if (blob.size > targetBytes.max) {
      // 大きすぎる → 品質を下げる
      if (quality <= minQuality + QUALITY_EPSILON) {
        reason = "quality-floor";
        break;
      }
      high = quality;
      next = boundaryProbed ? (low + high) / 2 : minQuality;
    } else {
      // 小さすぎる → 品質を上げる（不良箇所が潰れた写真を送らないため）
      if (quality >= maxQuality - QUALITY_EPSILON) {
        reason = "quality-ceiling";
        break;
      }
      low = quality;
      next = boundaryProbed ? (low + high) / 2 : maxQuality;
    }
    boundaryProbed = true;

    next = clamp(next, minQuality, maxQuality);
    if (Math.abs(next - quality) < QUALITY_EPSILON) {
      reason = "converged";
      break;
    }
    quality = next;
  }

  // best は必ず1回以上のエンコードで埋まっている（maxPasses >= 1 の前提）
  if (best === null) {
    options.signal?.throwIfAborted();
    const blob = await encode(quality);
    passes++;
    best = { blob, quality };
  }

  return { blob: best.blob, quality: best.quality, passes, reason };
}

/**
 * 「上限以下で最大」を最良とする。上限以下が1つも無ければ「最小」を選ぶ。
 * 画質は大きいほうが良いが、上限超えは送信コストに直結するので優先度が違う。
 */
function pickBetter(
  current: { blob: Blob; quality: number } | null,
  candidate: { blob: Blob; quality: number },
  maxBytes: number,
): { blob: Blob; quality: number } {
  if (current === null) return candidate;

  const currentFits = current.blob.size <= maxBytes;
  const candidateFits = candidate.blob.size <= maxBytes;

  if (currentFits && candidateFits) {
    return candidate.blob.size > current.blob.size ? candidate : current;
  }
  if (candidateFits) return candidate;
  if (currentFits) return current;
  return candidate.blob.size < current.blob.size ? candidate : current;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
