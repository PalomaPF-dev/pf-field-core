import { defineConfig, devices } from "@playwright/test";

/**
 * E2E は playground アプリに対して実行する。
 *
 * M0 では「ビルド済みの dist を実アプリと同じ経路で読み込めること」の確認まで。
 * オフライン再現・Service Worker・Background Sync のシナリオは M3 / M5 で足す。
 */
export default defineConfig({
  testDir: "./test/e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [["html", { open: "never" }], ["list"]] : "list",

  use: {
    baseURL: "http://127.0.0.1:5190",
    trace: "on-first-retry",
  },

  projects: [
    {
      // 端末は Zebra Android ハンディ。実機に近い視野で見ておく
      name: "android-handheld",
      use: {
        ...devices["Pixel 5"],
        // 実機は Chromium ベースの WebView
        browserName: "chromium",
        /**
         * 既定は Playwright が管理する Chromium を使う。
         * PLAYWRIGHT_CHROMIUM_EXECUTABLE を指定した場合はそれを使う
         * （ブラウザを別管理している開発コンテナ・社内ビルド環境向け）。
         */
        ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
          ? { launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } }
          : {}),
      },
    },
    {
      /**
       * iPhone（WebKit）。当面は Android と併用するため、こちらでも通す必要がある。
       *
       * Chromium との差は主に2点:
       *   - Background Sync が無い（送信はアプリを開いている間だけ）
       *   - ストレージの永続化が拒否されやすく、7日で消えることがある
       *
       * それらの分岐は capabilities で判定しているので、ここでは
       * **エンジンに依らず成り立つべき不変条件**だけを見る。
       */
      name: "ios-safari",
      use: {
        ...devices["iPhone 13"],
        browserName: "webkit",
      },
    },
  ],

  /**
   * dev サーバではなく本番ビルドに対して実行する。
   * 配られるのは本番ビルドなので、そこを検証しないと意味が薄い
   * （dev の HMR が繋がらない環境ではハイドレーションが止まり、テストが環境依存で落ちる）。
   */
  webServer: {
    command:
      "pnpm --filter @palomapf-dev/pf-field-playground build && pnpm --filter @palomapf-dev/pf-field-playground start",
    url: "http://127.0.0.1:5190",
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
