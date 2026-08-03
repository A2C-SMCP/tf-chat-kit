import { defineConfig, devices } from "@playwright/test";

const playgroundPort = process.env["TF_CHAT_PLAYGROUND_PORT"] ?? "3000";
const playgroundOrigin = `http://localhost:${playgroundPort}`;

export default defineConfig({
  expect: { timeout: 10_000 },
  forbidOnly: Boolean(process.env["CI"]),
  fullyParallel: false,
  outputDir: "test-results",
  reporter: process.env["CI"] ? "github" : "list",
  retries: process.env["CI"] ? 1 : 0,
  testDir: "tests/e2e",
  use: {
    baseURL: playgroundOrigin,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    ...devices["Desktop Chrome"],
  },
  webServer: [
    {
      command: "node scripts/playground-e2e-robotserver.mjs",
      env: { TF_CHAT_PLAYGROUND_ORIGIN: playgroundOrigin },
      reuseExistingServer: false,
      timeout: 30_000,
      url: "http://localhost:4310/__test/ready",
    },
    {
      command: `pnpm exec vite --config playground/vite.config.ts --port ${playgroundPort} --strictPort`,
      env: {
        TF_CHAT_PLAYGROUND_ALLOWED_API_ORIGINS: "http://localhost:4310",
        TF_CHAT_PLAYGROUND_ALLOWED_SERVER_ORIGINS: "http://localhost:4310",
      },
      reuseExistingServer: false,
      timeout: 30_000,
      url: playgroundOrigin,
    },
  ],
  workers: 1,
});
