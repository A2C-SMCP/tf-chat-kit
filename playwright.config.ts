import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  expect: { timeout: 10_000 },
  forbidOnly: Boolean(process.env["CI"]),
  fullyParallel: false,
  outputDir: "test-results",
  reporter: process.env["CI"] ? "github" : "list",
  retries: process.env["CI"] ? 1 : 0,
  testDir: "tests/e2e",
  use: {
    baseURL: "http://localhost:3000",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    ...devices["Desktop Chrome"],
  },
  webServer: [
    {
      command: "node scripts/playground-e2e-robotserver.mjs",
      reuseExistingServer: false,
      timeout: 30_000,
      url: "http://localhost:4310/__test/ready",
    },
    {
      command: "pnpm dev:playground",
      reuseExistingServer: false,
      timeout: 30_000,
      url: "http://localhost:3000",
    },
  ],
  workers: 1,
});
