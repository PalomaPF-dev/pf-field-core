import { describe, expect, it, vi } from "vitest";
import { searchQuality } from "../src/image/quality-search.js";

function blobOf(size: number): Blob {
  return new Blob([new Uint8Array(size)]);
}

/** 品質に対して単調増加するサイズを返す、実写に近い挙動のダミーエンコーダ */
function encoderOf(sizeAt: (quality: number) => number) {
  const calls: number[] = [];
  const encode = vi.fn(async (quality: number) => {
    calls.push(quality);
    return blobOf(Math.round(sizeAt(quality)));
  });
  return { encode, calls };
}

const TARGET = { min: 200_000, max: 400_000 };
const BASE = {
  initialQuality: 0.75,
  minQuality: 0.45,
  maxQuality: 0.85,
  targetBytes: TARGET,
  maxPasses: 4,
};

describe("searchQuality", () => {
  it("初回で目標に入ればそこで止める", async () => {
    const { encode } = encoderOf(() => 300_000);
    const result = await searchQuality(encode, BASE);

    expect(result.reason).toBe("within-target");
    expect(result.passes).toBe(1);
    expect(encode).toHaveBeenCalledOnce();
    expect(result.quality).toBe(0.75);
  });

  it("大きすぎるときは品質を下げて目標に入れる", async () => {
    // q=0.75 で 500KB、q=0.6 で 380KB 相当
    const { encode, calls } = encoderOf((q) => 50_000 + 600_000 * q);
    const result = await searchQuality(encode, BASE);

    expect(result.reason).toBe("within-target");
    expect(result.blob.size).toBeLessThanOrEqual(TARGET.max);
    expect(result.blob.size).toBeGreaterThanOrEqual(TARGET.min);
    expect(calls[0]).toBe(0.75);
    expect(calls[1]).toBeLessThan(0.75);
  });

  it("小さすぎるときは品質を上げる（不良箇所が潰れた写真を送らない）", async () => {
    const { encode, calls } = encoderOf((q) => 150_000 * q);
    const result = await searchQuality(encode, BASE);

    expect(calls[1]).toBeGreaterThan(0.75);
    // 上げきっても届かないので、上限で止まる
    expect(result.reason).toBe("quality-ceiling");
    expect(result.quality).toBeCloseTo(0.85, 2);
  });

  it("品質を下げきっても大きい場合は quality-floor を返す（寸法を落とす合図）", async () => {
    // どの品質でも 1MB を超える巨大な写真
    const { encode, calls } = encoderOf((q) => 1_000_000 + 400_000 * q);
    const result = await searchQuality(encode, BASE);

    expect(result.reason).toBe("quality-floor");
    // 中点へ漸近するのではなく、2手目で下限そのものを叩いて判定する
    expect(calls).toEqual([0.75, 0.45]);
    expect(result.passes).toBe(2);
    expect(result.quality).toBeCloseTo(0.45, 2);
    // それでも「収まらなかった結果」は返す。送らないよりは送るほうがよい
    expect(result.blob.size).toBe(1_180_000);
  });

  it("サイズが同じなら品質が高いほうを残す", async () => {
    // 品質を下げてもサイズが変わらない画像（単色など）では、下げる意味がない
    const { encode } = encoderOf(() => 1_200_000);
    const result = await searchQuality(encode, BASE);

    expect(result.reason).toBe("quality-floor");
    expect(result.quality).toBe(0.75);
  });

  it("maxPasses を超えてエンコードしない", async () => {
    const { encode } = encoderOf((q) => 50_000 + 600_000 * q);
    const result = await searchQuality(encode, { ...BASE, maxPasses: 2 });

    expect(encode.mock.calls.length).toBeLessThanOrEqual(2);
    expect(result.passes).toBeLessThanOrEqual(2);
  });

  it("収まらなかったときは「上限以下で最大」を選ぶ", async () => {
    // 目標レンジを極端に狭くして、絶対に入らないようにする
    const { encode } = encoderOf((q) => 50_000 + 600_000 * q);
    const result = await searchQuality(encode, {
      ...BASE,
      targetBytes: { min: 399_999, max: 400_000 },
      maxPasses: 3,
    });

    expect(result.reason).not.toBe("within-target");
    expect(result.blob.size).toBeLessThanOrEqual(400_000);
  });

  it("上限以下が一つも出なければ最小のものを選ぶ", async () => {
    const { encode } = encoderOf((q) => 800_000 + 100_000 * q);
    const result = await searchQuality(encode, { ...BASE, maxPasses: 3 });

    // 全部上限超え。少しでも軽いほうを選ぶ
    expect(result.blob.size).toBeLessThan(880_000);
  });

  it("maxPasses が 1 なら1回だけ呼ぶ", async () => {
    const { encode } = encoderOf(() => 900_000);
    const result = await searchQuality(encode, { ...BASE, maxPasses: 1 });

    expect(encode).toHaveBeenCalledOnce();
    expect(result.passes).toBe(1);
    expect(result.blob.size).toBe(900_000);
  });

  it("中止されたら例外を投げる", async () => {
    const controller = new AbortController();
    const { encode } = encoderOf(() => 900_000);
    controller.abort();

    await expect(
      searchQuality(encode, { ...BASE, signal: controller.signal }),
    ).rejects.toThrow();
    expect(encode).not.toHaveBeenCalled();
  });

  it("onPass で進捗が分かる", async () => {
    const passes: number[] = [];
    const { encode } = encoderOf((q) => 50_000 + 600_000 * q);
    await searchQuality(encode, { ...BASE, onPass: (p) => passes.push(p) });

    expect(passes[0]).toBe(1);
    expect(passes).toEqual([...passes].sort((a, b) => a - b));
  });
});
