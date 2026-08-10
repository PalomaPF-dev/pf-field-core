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

  // 対応・非対応のどちらでもよい。検出が完走していることを見る
  const row = page.getByRole("row").filter({ hasText: "from-image" });
  await expect(row).toContainText(/対応|非対応/);
});

test("診断結果を JSON で採取できる", async ({ page }) => {
  await page.goto("/diagnostics");

  // capabilities は同期的に出るが、画像の検出は effect の中で解決する。
  // 揃ってから読まないと採取が欠ける
  await expect(page.getByText("採用されるレンダラ")).toBeVisible({ timeout: 15_000 });

  const json = page.locator("pre code");
  await expect(json).toBeVisible({ timeout: 15_000 });

  const parsed = JSON.parse((await json.textContent()) ?? "{}") as Record<string, unknown>;
  expect(parsed).toHaveProperty("version");
  expect(parsed).toHaveProperty("renderer");
  expect(parsed.createImageBitmap).toBe(true);

  // 端末能力も同じ JSON に載る。UI の出し分けはこれらを見て決める
  expect(parsed).toHaveProperty("platform");
  expect(typeof parsed.backgroundSync).toBe("boolean");
  expect(parsed.requiresForegroundToSend).toBe(!parsed.backgroundSync);
  expect(Array.isArray(parsed.syncTriggers)).toBe(true);
  // Background Sync が無い環境でも送信のきっかけは残る
  expect((parsed.syncTriggers as string[]).length).toBeGreaterThan(0);

  /*
   * ここから先はエンジンごとに答えが変わる（Chromium と WebKit）。
   * 値そのものを断定せず、「検出が完走して、使える経路が1つ以上ある」ことを見る。
   * どの経路を通っても結果が正しいことは compress.spec.ts が保証する。
   */
  expect(["offscreen-main", "canvas"]).toContain(parsed.renderer);
  expect(typeof parsed.webp).toBe("boolean");
  expect(typeof parsed.imageOrientationFromImage).toBe("boolean");
});
