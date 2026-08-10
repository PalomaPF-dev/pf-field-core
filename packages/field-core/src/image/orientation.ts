/**
 * EXIF Orientation (1..8) を canvas の変換行列に落とす。
 *
 * 変換行列は setTransform(a, b, c, d, e, f) にそのまま渡せる並び。
 * 点 (x, y) は (a*x + c*y + e, b*x + d*y + f) へ写る。
 *
 * 5〜8 は 90 度回転を含むので、出力キャンバスの幅と高さが入れ替わる。
 * ここを取り違えると「縦向きの写真が横に潰れる」という、
 * 現場で一番よく報告される壊れ方になる。
 */

export interface OrientationTransform {
  /** setTransform に渡す 6 要素 */
  matrix: [number, number, number, number, number, number];
  /** 幅と高さが入れ替わるか */
  swapsAxes: boolean;
}

/**
 * @param orientation EXIF Orientation (1..8)。範囲外は 1 として扱う
 * @param width  描画する画像の幅（回転前・スケール適用後）
 * @param height 描画する画像の高さ（回転前・スケール適用後）
 */
export function orientationTransform(
  orientation: number,
  width: number,
  height: number,
): OrientationTransform {
  switch (orientation) {
    case 2: // 左右反転
      return { matrix: [-1, 0, 0, 1, width, 0], swapsAxes: false };
    case 3: // 180度回転
      return { matrix: [-1, 0, 0, -1, width, height], swapsAxes: false };
    case 4: // 上下反転
      return { matrix: [1, 0, 0, -1, 0, height], swapsAxes: false };
    case 5: // 転置（左右反転 + 反時計90度）
      return { matrix: [0, 1, 1, 0, 0, 0], swapsAxes: true };
    case 6: // 時計回り90度
      return { matrix: [0, 1, -1, 0, height, 0], swapsAxes: true };
    case 7: // 転置（左右反転 + 時計90度）
      return { matrix: [0, -1, -1, 0, height, width], swapsAxes: true };
    case 8: // 反時計回り90度
      return { matrix: [0, -1, 1, 0, 0, width], swapsAxes: true };
    case 1:
    default:
      return { matrix: [1, 0, 0, 1, 0, 0], swapsAxes: false };
  }
}

/** その向きが幅と高さを入れ替えるか。 */
export function swapsAxes(orientation: number): boolean {
  return orientation >= 5 && orientation <= 8;
}

/** 回転を適用したあとの寸法。 */
export function orientedSize(
  orientation: number,
  width: number,
  height: number,
): { width: number; height: number } {
  return swapsAxes(orientation) ? { width: height, height: width } : { width, height };
}

/**
 * 長辺を maxEdge に収めるための倍率。拡大はしない（1 を超えない）。
 */
export function scaleToFit(width: number, height: number, maxEdge: number): number {
  const longest = Math.max(width, height);
  if (longest <= maxEdge || longest === 0) return 1;
  return maxEdge / longest;
}

/** 倍率を掛けたあとの寸法。0 にならないよう最低 1px を保つ。 */
export function scaledSize(
  width: number,
  height: number,
  scale: number,
): { width: number; height: number } {
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}
