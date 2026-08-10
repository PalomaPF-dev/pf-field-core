import { describe, expect, it } from "vitest";
import {
  orientationTransform,
  orientedSize,
  scaledSize,
  scaleToFit,
  swapsAxes,
} from "../src/image/orientation.js";

const W = 100;
const H = 50;

/** setTransform と同じ規則で点を写す */
function apply(
  m: readonly [number, number, number, number, number, number],
  x: number,
  y: number,
): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

function cornerSet(points: [number, number][]): string[] {
  return points.map(([x, y]) => `${x},${y}`).sort();
}

describe("orientationTransform", () => {
  /**
   * 8通りすべてについて「画像の4隅がキャンバスの4隅にちょうど重なる」ことを確かめる。
   *
   * これが成り立てば、画像はキャンバスを過不足なく埋める。
   * ここが崩れると、現場で一番よく報告される「縦向きの写真が横に潰れる」
   * 「端が切れる」「余白が出る」が起きる。
   */
  it.each([1, 2, 3, 4, 5, 6, 7, 8])("向き %i で画像がキャンバスを過不足なく埋める", (orientation) => {
    const { matrix, swapsAxes: swaps } = orientationTransform(orientation, W, H);
    const outWidth = swaps ? H : W;
    const outHeight = swaps ? W : H;

    const mapped = [
      apply(matrix, 0, 0),
      apply(matrix, W, 0),
      apply(matrix, 0, H),
      apply(matrix, W, H),
    ];

    // 4隅がキャンバスの4隅に一致する（順序は問わない）
    expect(cornerSet(mapped)).toEqual(
      cornerSet([
        [0, 0],
        [outWidth, 0],
        [0, outHeight],
        [outWidth, outHeight],
      ]),
    );

    // はみ出しも余白も無い
    for (const [x, y] of mapped) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(outWidth);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(outHeight);
    }
  });

  it("向き 1 は恒等変換", () => {
    const { matrix, swapsAxes: swaps } = orientationTransform(1, W, H);
    expect(matrix).toEqual([1, 0, 0, 1, 0, 0]);
    expect(swaps).toBe(false);
  });

  it("向き 6（スマホ縦持ち）は時計回り90度になる", () => {
    // 一番よく来る値。左上が右上へ回るのが正しい
    const { matrix, swapsAxes: swaps } = orientationTransform(6, W, H);
    expect(swaps).toBe(true);
    expect(apply(matrix, 0, 0)).toEqual([H, 0]); // 左上 → 右上
    expect(apply(matrix, W, 0)).toEqual([H, W]); // 右上 → 右下
    expect(apply(matrix, 0, H)).toEqual([0, 0]); // 左下 → 左上
  });

  it("向き 8 は反時計回り90度になる", () => {
    const { matrix } = orientationTransform(8, W, H);
    expect(apply(matrix, 0, 0)).toEqual([0, W]); // 左上 → 左下
    expect(apply(matrix, W, 0)).toEqual([0, 0]); // 右上 → 左上
  });

  it("向き 3 は180度回転", () => {
    const { matrix } = orientationTransform(3, W, H);
    expect(apply(matrix, 0, 0)).toEqual([W, H]);
  });

  it("向き 2 は左右反転（回転しない）", () => {
    const { matrix, swapsAxes: swaps } = orientationTransform(2, W, H);
    expect(swaps).toBe(false);
    expect(apply(matrix, 0, 0)).toEqual([W, 0]);
    expect(apply(matrix, 0, H)).toEqual([W, H]);
  });

  it("範囲外の値は恒等変換として扱う（写真を落とさない）", () => {
    for (const bad of [0, 9, -1, Number.NaN]) {
      expect(orientationTransform(bad, W, H).matrix).toEqual([1, 0, 0, 1, 0, 0]);
    }
  });
});

describe("swapsAxes / orientedSize", () => {
  it("5〜8 だけ縦横が入れ替わる", () => {
    for (const o of [1, 2, 3, 4]) expect(swapsAxes(o)).toBe(false);
    for (const o of [5, 6, 7, 8]) expect(swapsAxes(o)).toBe(true);
  });

  it("orientedSize が入れ替えを反映する", () => {
    expect(orientedSize(1, 4000, 3000)).toEqual({ width: 4000, height: 3000 });
    expect(orientedSize(6, 4000, 3000)).toEqual({ width: 3000, height: 4000 });
  });
});

describe("scaleToFit", () => {
  it("長辺を maxEdge に合わせる", () => {
    expect(scaleToFit(4000, 3000, 1440)).toBeCloseTo(0.36, 5);
    expect(scaleToFit(3000, 4000, 1440)).toBeCloseTo(0.36, 5);
  });

  it("拡大はしない", () => {
    // 小さい写真を引き伸ばしても情報は増えず、ファイルだけ太る
    expect(scaleToFit(800, 600, 1440)).toBe(1);
    expect(scaleToFit(1440, 1000, 1440)).toBe(1);
  });

  it("寸法 0 でも壊れない", () => {
    expect(scaleToFit(0, 0, 1440)).toBe(1);
  });
});

describe("scaledSize", () => {
  it("四捨五入する", () => {
    expect(scaledSize(4000, 3000, 0.36)).toEqual({ width: 1440, height: 1080 });
  });

  it("0px にはしない", () => {
    // 幅 0 のキャンバスは作れないので、必ず 1px 以上を返す
    expect(scaledSize(10, 10, 0.0001)).toEqual({ width: 1, height: 1 });
  });
});
