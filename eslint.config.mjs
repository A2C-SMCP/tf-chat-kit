import eslint from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      ".artifacts/**",
      ".codex/**",
      "coverage/**",
      "dist/**",
      "experiments/**",
      "node_modules/**",
      "packages/*/dist/**",
      "playground/dist/**",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{js,mjs,ts,tsx}"],
    languageOptions: {
      globals: globals.node,
    },
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            "**/TFRobotFront/**",
            "next/**",
            "@tauri-apps/**",
            "@microsoft/office-js/**",
          ],
        },
      ],
    },
  },
  {
    files: ["playground/**/*.{ts,tsx}"],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
  },
  {
    files: ["tests/**/*.ts"],
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.vitest,
      },
    },
  },
);
