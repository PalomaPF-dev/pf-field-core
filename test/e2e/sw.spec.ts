import { expect, test } from "@playwright/test";

/**
 * Service Worker と Background Sync のフォールバック。
 *
 * **エンジンごとに答えが違うのが正しい**ので、値を決め打ちにしない。
 * 見るのは不変条件:「Background Sync が無いなら、前面での送信が要ると答える」。
 * ここが崩れると、iOS で「閉じても送られる」と誤解させる UI になる。
 */

test("Service Worker が登録され、有効になる", async ({ page }) => {
  await page.goto("/sw");
  await expect(page.getByTestId("sw-state")).toHaveText("有効", { timeout: 30_000 });
});

test("★ Background Sync の可否と、前面が要るかが一致する", async ({ page }) => {
  await page.goto("/sw");
  await expect(page.getByTestId("sw-state")).toHaveText("有効", { timeout: 30_000 });
  await expect(page.getByTestId("sync-registered")).toBeVisible({ timeout: 30_000 });

  const supported = (await page.getByTestId("bgsync").textContent()) === "対応";
  const registered = (await page.getByTestId("sync-registered").textContent()) === "した";
  const requiresForeground =
    (await page.getByTestId("requires-foreground").textContent()) === "はい";

  // 対応していれば登録でき、前面は要らない。非対応なら逆
  expect(registered).toBe(supported);
  expect(requiresForeground).toBe(!supported);

  // 前面が要るなら、その旨が画面に出ている（iOS の要件そのもの）
  if (requiresForeground) {
    await expect(page.getByTestId("foreground-notice")).toBeVisible();
  }
});
