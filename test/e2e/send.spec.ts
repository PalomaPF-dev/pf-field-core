import { expect, test, type Page } from "@playwright/test";

/**
 * 送信ランナー（M3）の実ブラウザ検証。
 *
 * 単体テストは memory アダプタに対して走らせている。ここでは
 * **実際の fetch・XHR・IndexedDB・HTTP レスポンス**を通す。
 * M3 の完了条件そのもの:
 *   - 圏外 → 復帰 → 自動送信
 *   - 途中切断 → 残りの添付だけ再送
 *   - 二重送信されない
 *
 * サーバ側に何が着いたかは /api/inspect で数える。
 * 画面の表示だけを見ると、端末が成功と思い込んでいるだけの状態を見逃す。
 */

const ADD_ONE = "点検を1件追加（写真1枚）";
const ADD_THREE = "点検を1件追加（写真3枚）";
const SEND = "いま送信する";

async function open(page: Page): Promise<string> {
  await page.goto("/send");
  await expect(page.getByRole("heading", { name: "送信ランナー" })).toBeVisible();
  // セッションごとにサーバ状態を分けている。並列ワーカーでも混ざらない
  const sessionId = (await page.getByTestId("session-id").textContent())?.trim() ?? "";
  expect(sessionId).not.toBe("");
  return sessionId;
}

async function inspect(page: Page, sessionId: string) {
  return page.evaluate(async (id) => {
    const response = await fetch("/api/inspect", { headers: { "X-Test-Session": id } });
    return (await response.json()) as {
      objects: string[];
      uploadCounts: Record<string, number>;
      submitted: string[];
      submitAttempts: number;
    };
  }, sessionId);
}

/**
 * 送信ボタンを押し、**flush が終わるまで待つ**。
 *
 * 「未送信 N 件」を待つのでは足りない。その数字は投入直後から立っていて、
 * アップロードの最中でも同じ値を示すので、送信中のサーバを覗いてしまう。
 * 画面に出る結果（送信 x 件 / 失敗 y 件）は flush の戻り値なので、決着を表す。
 */
async function send(page: Page, expected: { sent: number; failed: number }) {
  await page.getByRole("button", { name: SEND }).click();
  await expect(page.getByTestId("message")).toContainText(
    `送信 ${expected.sent} 件 / 失敗 ${expected.failed} 件`,
    { timeout: 30_000 },
  );
}

async function setMode(page: Page, label: string, applied: string) {
  await page.getByRole("combobox").selectOption({ label });
  // 選択しただけでは駄目。サーバが受け付けた値が返ってくるまで待つ。
  // 待たずに送信すると、切り替わる前の応答を掴んで結果が揺れる
  await expect(page.getByTestId("server-mode")).toHaveText(applied, { timeout: 20_000 });
}

test.describe("送信ランナー（実 HTTP）", () => {
  test("署名 → アップロード → 本体送信 が通り、サーバに届く", async ({ page }) => {
    const sessionId = await open(page);

    await page.getByRole("button", { name: ADD_ONE }).click();
    await expect(page.getByTestId("message")).toContainText("送信予約しました", { timeout: 20_000 });

    await send(page, { sent: 1, failed: 0 });
    await expect(page.getByTestId("unsent")).toContainText("未送信 0 件");

    const server = await inspect(page, sessionId);
    expect(server.objects).toHaveLength(1);
    expect(server.submitted).toHaveLength(1);
    // ★ パスはサーバが組み立てる。ファイル名をそのまま使わない
    expect(server.objects[0]).toMatch(/^pf-playground\/playground\.inspection\//);
  });

  test("圏外なら待機に戻り、復帰後に送られる", async ({ page }) => {
    const sessionId = await open(page);

    await setMode(page, "アップロードが圏外", "upload-network");
    await page.getByRole("button", { name: ADD_ONE }).click();
    await expect(page.getByTestId("message")).toContainText("送信予約しました", { timeout: 20_000 });

    await send(page, { sent: 0, failed: 1 });
    // 未送信のまま残る = データは失われていない
    await expect(page.getByTestId("unsent")).toContainText("未送信 1 件");
    expect((await inspect(page, sessionId)).submitted).toHaveLength(0);

    // 圏内へ戻す
    await setMode(page, "正常", "ok");
    await send(page, { sent: 1, failed: 0 });
    await expect(page.getByTestId("unsent")).toContainText("未送信 0 件");

    const server = await inspect(page, sessionId);
    expect(server.objects).toHaveLength(1);
    expect(server.submitted).toHaveLength(1);
  });

  test("途中で切れたら、次回は残りの添付だけを送る", async ({ page }) => {
    const sessionId = await open(page);

    // 1枚目だけ通り、2枚目以降が落ちる
    await setMode(page, "2枚目以降だけ切断", "upload-partial");
    await page.getByRole("button", { name: ADD_THREE }).click();
    await expect(page.getByTestId("message")).toContainText("送信予約しました", { timeout: 30_000 });

    await send(page, { sent: 0, failed: 1 });

    const partial = await inspect(page, sessionId);
    expect(partial.objects).toHaveLength(1);
    expect(partial.uploadCounts["att-1"]).toBe(1);

    await setMode(page, "正常", "ok");
    await send(page, { sent: 1, failed: 0 });
    await expect(page.getByTestId("unsent")).toContainText("未送信 0 件");

    const server = await inspect(page, sessionId);
    expect(server.objects).toHaveLength(3);
    // ★ 1枚目は送り直していない。ここが弱電界での通信量に効く
    expect(server.uploadCounts["att-1"]).toBe(1);
    expect(server.submitted).toHaveLength(1);
  });

  test("応答が返らず再送されても、二重に登録されない", async ({ page }) => {
    const sessionId = await open(page);

    // 503 は「待てば直る」側。ジョブは残り、再送される
    await setMode(page, "本体送信が 503", "submit-503");
    await page.getByRole("button", { name: ADD_ONE }).click();
    await expect(page.getByTestId("message")).toContainText("送信予約しました", { timeout: 20_000 });

    await send(page, { sent: 0, failed: 1 });
    await expect(page.getByTestId("unsent")).toContainText("未送信 1 件");

    await setMode(page, "正常", "ok");
    await send(page, { sent: 1, failed: 0 });
    await expect(page.getByTestId("unsent")).toContainText("未送信 0 件");

    const server = await inspect(page, sessionId);
    // 本体は2回以上投げられているが、登録されたのは1件
    expect(server.submitAttempts).toBeGreaterThan(1);
    expect(server.submitted).toHaveLength(1);
  });

  test("★ ログイン画面へのリダイレクトを成功と誤認しない", async ({ page }) => {
    const sessionId = await open(page);

    await setMode(page, "本体送信がログイン画面へリダイレクト", "submit-redirect");
    await page.getByRole("button", { name: ADD_ONE }).click();
    await expect(page.getByTestId("message")).toContainText("送信予約しました", { timeout: 20_000 });

    await send(page, { sent: 0, failed: 1 });

    // 誤認していれば「未送信 0 件」になり、写真ごと消える。
    // 正しくは要対応として残る
    await expect(page.locator("tbody tr").first()).toContainText("要対応");
    await expect(page.getByTestId("unsent")).toContainText("未送信 1 件");

    // サーバには何も登録されていない
    expect((await inspect(page, sessionId)).submitted).toHaveLength(0);

    // 再ログイン後の救済で送り切れる
    await setMode(page, "正常", "ok");
    await page.getByRole("button", { name: "要対応も含めて再送" }).click();
    await send(page, { sent: 1, failed: 0 });
    await expect(page.getByTestId("unsent")).toContainText("未送信 0 件");
    expect((await inspect(page, sessionId)).submitted).toHaveLength(1);
  });

  test("401 でもジョブは捨てず、要対応として残す", async ({ page }) => {
    const sessionId = await open(page);

    await setMode(page, "本体送信が認証切れ(401)", "submit-401");
    await page.getByRole("button", { name: ADD_ONE }).click();
    await expect(page.getByTestId("message")).toContainText("送信予約しました", { timeout: 20_000 });

    await send(page, { sent: 0, failed: 1 });
    await expect(page.locator("tbody tr").first()).toContainText("要対応");
    await expect(page.getByTestId("unsent")).toContainText("未送信 1 件");

    // 写真はアップロード済みでも、本体が通っていないので登録はされていない
    expect((await inspect(page, sessionId)).submitted).toHaveLength(0);
  });
});
