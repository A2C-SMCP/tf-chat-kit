import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: ".",
  testMatch: "smoke.spec.ts",
  workers: 1,
  timeout: 30_000,
  outputDir: "../.artifacts/storybook-results",
  use: { baseURL: "http://127.0.0.1:6007", trace: "retain-on-failure" },
  webServer: {
    command:
      "pnpm exec vite preview --outDir .artifacts/storybook --host 127.0.0.1 --port 6007 --strictPort",
    cwd: process.cwd(),
    url: "http://127.0.0.1:6007",
    reuseExistingServer: false,
  },
});
