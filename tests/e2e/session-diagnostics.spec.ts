import { expect, test } from "@playwright/test";
import path from "node:path";

const entry = `/@fs/${path.resolve("tests/e2e/fixtures/session-diagnostics.ts")}`;
type Fixture = typeof import("./fixtures/session-diagnostics.js");

test.afterEach(async ({ page }) => {
  await page.evaluate(async (entry) => {
    await ((await import(/* @vite-ignore */ entry)) as Fixture).dispose();
  }, entry);
});

test("session diagnostics remain keyboard accessible, copyable and inside the panel", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/");
  await page.evaluate(async (entry) => {
    await ((await import(/* @vite-ignore */ entry)) as Fixture).mount();
  }, entry);
  const workspace = page.locator("#diagnostics-workspace");
  await expect(
    workspace.locator('textarea[aria-label="Message"]'),
  ).toBeVisible();
  await page.evaluate(async (entry) => {
    const fixture = (await import(/* @vite-ignore */ entry)) as Fixture;
    fixture.emitError();
    fixture.emitError();
  }, entry);
  const notices = workspace.locator('[data-chat-notices="true"]');
  await expect(notices.locator(".ant-alert")).toHaveCount(1);
  const diagnostics = notices.getByRole("button", { name: /Diagnostics/ });
  await diagnostics.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog
    .getByRole("button", { name: "Copy diagnostic", exact: true })
    .first()
    .click();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toContain('"traceId": "Not provided"');
  expect(copied).toContain('"localOperationId"');
  expect(copied).not.toContain("欢迎使用");
  await page.keyboard.press("Escape");
  await expect(diagnostics).toBeFocused();
  const input = workspace.getByRole("textbox", {
    name: "Message",
    exact: true,
  });
  // The diagnostic panel does not become a timeline item or cover the composer.
  await expect(workspace.locator("[data-chat-event-layout]")).toBeVisible();
  if (await input.count()) await expect(input).toBeVisible();
  await page.screenshot({
    path: "test-results/issue-82-diagnostics.png",
    fullPage: true,
  });
});
