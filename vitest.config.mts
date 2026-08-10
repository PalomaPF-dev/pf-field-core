import { readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";

const pkg = JSON.parse(
  readFileSync(new URL("./packages/field-core/package.json", import.meta.url), "utf8"),
) as { version: string };

export default defineConfig({
  // ビルドと同じ値を差し込む。テストが見る VERSION と配られる VERSION を一致させるため
  define: { __PF_FIELD_CORE_VERSION__: JSON.stringify(pkg.version) },
  test: {
    include: ["packages/*/test/**/*.test.ts"],
    environment: "node",
    setupFiles: ["./test/setup/indexeddb.ts"],
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**/*.ts"],
      exclude: ["packages/*/src/**/index.ts", "packages/*/src/**/types.ts"],
      reporter: ["text", "lcov"],
    },
  },
});
