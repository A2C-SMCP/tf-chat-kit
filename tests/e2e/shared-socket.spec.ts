import { expect, test } from "@playwright/test";

test("共享连接页面完成聊天、工具调用、独立释放与断网恢复", async ({ page }) => {
  const sockets: string[] = [];
  page.on("websocket", (socket) => {
    if (socket.url().includes("/__shared-socket-demo/socket.io/"))
      sockets.push(socket.url());
  });
  await page.goto("/");
  await page.getByRole("button", { name: "进入共享连接验收 →" }).click();
  await page.getByRole("button", { name: "一键连接两个通道" }).click();
  await expect(page.getByText("已共用", { exact: true })).toBeVisible();
  await expect(page.getByTestId("shared-connection-count")).toHaveText("1");
  const engine = await page.getByTestId("shared-chat-engine").innerText();
  await expect(page.getByTestId("shared-tool-engine")).toHaveText(engine);
  expect(sockets).toHaveLength(1);
  await page.getByLabel("共享连接聊天消息").fill("验收共享连接");
  await page.getByRole("button", { name: "发送验收消息" }).click();
  await expect(page.getByLabel("演示聊天消息")).toContainText(
    "本地机器人收到：验收共享连接",
  );
  await page.getByLabel("宿主选区内容").fill("真实宿主 handler 的返回内容");
  await page.getByRole("button", { name: "让机器人调用宿主工具" }).click();
  await expect(page.locator(".shared-demo-result")).toContainText(
    "真实宿主 handler 的返回内容",
  );
  await page.getByRole("button", { name: "释放聊天", exact: true }).click();
  await expect(page.getByTestId("shared-chat-engine")).toHaveText("未连接");
  await expect(page.getByTestId("shared-connection-count")).toHaveText("1");
  await page.getByRole("button", { name: "让机器人调用宿主工具" }).click();
  await expect(page.getByText("宿主执行次数：")).toContainText("2");
  await page.getByRole("button", { name: "连接聊天", exact: true }).click();
  await expect(page.getByText("已共用", { exact: true })).toBeVisible();
  expect(sockets).toHaveLength(1);
  await page.getByRole("button", { name: "注销宿主工具" }).click();
  await page.getByLabel("共享连接聊天消息").fill("注销工具后仍能聊天");
  await page.getByRole("button", { name: "发送验收消息" }).click();
  await expect(page.getByLabel("演示聊天消息")).toContainText(
    "本地机器人收到：注销工具后仍能聊天",
  );
  await page.getByRole("button", { name: "注册宿主工具" }).click();
  await expect(page.getByText("已共用", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "模拟断网重连" }).click();
  await expect(page.getByText("已共用", { exact: true })).toBeVisible();
  await expect(page.getByTestId("shared-chat-engine")).not.toHaveText(engine);
  await page.getByRole("button", { name: "让机器人调用宿主工具" }).click();
  await expect(page.getByText("宿主执行次数：")).toContainText("3");
  await page.getByRole("button", { name: "注销宿主工具" }).click();
  await page.getByRole("button", { name: "释放聊天", exact: true }).click();
  await expect(page.getByTestId("shared-connection-count")).toHaveText("0");
  await page.getByRole("button", { name: "返回 Playground" }).click();
  await expect(
    page.getByRole("heading", { name: "选择调试模块" }),
  ).toBeVisible();
});

test("工具可先独立接入，窄屏可操作且两个验收实例互不干扰", async ({
  page,
  context,
}) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/");
  await page.getByRole("button", { name: "进入共享连接验收 →" }).click();
  await page.getByRole("button", { name: "注册宿主工具" }).click();
  await expect(page.getByTestId("shared-connection-count")).toHaveText("1");
  await expect(page.getByTestId("shared-chat-engine")).toHaveText("未连接");
  await page.getByRole("button", { name: "让机器人调用宿主工具" }).click();
  await expect(page.locator(".shared-demo-result")).toContainText(
    "这是宿主提供的选区内容。",
  );
  const second = await context.newPage();
  await second.goto("/");
  await second.getByRole("button", { name: "进入共享连接验收 →" }).click();
  await second.getByRole("button", { name: "一键连接两个通道" }).click();
  await expect(second.getByText("已共用", { exact: true })).toBeVisible();
  await expect(second.locator(".shared-demo-result")).toContainText("尚未调用");
  await page.getByRole("button", { name: "注销宿主工具" }).click();
  await expect(page.getByTestId("shared-connection-count")).toHaveText("0");
  await expect(second.getByTestId("shared-connection-count")).toHaveText("1");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.getByRole("button", { name: "注册宿主工具" }).click();
  await expect(page.getByTestId("shared-connection-count")).toHaveText("1");
  await page.getByRole("button", { name: "重置演示" }).click();
  await expect(page.getByTestId("shared-connection-count")).toHaveText("0");
  await second.getByRole("button", { name: "返回 Playground" }).click();
  await page.getByRole("button", { name: "返回 Playground" }).click();
});

test("重置请求失败仍关闭真实连接并清除旧的在线状态", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "进入共享连接验收 →" }).click();
  const opened = page.waitForEvent("websocket", (socket) =>
    socket.url().includes("/__shared-socket-demo/socket.io/"),
  );
  await page.getByRole("button", { name: "一键连接两个通道" }).click();
  await expect(page.getByText("已共用", { exact: true })).toBeVisible();
  const socket = await opened;
  const closed = socket.waitForEvent("close");
  await page.route(
    "**/__shared-socket-demo/session",
    (route) =>
      route.request().method() === "DELETE"
        ? route.fulfill({
            status: 503,
            contentType: "application/json",
            body: "{}",
          })
        : route.continue(),
    { times: 1 },
  );
  await page.getByRole("button", { name: "重置演示" }).click();
  await closed;
  await expect(page.getByTestId("shared-connection-count")).toHaveText("0");
  await expect(page.getByTestId("shared-chat-engine")).toHaveText("未连接");
  await expect(page.getByTestId("shared-tool-engine")).toHaveText("未连接");
  await expect(
    page.getByRole("button", { name: "注册宿主工具" }),
  ).toBeEnabled();
  await expect(
    page.getByText("操作未完成，请确认本地开发服务已启动，或重置演示后重试。"),
  ).toBeVisible();
  await page.getByRole("button", { name: "一键连接两个通道" }).click();
  await expect(page.getByText("已共用", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "返回 Playground" }).click();
});
