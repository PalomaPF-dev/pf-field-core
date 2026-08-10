import { expect, test } from "@playwright/test";

/**
 * M0 の確認: ビルド済みの dist が、実アプリと同じ経路（exports マップ）で
 * サーバコンポーネントからもクライアントコンポーネントからも読めること。
 *
 * ここが通らないと、4アプリに配ってから初めて壊れているのが分かる。
 */

test("トップ: サーバコンポーネントから読んだ値が描画される", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "pf-field-core playground" })).toBeVisible();

  // バックオフの表が出ている = backoffSchedule() が動いている
  await expect(page.getByRole("row", { name: /1 回目/ })).toBeVisible();

  // エラー分類の表が出ている
  const row401 = page.getByRole("row").filter({ hasText: "401" });
  await expect(row401).toContainText("blocked");

  const row503 = page.getByRole("row").filter({ hasText: "503" });
  await expect(row503).toContainText("自動で再試行");
});

test("実機診断: クライアントコンポーネントのフックが動く", async ({ page }) => {
  await page.goto("/diagnostics");

  await expect(page.getByRole("heading", { name: "実機診断" })).toBeVisible();

  // "use client" が効いていて useEffect の検出が走る。
  // 落ちていると capabilities が never 埋まらず「検出中…」のままになる
  await expect(page.getByText("採用されるレンダラ")).toBeVisible({ timeout: 15_000 });

  // Chromium なので from-image は対応しているはず
  const row = page.getByRole("row").filter({ hasText: "from-image" });
  await expect(row).toContainText("対応");
});

test("診断結果を JSON で採取できる", async ({ page }) => {
  await page.goto("/diagnostics");
  const json = page.locator("pre code");
  await expect(json).toBeVisible({ timeout: 15_000 });

  const parsed = JSON.parse((await json.textContent()) ?? "{}") as Record<string, unknown>;
  expect(parsed).toHaveProperty("version");
  expect(parsed).toHaveProperty("renderer");
  expect(parsed.createImageBitmap).toBe(true);

  // Chromium は WebP をエンコードできる。ここが false になるのは検出側のバグ。
  // 実際、コンテキストを取らずに convertToBlob を呼んで InvalidStateError になり、
  // 「Chrome なのに WebP 非対応」と誤判定していたことがある
  expect(parsed.webp).toBe(true);
  // Worker へのオフロードは未実装（M1b）なので、実際に走るのはメインスレッドの OffscreenCanvas
  expect(parsed.renderer).toBe("offscreen-main");
});
