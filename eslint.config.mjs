import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/.next/**",
      "**/coverage/**",
      "**/next-env.d.ts",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts", "**/*.tsx"],
    rules: {
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "separate-type-imports" },
      ],
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // 空の catch は「検出に失敗したら未対応とみなす」意図で使う箇所がある
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },
  {
    // Node で動くもの（CLI・ビルドスクリプト・設定ファイル）だけ Node のグローバルを許す
    files: [
      "packages/*/src/cli/**/*.ts",
      "packages/*/scripts/**/*.mjs",
      "scripts/**/*.mjs",
      "**/*.config.{mjs,mts,ts}",
    ],
    languageOptions: {
      globals: {
        process: "readonly",
        console: "readonly",
        __dirname: "readonly",
        // Node 18+ の Web 標準グローバル。実地検証スクリプトが使う
        fetch: "readonly",
        Request: "readonly",
      },
    },
  },
);
