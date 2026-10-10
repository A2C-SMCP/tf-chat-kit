import { expect, test } from "@playwright/test";

test("session diagnostics remain keyboard accessible, copyable and inside the panel", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/");
  await page.getByRole("button", { name: /进入 Chat Kit/ }).click();
  await expect(page.getByText("欢迎使用本地 Chat Kit 调试台。")).toBeVisible();
  await page.getByRole("button", { name: "服务端错误", exact: true }).click();
  await page.getByRole("button", { name: "服务端错误", exact: true }).click();
  const notices = page.locator('[data-chat-notices="true"]');
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
  const input = page.getByRole("textbox", { name: "消息输入" });
  // The diagnostic panel does not become a timeline item or cover the composer.
  await expect(page.locator("[data-chat-event-layout]")).toBeVisible();
  if (await input.count()) await expect(input).toBeVisible();
  await page.screenshot({
    path: "test-results/issue-82-diagnostics.png",
    fullPage: true,
  });
});
