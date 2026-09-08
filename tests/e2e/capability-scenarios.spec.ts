import { expect, test } from "@playwright/test";
import { demoReferenceText } from "../../playground/src/capability-scenarios.js";

const detailSelector = 'aside[aria-label="事件详情"]';
test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("欢迎使用本地 Chat Kit 调试台。")).toBeVisible();
});

test("five tool views, real download and event navigation", async ({
  page,
}, testInfo) => {
  await page.getByRole("button", { name: "工具呈现", exact: true }).click();
  await page
    .getByRole("button", { name: "打开事件详情: Browser 示例", exact: true })
    .click();
  const detail = page.locator(detailSelector);
  await expect(detail).toContainText("本地网页摘要");
  await expect(detail.locator("img")).toBeVisible();
  await expect
    .poll(() =>
      detail
        .locator("img")
        .evaluate((image: HTMLImageElement) => image.naturalWidth),
    )
    .toBeGreaterThan(0);
  await page.screenshot({
    path: testInfo.outputPath("tools-desktop.png"),
    fullPage: true,
    animations: "disabled",
  });
  await page.getByRole("button", { name: "Next event", exact: true }).click();
  await expect(detail.locator("code")).toContainText("Hello Chat Kit");
  await page.getByRole("button", { name: "Next event", exact: true }).click();
  await expect(detail.getByLabel("Read-only diff")).toBeVisible();
  await expect(detail).toContainText("follow-latest");
  await page.getByRole("button", { name: "Next event", exact: true }).click();
  await expect(detail).toContainText("资源与引用测试通过");
  await page.getByRole("button", { name: "Next event", exact: true }).click();
  const downloading = page.waitForEvent("download");
  await detail.getByRole("button", { name: "Download", exact: true }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toBe("chat-kit-report.txt");
  const stream = await download.createReadStream();
  if (stream === null) throw new Error("Missing downloaded bytes");
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  expect(Buffer.concat(chunks).toString()).toContain(
    "Chat Kit Playground report",
  );
});

test("local media really plays and expired image recovers", async ({
  page,
}, testInfo) => {
  await page.getByRole("button", { name: "媒体与资源", exact: true }).click();
  for (const kind of ["audio", "video"]) {
    const media = page.locator(kind);
    await expect(media).toBeVisible();
    await media.evaluate(async (element: HTMLMediaElement) => {
      element.muted = true;
      await element.play();
    });
    await expect
      .poll(() =>
        media.evaluate((element: HTMLMediaElement) => element.currentTime),
      )
      .toBeGreaterThan(0);
    await media.evaluate((element: HTMLMediaElement) => element.pause());
  }
  await page
    .getByRole("button", { name: "Retry resource", exact: true })
    .click();
  const recovered = page.getByRole("img", { name: "可重试图片", exact: true });
  await expect
    .poll(() =>
      recovered.evaluate((image: HTMLImageElement) => image.naturalWidth),
    )
    .toBeGreaterThan(0);
  await expect(
    page.getByText("Chat Kit 演示助手", { exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("media-desktop.png"),
    fullPage: true,
    animations: "disabled",
  });
});

test("Markdown copies the exact selected block and references send full content", async ({
  page,
  context,
}, testInfo) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page
    .getByRole("button", { name: "Markdown 与复制", exact: true })
    .click();
  await expect(page.getByRole("table")).toBeVisible();
  await page
    .getByRole("button", { name: "Copy code", exact: true })
    .nth(1)
    .click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe('{"second": "只复制第二段"}');
  await page.getByRole("button", { name: "文档引用", exact: true }).click();
  await page.getByRole("button", { name: "References", exact: true }).click();
  await page
    .getByRole("button", { name: "Load references", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Chat Kit 接入指南", exact: true })
    .click();
  await expect(
    page.getByRole("textbox", { name: "消息", exact: true }),
  ).toHaveValue(/Chat Kit 接入指南/);
  await page.getByRole("button", { name: /^发\s*送$/ }).click();
  await expect(page.getByRole("log", { name: "会话时间线" })).toContainText(
    demoReferenceText.split("\n")[0]!,
  );
  await expect(page.getByRole("log", { name: "会话时间线" })).toContainText(
    demoReferenceText.split("\n")[1]!,
  );
  await page.screenshot({
    path: testInfo.outputPath("references-desktop.png"),
    fullPage: true,
    animations: "disabled",
  });
});

test("long result expansion, following and mobile detail", async ({
  page,
}, testInfo) => {
  await page
    .getByRole("button", { name: "长结果与事件导航", exact: true })
    .click();
  await page
    .getByRole("button", { name: "打开事件详情: 检查演示", exact: true })
    .click();
  const detail = page.locator(detailSelector);
  await expect(detail.getByRole("tab")).toHaveCount(2);
  await expect(detail).toContainText("检查完成");
  await detail.getByRole("button", { name: /Show more/ }).click();
  await expect(detail).toContainText('"index": 179');
  await page
    .getByRole("button", { name: "Follow latest", exact: true })
    .click();
  await page.getByRole("button", { name: "追加事件", exact: true }).click();
  await expect(
    page.getByRole("navigation", { name: "Event navigation" }),
  ).toContainText("2 / 2");
  await page
    .getByRole("button", { name: "Previous event", exact: true })
    .click();
  await page.getByRole("button", { name: "追加事件", exact: true }).click();
  await expect(
    page.getByRole("navigation", { name: "Event navigation" }),
  ).toContainText("1 / 3");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("dialog", { name: "事件详情" })).toBeVisible();
  await expect(page.getByRole("dialog", { name: "事件详情" })).not.toHaveClass(
    /ant-zoom/,
  );
  await page.screenshot({
    path: testInfo.outputPath("inspection-mobile.png"),
    fullPage: false,
    animations: "disabled",
  });
  await page.keyboard.press("Escape");
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await page.getByRole("button", { name: "重建实例", exact: true }).click();
  await expect(page.getByText("欢迎使用本地 Chat Kit 调试台。")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "追加事件", exact: true }),
  ).toHaveCount(0);
});
