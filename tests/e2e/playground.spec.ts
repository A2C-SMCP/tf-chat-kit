import { test, expect, type Page } from "@playwright/test";
import {
  MANAGER,
  interaction,
  reset,
  waitForReady,
} from "./fixtures/interaction-channel-helpers.js";
const chat = (page: Page) =>
  page.getByRole("region", { name: "Chat Kit 连接", exact: true });
const tools = (page: Page) =>
  page.getByRole("region", { name: "RemoteTool 连接", exact: true });
const state = async (page: Page) =>
  (await page.request.get(`${MANAGER}/__test/remote-state`)).json();
async function environment(page: Page) {
  await page.goto("/");
  await page
    .getByRole("combobox", { name: "Manager 环境", exact: true })
    .press("ArrowDown");
  await page.getByText("自定义", { exact: true }).click();
  await page.getByLabel("自定义 Manager 地址").fill(MANAGER);
  await page.getByRole("button", { name: "应用环境", exact: true }).click();
  await chat(page).getByLabel("账号", { exact: true }).fill("fixture");
  await chat(page).getByLabel("密码", { exact: true }).fill("fixture");
  await chat(page).getByRole("button", { name: "登录", exact: true }).click();
  await expect(
    chat(page).getByRole("button", { name: /legacy/ }),
  ).toBeVisible();
}
async function register(page: Page) {
  await tools(page)
    .getByRole("button", { name: "加载机器人", exact: true })
    .click();
  await tools(page)
    .getByRole("combobox", { name: "RemoteTool 机器人", exact: true })
    .press("ArrowDown");
  await page.getByTitle("legacy", { exact: true }).last().click();
  await tools(page)
    .getByRole("button", { name: "注册 add", exact: true })
    .click();
  await expect(tools(page).getByText("已注册", { exact: true })).toBeVisible();
}
async function connectChat(page: Page) {
  await chat(page)
    .getByRole("button", { name: /legacy/ })
    .click();
  await expect(
    chat(page).getByRole("button", { name: "发送", exact: true }),
  ).toBeVisible();
  await chat(page)
    .locator("textarea:not([aria-hidden])")
    .fill("Browser round trip");
  const created = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith("/conversations"),
  );
  await chat(page).getByRole("button", { name: "发送", exact: true }).click();
  await expect(
    chat(page).getByText("Direct browser reply", { exact: true }),
  ).toBeVisible();
  const { data } = await (await created).json();
  return String(data.conversationId);
}
test("default host UI uses test Manager and exposes no Mock or local simulation", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByText("当前 Manager：https://rest.test.turingfocus.cn", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(chat(page).getByText("欢迎回来", { exact: true })).toBeVisible();
  await expect(page.getByText(/Mock 模式|共享连接验收|本地演示/)).toHaveCount(
    0,
  );
  const sizes = await chat(page)
    .locator(".ant-input,.ant-input-affix-wrapper")
    .evaluateAll((els) => els.map((el) => el.getBoundingClientRect().height));
  expect(sizes.slice(0, 2)).toEqual([40, 40]);
  for (const width of [375, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth - innerWidth,
      ),
    ).toBeLessThanOrEqual(1);
  }
});
test("ManagerChatApp connects automatically and answers in the active conversation", async ({
  page,
  request,
}) => {
  await reset(request);
  await environment(page);
  const conversationId = await connectChat(page);
  await waitForReady(request, 1);
  const interactionState = async () =>
    (await request.get(`${MANAGER}/__test/interaction-state`)).json();
  expect(await interactionState()).toMatchObject({ registerCalls: 0 });
  await expect(
    tools(page).getByRole("button", { name: "注册 ask_user" }),
  ).toHaveCount(0);
  const question = "May I use this draft?";
  const emitted = await request.post(`${MANAGER}/__test/interaction-request`, {
    data: {
      interaction: interaction(
        "playground-interaction",
        question,
        Date.now() + 30_000,
        conversationId,
      ),
    },
  });
  expect(emitted.ok()).toBe(true);

  const workspace = chat(page);
  await expect(workspace.getByText(question, { exact: true })).toBeVisible();
  await expect(page.getByRole("dialog").getByText(question)).toHaveCount(0);
  await workspace.getByLabel("Yes", { exact: true }).check();
  await workspace.getByRole("button", { name: "提交", exact: true }).click();
  await expect.poll(interactionState).toMatchObject({
    registerCalls: 0,
    responses: [
      {
        interactionId: "playground-interaction",
        status: "answered",
        selectedOptions: ["yes"],
      },
    ],
  });
  await expect(workspace.getByText(question, { exact: true })).toHaveCount(0);
  await workspace.getByRole("button", { name: "断开 Chat Kit" }).click();
  await expect.poll(interactionState).toMatchObject({ disconnects: 1 });
});
test("tool first: real registration and add dispatch share one socket with default chat and survive independent disposal", async ({
  page,
}) => {
  await environment(page);
  await register(page);
  expect(await state(page)).toMatchObject({ engines: 1, chat: 0, tools: 1 });
  const invocation = await page.request.post(
    `${MANAGER}/__test/remote-invoke`,
    { data: { a: 12, b: 30 } },
  );
  expect(await invocation.json()).toMatchObject({
    success: true,
    resultForLlm: "42",
  });
  await expect(
    tools(page).getByRole("list", { name: "add 调用记录" }),
  ).toContainText("add(12, 30) = 42");
  await connectChat(page);
  await expect
    .poll(() => state(page))
    .toMatchObject({ engines: 2, chat: 1, tools: 1 });
  await chat(page)
    .getByRole("button", { name: "断开 Chat Kit", exact: true })
    .click();
  await expect(tools(page).getByText("已注册", { exact: true })).toBeVisible();
  await expect
    .poll(() => state(page))
    .toMatchObject({ engines: 1, chat: 0, tools: 1 });
  expect(
    (
      await page.request.post(`${MANAGER}/__test/remote-invoke`, {
        data: { a: 1, b: 2 },
      })
    ).ok(),
  ).toBe(true);
  await tools(page)
    .getByRole("button", { name: "注销 RemoteTool", exact: true })
    .click();
  await expect(tools(page).getByText("未注册", { exact: true })).toBeVisible();
  expect((await state(page)).scopes).toEqual(
    expect.arrayContaining(["action:execute", "chat:read chat:send"]),
  );
});
test("chat first: revoking and re-registering tools does not interrupt chat", async ({
  page,
}) => {
  await environment(page);
  await connectChat(page);
  await register(page);
  await expect
    .poll(() => state(page))
    .toMatchObject({ engines: 2, chat: 1, tools: 1 });
  await tools(page)
    .getByRole("button", { name: "注销 RemoteTool", exact: true })
    .click();
  await expect(tools(page).getByText("未注册", { exact: true })).toBeVisible();
  await chat(page)
    .locator("textarea:not([aria-hidden])")
    .fill("UI long text: after tool revocation");
  const sent = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      /\/messages(?:\?|$)/u.test(response.url()),
  );
  await chat(page).getByRole("button", { name: "发送", exact: true }).click();
  expect((await sent).ok()).toBe(true);
  await expect(
    chat(page).getByText("Direct browser reply", { exact: true }),
  ).toBeVisible();
  await tools(page)
    .getByRole("button", { name: "注册 add", exact: true })
    .click();
  await expect(tools(page).getByText("已注册", { exact: true })).toBeVisible();
  await expect
    .poll(() => state(page))
    .toMatchObject({ engines: 2, chat: 1, tools: 1 });
  await page
    .getByRole("combobox", { name: "Manager 环境", exact: true })
    .press("ArrowDown");
  await page.getByText("staging", { exact: true }).click();
  await expect(chat(page).getByText("欢迎回来", { exact: true })).toBeVisible();
  await expect(tools(page).getByText("未注册", { exact: true })).toBeVisible();
});
test("explicit tool permission denial stays visible and leaves chat usable", async ({
  page,
}) => {
  await reset(page.request);
  await environment(page);
  await page.request.post(`${MANAGER}/__test/tool-permission`, {
    data: { denied: true },
  });
  await connectChat(page);
  await tools(page)
    .getByRole("button", { name: "加载机器人", exact: true })
    .click();
  await tools(page)
    .getByRole("combobox", { name: "RemoteTool 机器人", exact: true })
    .press("ArrowDown");
  await page.getByTitle("legacy", { exact: true }).last().click();
  await tools(page)
    .getByRole("button", { name: "注册 add", exact: true })
    .click();
  await expect(
    tools(page).getByText("连接失败", { exact: true }),
  ).toBeVisible();
  await expect(tools(page).getByRole("alert")).toBeVisible();
  await expect(
    chat(page).getByRole("button", { name: "发送", exact: true }),
  ).toBeVisible();
  expect(await state(page)).toMatchObject({ engines: 1, chat: 1, tools: 0 });
});
