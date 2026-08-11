import { expect, test } from "@playwright/test";

/**
 * 多タブ（実ブラウザ）。
 *
 * 排他そのものは単体テストで固めてある。ここで確かめたいのは
 * **タブ間の通知が実ブラウザで届くか**で、とくに iOS Safari。
 * BroadcastChannel が使えなければ、iPhone だけ「片方の画面が古いまま」になる。
 *
 * 現場の症状:
 *   点検の一覧タブと入力タブを開いたまま片方で送信すると、
 *   もう一方は未送信バッジを抱えたまま残る = 送れていないように見える。
 */

const ADD_ONE = "点検を1件追加（写真1枚）";

test("★ 片方のタブで送ると、もう片方の未送信バッジも消える", async ({ context }) => {
  const a = await context.newPage();
  await a.goto("/queue");

  // IndexedDB はテスト間で残るので、開く前に消す
  await a.evaluate(async () => {
    const names = await indexedDB.databases?.();
    for (const { name } of names ?? []) {
      if (name?.startsWith("pf-field-")) indexedDB.deleteDatabase(name);
    }
  });
  await a.reload();
  await expect(a.getByRole("heading", { name: "オフラインキュー" })).toBeVisible();

  // 2枚目のタブ。同じ IndexedDB を見る
  const b = await context.newPage();
  await b.goto("/queue");
  await expect(b.getByRole("heading", { name: "オフラインキュー" })).toBeVisible();
  await expect(b.locator(".card").first()).toContainText("未送信 0 件");

  // A で積む → B にも出る
  await a.getByRole("button", { name: ADD_ONE }).click();
  await expect(a.locator(".card").first()).toContainText("未送信 1 件", { timeout: 20_000 });
  await expect(b.locator(".card").first()).toContainText("未送信 1 件", { timeout: 20_000 });

  // A で送る → B の未送信も消える。
  // ここが本命。B は何も操作していないのに 0 にならなければならない
  await a.getByRole("button", { name: "いま送信する" }).click();
  await expect(a.locator(".card").first()).toContainText("未送信 0 件", { timeout: 20_000 });
  await expect(b.locator(".card").first()).toContainText("未送信 0 件", { timeout: 20_000 });

  await a.close();
  await b.close();
});
