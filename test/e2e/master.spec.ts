import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

/**
 * マスタのローカルキャッシュ（M6）。
 *
 * 現場の要件を実ブラウザで確かめる:
 *   点検開始時（オンライン）に該当分だけ先読みし、圏外でも表示できること。
 *   先読みしていないものは「オンライン時に表示されます」と明示すること。
 *
 * ※ 圏外での**リロード**は Service Worker のアプリシェルが要る（M5）。
 *   playground では /sw でしか SW を登録していないので、ここでは扱わない。
 *   確かめるのは「画面を開いたまま電波が切れたとき」の挙動。
 */

/** 1x1 の PNG。中身が正しいことは自明にしておきたいので、実ファイルではなく直書きする */
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/**
 * 対照実験。IndexedDB とは無関係に、その場で作った blob: と data: を読ませてみる。
 *
 * 圏外エミュレーションが blob: の読み込みごと塞いでいる可能性があり、
 * それだと「保存が壊れている」のか「テスト環境の都合」なのか区別がつかない。
 * 判定には使わず、失敗したときの手掛かりとしてだけ使う。
 */
async function decodeProbe(page: Page) {
  return page.evaluate(async (base64) => {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const blobUrl = URL.createObjectURL(new Blob([bytes], { type: "image/png" }));
    const load = (src: string) =>
      new Promise<number>((resolve) => {
        const img = new Image();
        img.onload = () => resolve(img.naturalWidth);
        img.onerror = () => resolve(0);
        img.src = src;
      });
    try {
      return { blob: await load(blobUrl), data: await load(`data:image/png;base64,${base64}`) };
    } finally {
      URL.revokeObjectURL(blobUrl);
    }
  }, TINY_PNG_BASE64);
}

test("一覧系マスタが端末に入る", async ({ page }) => {
  await page.goto("/master");
  await expect(page.getByRole("heading", { name: "マスタのローカルキャッシュ" })).toBeVisible();

  // 起動時に取り直す（非同期なので購読して追従する）
  await expect(page.getByTestId("equipment-count")).toHaveText("3 件", { timeout: 30_000 });
});

test("★ 先読みしたものは圏外でも表示でき、していないものは明示する", async ({ page, context }) => {
  await page.goto("/master");
  await expect(page.getByTestId("equipment-count")).toHaveText("3 件", { timeout: 30_000 });

  // 点検開始 = その点検のぶんだけ先読み
  await page.getByRole("button", { name: "点検を開始（該当分を先読み）" }).click();
  await expect(page.getByTestId("prefetch-message")).toContainText("先読み 1 件", {
    timeout: 30_000,
  });
  await expect(page.getByTestId("state-sample")).toHaveText("cached", { timeout: 30_000 });

  // 電波が切れる
  await context.setOffline(true);

  // 先読み済み → 圏外でも出る
  await expect(page.getByTestId("state-sample")).toHaveText("cached", { timeout: 30_000 });

  /*
   * 「要素がある」だけでは足りない。**実際にデコードできたか**を先に見る。
   * 保存したバイト列が壊れていても img 要素そのものは存在するので、
   * toBeVisible より先にこちらを確かめたほうが、失敗したときに原因が分かる。
   */
  const decoded = await page.getByTestId("img-sample").evaluate((img) => {
    const el = img as HTMLImageElement;
    return { naturalWidth: el.naturalWidth, complete: el.complete, src: el.src.slice(0, 12) };
  });
  const bytes = Number(await page.getByTestId("bytes-sample").textContent());
  const type = (await page.getByTestId("type-sample").textContent())?.trim();

  const probe = await decodeProbe(page);

  // 保存の中身 → デコード、の順に切り分ける
  expect({ bytes, type, src: decoded.src, probe }).toMatchObject({ src: "blob:http://" });
  expect(bytes).toBeGreaterThan(0);
  expect(type).toBe("image/png");
  expect(
    decoded.naturalWidth,
    `対照実験（圏外で作り直した画像）: blob=${probe.blob} data=${probe.data}`,
  ).toBeGreaterThan(0);

  await expect(page.getByTestId("img-sample")).toBeVisible();

  // 先読みしていない → 「オンライン時に表示されます」
  // 「読み込み失敗」でも「画像がありません」でもない
  await expect(page.getByTestId("state-missing")).toHaveText("unavailable", { timeout: 30_000 });
  await expect(page.getByTestId("notice-missing")).toHaveText("オンライン時に表示されます");

  await context.setOffline(false);
});

test("圏外でも一覧系マスタは読める（点検を開始できる）", async ({ page, context }) => {
  await page.goto("/master");
  await expect(page.getByTestId("equipment-count")).toHaveText("3 件", { timeout: 30_000 });

  await context.setOffline(true);
  // 取り直しに失敗しても、既にあるものは消さない
  await expect(page.getByTestId("equipment-count")).toHaveText("3 件");

  await context.setOffline(false);
});
