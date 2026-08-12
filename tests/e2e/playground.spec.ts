import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from "@playwright/test";
import { io as connectSocket } from "socket.io-client";

import { PLAYGROUND_EVENT_DETAIL_SPLIT_RATIO_STORAGE_KEY } from "../../playground/src/playground-layout-preferences.js";

const ROBOTSERVER = "http://localhost:4310";
const PLAYGROUND_ORIGIN = `http://localhost:${
  process.env["TF_CHAT_PLAYGROUND_PORT"] ?? "3000"
}`;
const ORIGIN_HEADERS = { Origin: PLAYGROUND_ORIGIN };

interface MockState {
  readonly conversations: readonly string[];
  readonly observations: {
    readonly activeSockets: number;
    readonly adminRequests: number;
    readonly bearerRequests: number;
    readonly contentTypeRequests: number;
    readonly corsPreflights: number;
    readonly interrupts: number;
    readonly invalidOrigins: number;
    readonly routedRequests: number;
    readonly joins: number;
    readonly passwordLogins: number;
    readonly rejectedRest: { readonly missing: number; readonly wrong: number };
    readonly rejectedSockets: {
      readonly missing: number;
      readonly wrong: number;
    };
    readonly socketConnections: number;
    readonly socketDisconnections: number;
  };
}

const stateOf = async (request: APIRequestContext): Promise<MockState> =>
  (await (
    await request.get(`${ROBOTSERVER}/__test/state`)
  ).json()) as MockState;

const fillConnection = async (
  page: Page,
  auth: "admin" | "bearer" | "password",
  credential: string,
) => {
  await page.getByRole("button", { name: "RobotServer 模式" }).click();
  await page.getByLabel("RobotServer 服务地址").fill(ROBOTSERVER);
  await page.getByLabel("Namespace").fill("e2e-ns");
  await page.getByLabel("Robot ID").fill("e2e-robot");
  await page.locator("summary", { hasText: "高级设置" }).click();
  await page.getByLabel("platformId").fill("platform-e2e");
  if (auth === "admin") {
    await page.getByText("Admin Token", { exact: true }).click();
  } else if (auth === "bearer") {
    await page.getByText("用户 Token", { exact: true }).click();
  }
  await page
    .locator(
      `input[aria-label="${
        auth === "bearer"
          ? "用户 Token"
          : auth === "admin"
            ? "Admin Token"
            : "管理员密码"
      }"]`,
    )
    .fill(credential);
  await page.getByRole("button", { name: "连接 RobotServer" }).click();
};

const socketRejection = async (auth: Record<string, string>) =>
  new Promise<number | undefined>((resolve, reject) => {
    const socket = connectSocket(`${ROBOTSERVER}/chat`, {
      auth,
      extraHeaders: ORIGIN_HEADERS,
      path: "/c/tfrobot/e2e-ns/e2e-robot/socket.io",
      reconnection: false,
      transports: ["websocket"],
    });
    let settled = false;
    const finish = (complete: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.disconnect();
      complete();
    };
    const timeout = setTimeout(
      () =>
        finish(() =>
          reject(new Error("Socket authentication did not settle in time")),
        ),
      2_000,
    );
    socket.once("connect", () => {
      finish(() =>
        reject(new Error("Invalid Socket credentials were accepted")),
      );
    });
    socket.once(
      "connect_error",
      (reason: Error & { data?: { status?: number } }) => {
        finish(() => resolve(reason.data?.status));
      },
    );
  });

const composerSendButton = (page: Page) =>
  page.getByLabel("消息").locator("..").getByRole("button");

test.beforeEach(async ({ request }) => {
  await request.post(`${ROBOTSERVER}/__test/reset`);
});

test("Mock mode renders and exercises the formal Runtime scenarios", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Chat Kit 调试台" }),
  ).toBeVisible();
  await expect(page.getByText("本地私有应用 · 内存网关")).toBeVisible();
  await expect(page.getByText("欢迎使用本地 Chat Kit 调试台。")).toBeVisible();
  const conversationList = page.locator('aside[aria-label="会话列表"]');
  await expect(conversationList).toBeHidden();
  const eventLayout = page.locator("[data-chat-event-layout]");
  const splitHandle = page.getByRole("separator", {
    name: "调整事件详情双栏宽度",
  });
  const mockEvent = page.locator(
    '[data-chat-event-trigger="playground-agent-event"]',
  );
  await expect(eventLayout).toHaveAttribute("data-chat-event-layout", "split");
  await expect(splitHandle).toHaveAttribute("aria-valuenow", "56");
  const layoutBox = await eventLayout.boundingBox();
  const handleBox = await splitHandle.boundingBox();
  if (layoutBox === null || handleBox === null) {
    throw new Error("Event detail split layout is not measurable");
  }
  await page.mouse.move(
    handleBox.x + handleBox.width / 2,
    handleBox.y + handleBox.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    layoutBox.x + layoutBox.width * 0.7,
    handleBox.y + handleBox.height / 2,
  );
  await page.mouse.up();
  await expect(splitHandle).toHaveAttribute("aria-valuenow", "70");
  expect(
    await page.evaluate(
      (storageKey) => globalThis.localStorage.getItem(storageKey),
      PLAYGROUND_EVENT_DETAIL_SPLIT_RATIO_STORAGE_KEY,
    ),
  ).toBe("0.7");
  await page.reload();
  await expect(splitHandle).toHaveAttribute("aria-valuenow", "70");
  await mockEvent.click();
  await expect(page.locator('aside[aria-label="事件详情"]')).toContainText(
    "执行计划已生成。",
  );
  await page.locator(".ant-segmented-item", { hasText: "弹窗" }).click();
  const eventDialog = page.getByRole("dialog", { name: "事件详情" });
  await expect(eventDialog).toContainText("执行计划已生成。");
  await page.keyboard.press("Escape");
  await expect(eventDialog).toBeHidden();
  await expect(mockEvent).toBeFocused();
  await page.locator(".ant-segmented-item", { hasText: "自动" }).click();
  await page.setViewportSize({ height: 900, width: 600 });
  await expect(eventLayout).toHaveAttribute("data-chat-event-layout", "modal");
  expect(
    await page
      .locator(".chat-stage")
      .evaluate((element) => element.scrollWidth <= element.clientWidth),
  ).toBe(true);
  await page.setViewportSize({ height: 900, width: 1280 });
  await expect(eventLayout).toHaveAttribute("data-chat-event-layout", "split");

  await page.getByRole("button", { name: "新建会话" }).click();
  const createConversationDialog = page.getByRole("dialog", {
    name: "新建会话",
  });
  await createConversationDialog
    .getByLabel("新会话标题")
    .fill("Browser conversation");
  await createConversationDialog
    .getByRole("button", { name: "确认新建" })
    .click();
  await expect(
    page
      .locator(".chat-stage > section > main > header")
      .getByText("Browser conversation"),
  ).toBeVisible();
  await page.getByLabel("消息").fill("Browser mock message");
  await composerSendButton(page).click();
  await expect(page.getByText("Browser mock message")).toBeVisible();
  await expect(
    page.getByText("流式输出完成，正式 Runtime 已应用每次更新。"),
  ).toBeVisible();

  await expect(page.getByRole("button", { name: "中断当前任务" })).toBeHidden();
  await page.getByRole("button", { name: "流式回复" }).click();
  await expect(page.getByText("正在思考…")).toBeVisible();
  const interruptButton = page.getByRole("button", {
    name: "中断当前任务",
  });
  await expect(interruptButton).toBeVisible();
  await expect(
    page.locator('[data-chat-composer=""]').getByRole("button", {
      name: "中断当前任务",
    }),
  ).toBeVisible();
  await interruptButton.click();
  await expect(page.getByText("当前任务已中断。")).toBeVisible();
  await expect(interruptButton).toBeHidden();
  await page.getByRole("button", { name: "服务端错误" }).click();
  await expect(
    page.getByText("Mock RobotServer 拒绝了当前场景。"),
  ).toBeVisible();

  await page.getByRole("button", { name: "历史会话" }).click();
  const conversationMenu = page.getByRole("menu");
  await expect(conversationMenu.getByRole("menuitem").first()).toContainText(
    "Browser conversation",
  );
  await conversationMenu.getByRole("menuitem", { name: "示例会话" }).click();
  await expect(conversationList).toBeHidden();
  await expect(page.getByText("欢迎使用本地 Chat Kit 调试台。")).toBeVisible();
  await page.getByRole("button", { name: "断开连接" }).click();
  await expect(page.locator(".playground-hero .ant-tag")).toHaveText("已断开");
  await page.getByRole("button", { name: "重新连接" }).click();
  await expect(page.locator(".playground-hero .ant-tag")).toHaveText("已连接");
});

test("the approximate server rejects missing and wrong REST and Socket credentials", async ({
  request,
}) => {
  const missingRest = await request.get(
    `${ROBOTSERVER}/v1/chat/conversations`,
    {
      headers: ORIGIN_HEADERS,
      params: { platformId: "platform-e2e" },
    },
  );
  expect(missingRest.status()).toBe(401);
  const wrongRest = await request.get(`${ROBOTSERVER}/v1/chat/conversations`, {
    headers: { ...ORIGIN_HEADERS, Authorization: "Bearer wrong" },
    params: { platformId: "platform-e2e" },
  });
  expect(wrongRest.status()).toBe(403);
  await expect(socketRejection({})).resolves.toBe(401);
  await expect(socketRejection({ token: "wrong" })).resolves.toBe(403);

  await expect
    .poll(async () => (await stateOf(request)).observations)
    .toMatchObject({
      rejectedRest: { missing: 1, wrong: 1 },
      rejectedSockets: { missing: 1, wrong: 1 },
    });
});

test("Bearer mode covers create, send, stream, interrupt, reconnect, CORS and disposal", async ({
  page,
  request,
}) => {
  const secret = "bearer-good";
  const consoleMessages: string[] = [];
  page.on("console", (message) => consoleMessages.push(message.text()));
  await page.goto("/");
  await fillConnection(page, "bearer", secret);
  await expect(page.getByText("本地私有应用 · TFROBOT 网关")).toBeVisible();
  await expect(
    page.getByText("RobotServer fixture conversation").first(),
  ).toBeVisible();
  await page.locator(".ant-segmented-item", { hasText: "双栏" }).click();
  const robotServerEvent = page.locator(
    '[data-chat-event-trigger="playground-event-1"]',
  );
  await robotServerEvent.click();
  await expect(page.locator('aside[aria-label="事件详情"]')).toContainText(
    "RobotServer 正式事件详情",
  );
  await page.locator(".ant-segmented-item", { hasText: "弹窗" }).click();
  await expect(page.getByRole("dialog", { name: "事件详情" })).toContainText(
    "RobotServer 正式事件详情",
  );
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "新建会话" }).click();
  await page
    .getByRole("dialog", { name: "新建会话" })
    .getByRole("button", { name: "确认新建" })
    .click();
  await expect(
    page
      .locator(".chat-stage > section > main > header")
      .getByText(
        /^\[tf-chat-kit playground\] \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/u,
      ),
  ).toBeVisible();
  const messageInput = page.getByLabel("消息");
  const sendButton = composerSendButton(page);
  await messageInput.fill("Browser real message");
  await sendButton.click();
  await expect(
    page.getByText("RobotServer streamed: Browser real message"),
  ).toBeVisible();
  await expect(page.getByText("运行中", { exact: true })).toBeVisible();
  await expect(page.getByText("运行中", { exact: true })).toBeHidden();
  await expect(messageInput).toHaveValue("");
  await expect(sendButton).not.toHaveClass(/ant-btn-loading/u);

  await messageInput.fill("Interrupt this answer");
  await expect(sendButton).toBeEnabled();
  await sendButton.click();
  await expect(page.getByText("运行中", { exact: true })).toBeVisible();
  const interruptButton = page.getByRole("button", {
    name: "中断当前任务",
  });
  await expect(
    page.locator('[data-chat-composer=""]').getByRole("button", {
      name: "中断当前任务",
    }),
  ).toBeVisible();
  await interruptButton.click();
  await expect(interruptButton).toBeHidden();
  await expect
    .poll(async () => (await stateOf(request)).observations.interrupts)
    .toBe(1);
  await page.getByRole("button", { name: "重连 REST 与 Socket" }).click();
  await expect(page.locator(".playground-hero .ant-tag")).toHaveText("已连接");
  await page.getByRole("button", { name: "重命名测试会话" }).click();
  const renameDialog = page.getByRole("dialog", { name: "重命名测试会话" });
  const renameInput = renameDialog.getByLabel("测试会话标题");
  const renamedTitle = `${await renameInput.inputValue()} renamed`;
  await renameInput.fill(renamedTitle);
  await renameDialog.getByRole("button", { name: "确认重命名" }).click();
  await expect(
    page
      .locator(".chat-stage > section > main > header")
      .getByText(renamedTitle),
  ).toBeVisible();
  await page.getByRole("button", { name: "删除测试会话" }).click();
  const deleteDialog = page.getByRole("dialog", { name: "删除测试会话" });
  await deleteDialog.getByRole("button", { name: "确认删除" }).click();
  await expect(page.getByText("尚未选择会话")).toBeVisible();

  const browserState = await page.evaluate(() => ({
    cookie: document.cookie,
    dom: document.documentElement.outerHTML,
    local: Object.values(localStorage),
    session: Object.values(sessionStorage),
    url: location.href,
  }));
  expect(JSON.stringify(browserState)).not.toContain(secret);
  expect(consoleMessages.join("\n")).not.toContain(secret);

  await expect
    .poll(async () => (await stateOf(request)).observations.socketConnections)
    .toBeGreaterThanOrEqual(3);
  await page.getByRole("button", { name: "Mock 模式" }).click();
  await expect(page.getByText("本地私有应用 · 内存网关")).toBeVisible();
  await expect
    .poll(async () => (await stateOf(request)).observations.activeSockets)
    .toBe(0);
  const switchedBrowserState = await page.evaluate(() => ({
    cookie: document.cookie,
    dom: document.documentElement.outerHTML,
    local: Object.values(localStorage),
    session: Object.values(sessionStorage),
    url: location.href,
  }));
  expect(JSON.stringify(switchedBrowserState)).not.toContain(secret);
  expect(consoleMessages.join("\n")).not.toContain(secret);

  await fillConnection(page, "bearer", secret);
  await expect(page.getByText("本地私有应用 · TFROBOT 网关")).toBeVisible();
  await page.reload();
  await expect(page.getByText("本地私有应用 · 内存网关")).toBeVisible();
  await expect(page.getByLabel("用户 Token")).toHaveCount(0);
  await expect
    .poll(async () => (await stateOf(request)).observations.activeSockets)
    .toBe(0);

  const reloadedBrowserState = await page.evaluate(() => ({
    cookie: document.cookie,
    dom: document.documentElement.outerHTML,
    local: Object.values(localStorage),
    session: Object.values(sessionStorage),
    url: location.href,
  }));
  expect(JSON.stringify(reloadedBrowserState)).not.toContain(secret);
  expect(consoleMessages.join("\n")).not.toContain(secret);

  const state = await stateOf(request);
  expect(
    state.conversations.some((title) =>
      title.startsWith("[tf-chat-kit playground]"),
    ),
  ).toBe(false);
  expect(state.observations).toMatchObject({
    activeSockets: 0,
    adminRequests: 0,
    conversationDeletes: 1,
    conversationRenames: 1,
    interrupts: 1,
    invalidOrigins: 0,
  });
  expect(state.observations.bearerRequests).toBeGreaterThan(0);
  expect(state.observations.contentTypeRequests).toBeGreaterThan(0);
  expect(state.observations.corsPreflights).toBe(0);
  expect(state.observations.joins).toBeGreaterThanOrEqual(3);
  expect(state.observations.routedRequests).toBeGreaterThan(0);
  expect(state.observations.socketDisconnections).toBeGreaterThanOrEqual(3);
});

test("Admin Token mode forwards admin_key to REST and Socket without Bearer fallback", async ({
  page,
  request,
}) => {
  await page.goto("/");
  await fillConnection(page, "admin", "admin-good");
  await expect(page.locator(".playground-hero .ant-tag")).toHaveText("已连接");
  const state = await stateOf(request);
  expect(state.observations.adminRequests).toBeGreaterThan(0);
  expect(state.observations.bearerRequests).toBe(0);
  expect(state.observations.socketConnections).toBeGreaterThan(0);
});

test("管理员密码模式换取短期 Admin Token 后连接 REST 与 Socket", async ({
  page,
  request,
}) => {
  const password = "password-good";
  await page.goto("/");
  await fillConnection(page, "password", password);
  await expect(page.locator(".playground-hero .ant-tag")).toHaveText("已连接");
  await expect(
    page.getByText("RobotServer fixture conversation").first(),
  ).toBeVisible();
  const browserState = await page.evaluate(() => ({
    cookie: document.cookie,
    dom: document.documentElement.outerHTML,
    local: Object.values(localStorage),
    session: Object.values(sessionStorage),
    url: location.href,
  }));
  expect(JSON.stringify(browserState)).not.toContain(password);
  const state = await stateOf(request);
  expect(state.observations.passwordLogins).toBe(1);
  expect(state.observations.adminRequests).toBeGreaterThan(0);
  expect(state.observations.socketConnections).toBeGreaterThan(0);
});
