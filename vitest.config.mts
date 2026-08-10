import { defineConfig } from "vitest/config";

export default defineConfig({
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
