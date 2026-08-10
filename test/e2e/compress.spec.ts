import { expect, test } from "@playwright/test";

/**
 * 実ブラウザの JPEG エンコーダに対して圧縮を検証する。
 *
 * 単体テストは canvas を差し替えているので「段取り」しか見ていない。
 * 実際に目標バイト数へ収まるか、向きが正しく焼き込まれるかは、
 * 本物のエンコーダを通さないと分からない。
 */

test.describe("圧縮（実ブラウザ）", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/bench");
    await expect(page.getByRole("heading", { name: "圧縮の実機計測" })).toBeVisible();
  });

  test("テスト画像6枚を目標レンジ内に収める", async ({ page }) => {
    await page.getByRole("button", { name: "テスト画像6枚で計測" }).click();

    // 4000x3000 の生成と圧縮が入るので余裕を持って待つ
    await expect(page.getByRole("heading", { name: "集計" })).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole("button", { name: "テスト画像6枚で計測" })).toBeEnabled({
      timeout: 60_000,
    });

    const rows = page.locator("tbody tr");
    // 集計表 5 行 + 明細 6 行
    await expect(page.locator("h2", { hasText: "明細" })).toBeVisible();

    // 上限超えが出ていないこと
    await expect(page.getByText("上限超え")).toHaveCount(0);

    // 向きが全件一致していること（不一致があるとバッジが出る）
    await expect(page.locator(".badge.ng")).toHaveCount(0);

    // 明細が6件
    const detailRows = rows.filter({ has: page.locator("img") });
    await expect(detailRows).toHaveCount(6);
  });

  test("向きを焼き込み、長辺を 1440px に収める", async ({ page }) => {
    await page.getByRole("button", { name: "テスト画像6枚で計測" }).click();
    await expect(page.getByRole("heading", { name: "明細" })).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole("button", { name: "テスト画像6枚で計測" })).toBeEnabled({
      timeout: 60_000,
    });

    const detailRows = page.locator("tbody tr").filter({ has: page.locator("img") });

    // 1件目: 4000x3000 / 向き1 → 1440x1080
    await expect(detailRows.nth(0)).toContainText("1440×1080");

    // 2件目: 4000x3000 / 向き6（時計回り90度）→ 縦横が入れ替わって 1080x1440
    await expect(detailRows.nth(1)).toContainText("1080×1440");

    // 3件目: 3000x4000 / 向き8（反時計回り90度）→ 1440x1080
    await expect(detailRows.nth(2)).toContainText("1440×1080");

    // 6件目: 800x600 は拡大しない
    await expect(detailRows.nth(5)).toContainText("800×600");
  });

  test("すでに小さい写真は再エンコードしない", async ({ page }) => {
    await page.getByRole("button", { name: "テスト画像6枚で計測" }).click();
    await expect(page.getByRole("heading", { name: "明細" })).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole("button", { name: "テスト画像6枚で計測" })).toBeEnabled({
      timeout: 60_000,
    });

    const rows = page.locator("tbody tr").filter({ has: page.locator("img") });

    /*
     * 「再エンコードしていない」ことを、経路名ではなく**結果**で見る。
     * 経路名（passthrough / offscreen-main）はエンジンで変わりうるが、
     * 「元とサイズが1バイトも変わらない」なら触っていないと言い切れる。
     */
    async function assertUntouched(index: number, expectedSize: string) {
      const cells = rows.nth(index).locator("td");
      const before = (await cells.nth(2).innerText()).trim();
      const after = (await cells.nth(3).innerText()).trim();
      expect(after).toBe(before);
      await expect(rows.nth(index)).toContainText(expectedSize);
    }

    // 800x600 は長辺も収まりサイズも小さいので触らない
    await assertUntouched(5, "800×600");

    /*
     * 1600x1200（195KB）は長辺だけがわずかに超過している。
     * 1440px へ縮めて再エンコードすると 311KB に「太る」ため、元のまま送る。
     * 実測で見つかった劣化なので、実ブラウザのエンコーダで見張る
     */
    await assertUntouched(4, "1600×1200");
  });

  test("圧縮後のほうが大きくなる写真が1枚も無い", async ({ page }) => {
    await page.getByRole("button", { name: "テスト画像6枚で計測" }).click();
    await expect(page.getByRole("heading", { name: "明細" })).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole("button", { name: "テスト画像6枚で計測" })).toBeEnabled({
      timeout: 60_000,
    });

    const rows = page.locator("tbody tr").filter({ has: page.locator("img") });
    const count = await rows.count();

    for (let i = 0; i < count; i++) {
      const cells = rows.nth(i).locator("td");
      const before = Number((await cells.nth(2).innerText()).replace(/[^\d]/g, ""));
      const after = Number((await cells.nth(3).innerText()).replace(/[^\d]/g, ""));
      expect(after, `${i} 行目: 圧縮後のほうが大きい`).toBeLessThanOrEqual(before);
    }
  });
});
