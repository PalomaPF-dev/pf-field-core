import { expect, test } from "@playwright/test";

/**
 * オフラインキューの実ブラウザ検証。
 *
 * 単体テストは fake-indexeddb に対して走らせている。ここでは本物の IndexedDB と
 * 実際の Blob 保存に対して、現場に見える振る舞いを確かめる。
 */

const ADD_ONE = "点検を1件追加（写真1枚）";
const ADD_THREE = "点検を1件追加（写真3枚）";

test.describe("オフラインキュー（実ブラウザ）", () => {
  test.beforeEach(async ({ page }) => {
    // IndexedDB はテスト間で残るので、毎回消してから開く
    await page.goto("/queue");
    await page.evaluate(async () => {
      const names = await indexedDB.databases?.();
      for (const { name } of names ?? []) {
        if (name?.startsWith("pf-field-")) indexedDB.deleteDatabase(name);
      }
    });
    await page.reload();
    await expect(page.getByRole("heading", { name: "オフラインキュー" })).toBeVisible();
  });

  test("追加すると未送信件数が増え、送信すると 0 になる", async ({ page }) => {
    await page.getByRole("button", { name: ADD_ONE }).click();
    await expect(page.getByText("送信予約しました（写真 1 枚）")).toBeVisible({ timeout: 20_000 });
    await expect(page.locator(".card").first()).toContainText("未送信 1 件");

    await page.getByRole("button", { name: "いま送信する" }).click();
    await expect(page.locator(".card").first()).toContainText("未送信 0 件", { timeout: 20_000 });
    await expect(page.getByText("送信済み").first()).toBeVisible();
  });

  test("圏外なら待機に戻り、試行回数が増える", async ({ page }) => {
    await page.getByRole("combobox").selectOption("offline");
    await page.getByRole("button", { name: ADD_ONE }).click();
    await expect(page.getByText("送信予約しました")).toBeVisible({ timeout: 20_000 });

    await page.getByRole("button", { name: "いま送信する" }).click();

    const row = page.locator("tbody tr").last();
    await expect(row).toContainText("圏外です", { timeout: 20_000 });
    await expect(row).toContainText("待機中");
    // 未送信のまま残る = データは失われていない
    await expect(page.locator(".card").first()).toContainText("未送信 1 件");
  });

  test("認証切れは「要対応」になり、再送で待機へ戻せる", async ({ page }) => {
    await page.getByRole("combobox").selectOption("auth-error");
    await page.getByRole("button", { name: ADD_ONE }).click();
    await expect(page.getByText("送信予約しました")).toBeVisible({ timeout: 20_000 });

    await page.getByRole("button", { name: "いま送信する" }).click();

    const row = page.locator("tbody tr").last();
    await expect(row).toContainText("要対応", { timeout: 20_000 });

    // 再ログイン後の救済に相当する導線。
    // retryAll がするのは「待機へ戻す」ところまで。送信は別操作
    await page.getByRole("combobox").selectOption("success");
    await page.getByRole("button", { name: "要対応も含めて再送" }).click();
    await expect(row).toContainText("待機中", { timeout: 20_000 });
    await expect(page.locator(".card").first()).toContainText("未送信 1 件");

    await page.getByRole("button", { name: "いま送信する" }).click();
    await expect(page.locator(".card").first()).toContainText("未送信 0 件", { timeout: 20_000 });
  });

  test("滞留の上限に達したら保存を断り、既存データは消さない", async ({ page }) => {
    // この画面の上限は写真12枚。3枚 × 4回 で到達する
    await page.getByRole("combobox").selectOption("offline");
    for (let i = 0; i < 4; i++) {
      await page.getByRole("button", { name: ADD_THREE }).click();
      await expect(page.getByText(/送信予約しました|上限/)).toBeVisible({ timeout: 30_000 });
    }

    await page.getByRole("button", { name: ADD_THREE }).click();
    await expect(page.getByText(/上限/)).toBeVisible({ timeout: 30_000 });

    // 既に預かった分は消えない
    await expect(page.locator(".card").first()).toContainText("未送信 4 件");
  });

  test("破棄すると未送信から外れる", async ({ page }) => {
    await page.getByRole("combobox").selectOption("offline");
    await page.getByRole("button", { name: ADD_ONE }).click();
    await expect(page.getByText("送信予約しました")).toBeVisible({ timeout: 20_000 });

    await page.getByRole("button", { name: "破棄" }).first().click();
    await expect(page.locator(".card").first()).toContainText("未送信 0 件", { timeout: 20_000 });
  });

  test("再読み込みしても未送信データが残る", async ({ page }) => {
    // IndexedDB に本当に永続化されているか。ここが崩れると設計の前提が消える
    await page.getByRole("combobox").selectOption("offline");
    await page.getByRole("button", { name: ADD_ONE }).click();
    await expect(page.locator(".card").first()).toContainText("未送信 1 件", { timeout: 20_000 });

    await page.reload();
    await expect(page.locator(".card").first()).toContainText("未送信 1 件", { timeout: 20_000 });
  });
});
