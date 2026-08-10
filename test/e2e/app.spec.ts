import { expect, test, type Page } from "@playwright/test";

/**
 * M4 の完了条件を実ブラウザで確かめる。
 *
 * 「playground の UI で未送信件数・手動再送・進捗・画像表示が動く」に加えて、
 * **下書きが再読み込みを跨いで残ること**。
 * Zebra 端末は WebView をバックグラウンドで kill するので、
 * ここが崩れると「圏外で入力を続ける」が成立しない。
 */

async function open(page: Page): Promise<void> {
  await page.goto("/app");
  await expect(page.getByRole("heading", { name: "アプリ組み込みの見本" })).toBeVisible();
  // Provider の初期化が終わるまでボタンは押せない
  await expect(page.getByRole("button", { name: "写真1枚で送信予約" })).toBeEnabled({
    timeout: 20_000,
  });
}

test.describe("アプリ組み込み（React バインディング）", () => {
  test("Provider が組み上がり、通信状態と件数が出る", async ({ page }) => {
    await open(page);

    await expect(page.getByTestId("unsent")).toContainText("未送信 0 件");
    // navigator.onLine ではなく、実際に /api/health を叩いた結果
    await expect(page.getByTestId("network")).toHaveText("good", { timeout: 20_000 });
  });

  test("★ 下書きは再読み込みしても残る", async ({ page }) => {
    await open(page);

    await page.getByTestId("equipment").fill("EQ-1234");
    await page.getByTestId("note").fill("異音あり");
    // デバウンス後に保存される
    await expect(page.getByTestId("saved")).toBeVisible({ timeout: 20_000 });

    await page.reload();
    await expect(page.getByRole("heading", { name: "アプリ組み込みの見本" })).toBeVisible();

    // 端末を胸ポケットに入れて WebView が落ちても、ここが残っている必要がある
    await expect(page.getByTestId("equipment")).toHaveValue("EQ-1234", { timeout: 20_000 });
    await expect(page.getByTestId("note")).toHaveValue("異音あり");
  });

  test("予約 → 送信 → 送信済みの写真が表示される", async ({ page }) => {
    await open(page);

    await page.getByTestId("equipment").fill("EQ-1");
    await page.getByRole("button", { name: "写真1枚で送信予約" }).click();
    await expect(page.getByTestId("message")).toContainText("送信予約しました", {
      timeout: 30_000,
    });
    await expect(page.getByTestId("unsent")).toContainText("未送信 1 件");

    // 送信を頼んだ時点で下書きは役目を終える
    await expect(page.getByTestId("equipment")).toHaveValue("");

    await page.getByRole("button", { name: "いま送信する" }).click();
    await expect(page.getByTestId("message")).toContainText("送信 1 件 / 失敗 0 件", {
      timeout: 30_000,
    });
    await expect(page.getByTestId("unsent")).toContainText("未送信 0 件");

    // 進捗が最後まで進んでいる
    await expect(page.locator("tbody tr").first()).toContainText("1 / 1");

    /*
     * 非公開バケットなので、表示には署名付きURLの都度発行が要る。
     * ここが出るということは useSignedUrl → /api/files/sign-view →
     * 実際の画像取得まで通っている
     */
    await expect(page.getByTestId("thumbs").locator("img")).toBeVisible({ timeout: 30_000 });
  });
});
