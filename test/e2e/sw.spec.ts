import { expect, test } from "@playwright/test";

/**
 * Service Worker と Background Sync のフォールバック。
 *
 * **エンジンごとに答えが違うのが正しい**ので、値を決め打ちにしない。
 *
 * さらに「API があること」と「登録できること」も別物である点に注意。
 * ヘッドレスの Chromium は Background Sync の API を持っていながら
 * `sync.register()` を拒否する。実機でも、登録上限や設定で拒否されうる。
 *
 * だから固定するのは**利用者に見える保証**だけにする:
 *   「背面送信を確保できなかったなら、前面が要ると答える」
 * ここが崩れると、送信されないのに「閉じても送られる」と表示する UI になる。
 */

test("Service Worker が登録され、有効になる", async ({ page }) => {
  await page.goto("/sw");
  await expect(page.getByTestId("sw-state")).toHaveText("有効", { timeout: 30_000 });
});

test("★ 背面送信を確保できなければ、前面が要ると答える", async ({ page }) => {
  await page.goto("/sw");
  await expect(page.getByTestId("sw-state")).toHaveText("有効", { timeout: 30_000 });
  await expect(page.getByTestId("sync-registered")).toBeVisible({ timeout: 30_000 });

  const supported = (await page.getByTestId("bgsync").textContent()) === "対応";
  const registered = (await page.getByTestId("sync-registered").textContent()) === "した";
  const requiresForeground =
    (await page.getByTestId("requires-foreground").textContent()) === "はい";

  // ★ これが本体。登録できなかったなら、必ず前面が要ると言う
  expect(requiresForeground).toBe(!registered);

  // API が無いなら登録できるはずがない（逆は成り立たない）
  if (!supported) expect(registered).toBe(false);

  // 前面が要るなら、その旨が画面に出ている（iOS の要件そのもの）
  if (requiresForeground) {
    await expect(page.getByTestId("foreground-notice")).toBeVisible();
  } else {
    await expect(page.getByTestId("foreground-notice")).toHaveCount(0);
  }
});
