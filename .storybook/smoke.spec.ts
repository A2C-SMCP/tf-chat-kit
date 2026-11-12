import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
const index = JSON.parse(
  readFileSync(".artifacts/storybook/index.json", "utf8"),
) as { entries: Record<string, { id: string; type: string; name: string }> };
const stories = Object.values(index.entries).filter((v) => v.type === "story");
if (stories.length === 0) throw new Error("No Storybook stories were indexed");
for (const story of stories) {
  test(`renders ${story.id}`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(
      `/iframe.html?id=${encodeURIComponent(story.id)}&viewMode=story`,
    );
    await expect(page.locator("#storybook-root .showcase-frame")).toBeVisible();
    await expect(page.locator("[data-scene-loading]")).toHaveCount(0);
    await expect(page.locator("#storybook-root")).not.toContainText(
      "场景初始化失败",
    );
    await expect(page.locator(".sb-errordisplay")).toBeHidden();
    expect(errors).toEqual([]);
  });
}
test("ask-user answer and cancel use the real form", async ({ page }) => {
  const story = stories.find((v) => v.id.endsWith("--single"))!;
  await page.goto(
    `/iframe.html?id=${encodeURIComponent(story.id)}&viewMode=story`,
  );
  await page.getByRole("radio", { name: "Web", exact: true }).check();
  await page.getByRole("button", { name: /^提\s*交$/ }).click();
  await expect(page.getByLabel("交互结果")).toContainText('"action": "submit"');
  await page.getByRole("button", { name: "重置场景 / Reset" }).click();
  await page.getByRole("button", { name: /^取\s*消$/ }).click();
  await expect(page.getByLabel("交互结果")).toContainText('"action": "cancel"');
});
test("interaction sends option values and closes in Runtime", async ({
  page,
}) => {
  const story = stories.find((v) => v.id.endsWith("--single-choice"))!;
  await page.goto(
    `/iframe.html?id=${encodeURIComponent(story.id)}&viewMode=story`,
  );
  await page.getByRole("radio").first().check();
  await page.getByRole("button", { name: /提\s*交|Submit/ }).click();
  await expect(page.getByLabel("交互结果")).toContainText('"web"');
  await expect(page.getByLabel("交互结果")).toContainText('"status": "closed"');
});

test("Manager demo connects through public clients and opens history", async ({
  page,
}) => {
  const story = stories.find((v) => v.id.endsWith("managerchatapp--flow"))!;
  await page.goto(
    `/iframe.html?id=${encodeURIComponent(story.id)}&viewMode=story`,
  );
  await page.locator("input").first().fill("demo");
  await page.locator("input[type=password]").fill("demo");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.getByText("项目助理", { exact: true }).click();
  await page.getByRole("button", { name: "使用这个机器人" }).click();
  await page.getByText("组件展示", { exact: true }).click();
  await page.getByRole("button", { name: "开始对话", exact: true }).click();
  const composer = page.getByRole("textbox", { name: "消息", exact: true });
  await composer.fill("Storybook 首次发送验收");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(composer).toHaveValue("");
  await expect(
    page.getByText("操作未完成，请核对当前状态后重试。", { exact: true }),
  ).toBeHidden();
  await page.getByRole("button", { name: /历史对话/ }).click();
  await page.getByText("演示会话", { exact: true }).click();
  await expect(
    page.getByText("这是 ManagerChatApp 的受控演示会话。", { exact: true }),
  ).toBeVisible();
});
