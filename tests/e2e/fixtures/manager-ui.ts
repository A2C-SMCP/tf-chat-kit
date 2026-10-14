import { test, expect, type Page } from "@playwright/test";

const mount = async (
  page: Page,
  options: { locale?: string; platformId?: number; restoring?: boolean } = {},
) => {
  await page.goto("/");
  await page.evaluate(
    async ({ origin, options }) => {
      const entry = "/consumer.js";
      const api = await import(entry);
      const auth = api.createAuthClient({
        environment: "staging",
        transport: api.createTfRobotAuthTransport({
          baseUrl: origin,
          fetch: globalThis.fetch,
        }),
      });
      const manager = api.createManagerClient({
        auth,
        baseUrl: origin,
        fetch: globalThis.fetch,
        routing: { allowedOrigins: [origin], http: { kind: "routed-server" } },
      });
      const host = document.createElement("div");
      host.id = "word-pane";
      host.style.cssText = "width:380px;height:720px;border:1px solid #ddd";
      document.body.append(host);
      const root = api.createRoot(host);
      const chat = {
        serverProfile: { kind: "current-server" },
        conversationContract: "json-v2",
        messageCreatorProvider: () => ({
          uid: "manager-user",
          name: "Word user",
        }),
      };
      const render = (patch = {}) =>
        root.render(
          api.createElement(
            api.StrictMode,
            null,
            api.createElement(api.ManagerChatApp, {
              auth,
              manager,
              chat,
              ...options,
              ...patch,
            }),
          ),
        );
      render();
      Object.assign(window, {
        uiTest: { auth, manager, render, unmount: () => root.unmount() },
      });
    },
    {
      origin: process.env["TF_CHAT_MANAGER_ORIGIN"] ?? "https://localhost:4312",
      options,
    },
  );
};
const login = async (page: Page) => {
  await page.getByLabel("账号", { exact: true }).fill("ui");
  await page.getByLabel("密码", { exact: true }).fill("transient");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "选择工作组织" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "进入组织" })).toBeDisabled();
  await page.getByRole("button", { name: /Word 测试组织/ }).click();
  await page.getByRole("button", { name: "进入组织" }).click();
  await page.getByRole("button", { name: /legacy/ }).click();
  await page.getByRole("button", { name: "使用这个机器人" }).click();
};

export function registerManagerUiTests() {
  test("default Word UI: actual login, explicit account/platform, first send, Socket reply, history, drafts and logout", async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const writes: string[] = [];
    page.on("request", (req) => {
      if (req.method() === "POST" && /\/conversations$/.test(req.url()))
        writes.push(req.url());
    });
    await mount(page);
    await login(page);
    await expect(
      page.getByRole("heading", { name: "选择对话平台" }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "开始对话" })).toBeDisabled();
    await page.getByRole("button", { name: /Word fixture/ }).click();
    await page.getByRole("button", { name: "开始对话" }).click();
    await expect(page.getByText("从一个想法开始。")).toBeVisible();
    await page.screenshot({
      path: test.info().outputPath("default-ui-welcome.png"),
    });
    expect(writes).toHaveLength(0);
    for (const width of [320, 380, 480, 760]) {
      await page.locator("#word-pane").evaluate((el, width) => {
        (el as HTMLElement).style.width = `${width}px`;
      }, width);
      const bounds = await page
        .locator("#word-pane")
        .evaluate((el) => ({ scroll: el.scrollWidth, width: el.clientWidth }));
      expect(bounds.scroll).toBeLessThanOrEqual(bounds.width + 1);
      await expect(
        page.locator("textarea:not([aria-hidden])"),
      ).toBeInViewport();
    }
    await page.locator("#word-pane").evaluate((el) => {
      (el as HTMLElement).style.width = "320px";
      (el as HTMLElement).style.zoom = "2";
    });
    await expect(page.locator("textarea:not([aria-hidden])")).toBeVisible();
    await page.locator("#word-pane").evaluate((el) => {
      (el as HTMLElement).style.zoom = "1";
    });
    await page
      .locator("textarea:not([aria-hidden])")
      .fill("Browser round trip");
    await page.getByRole("button", { name: "新建对话", exact: true }).click();
    await expect(page.locator("textarea:not([aria-hidden])")).toHaveValue(
      "Browser round trip",
    );
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect(
      page.getByText("Direct browser reply", { exact: true }),
    ).toBeVisible();
    await page.screenshot({
      path: test.info().outputPath("default-ui-chat.png"),
    });
    expect(writes).toHaveLength(1);
    await page.locator("textarea:not([aria-hidden])").fill("仅此会话的草稿");
    await page.getByRole("button", { name: "历史对话", exact: true }).click();
    await expect(
      page.getByText("Manager browser fixture", { exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "返回对话", exact: false }).click();
    await expect(page.locator("textarea:not([aria-hidden])")).toHaveValue(
      "仅此会话的草稿",
    );
    await expect(
      page.getByRole("button", { name: "历史对话", exact: true }),
    ).toBeFocused();
    await page.getByRole("button", { name: "历史对话", exact: true }).click();
    await page
      .getByRole("button", { name: "Browser round trip actions", exact: true })
      .click();
    await page.getByRole("menuitem", { name: "重命名" }).click();
    await page
      .getByRole("textbox", { name: "对话名称" })
      .fill("已重命名的会话");
    const renamed = page.waitForResponse(
      (response) => response.request().method() === "PATCH",
    );
    await page.getByRole("button", { name: "保存", exact: true }).click();
    expect((await renamed).status()).toBe(200);
    await expect(page.getByRole("dialog")).not.toBeVisible();
    await page
      .getByRole("button", { name: "已重命名的会话 actions", exact: true })
      .click();
    await page.getByRole("menuitem", { name: "删除对话" }).click();
    await page.getByRole("button", { name: "删除", exact: true }).click();
    await expect(page.getByRole("dialog")).not.toBeVisible();
    await expect(
      page.getByText("已重命名的会话", { exact: true }),
    ).not.toBeVisible();
    await page.getByRole("button", { name: "返回对话", exact: false }).click();
    await expect(page.getByText("从一个想法开始。")).toBeVisible();
    await page.getByRole("button", { name: "账号与设置", exact: true }).click();
    await page.getByRole("button", { name: "退出登录", exact: true }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).not.toBeVisible();
    await page.getByRole("button", { name: "退出登录", exact: true }).click();
    await page.getByRole("button", { name: "确认", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "登录", exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(() => ({
        local: localStorage.length,
        session: sessionStorage.length,
      })),
    ).toEqual({ local: 0, session: 0 });
    expect(errors).toEqual([]);
  });
  test("restoration, English, host preset replacement and host ownership", async ({
    page,
  }) => {
    await mount(page, { locale: "en-US", platformId: 17, restoring: true });
    await expect(page.getByText("Restoring your session…")).toBeVisible();
    await expect(page.locator("input[type=password]")).toHaveCount(0);
    await page.evaluate(async () => {
      const api = (
        window as unknown as {
          uiTest: {
            auth: { login(input: unknown): Promise<unknown> };
            render(input: unknown): void;
          };
        }
      ).uiTest;
      await api.auth.login({ identifier: "fixture", password: "transient" });
      api.render({ restoring: false });
    });
    await page.getByRole("button", { name: /legacy/ }).click();
    await page.getByRole("button", { name: "Use this assistant" }).click();
    await expect(page.getByText("Start with an idea.")).toBeVisible();
    await expect(page.getByText("Word fixture", { exact: true })).toBeVisible();
    await page.locator("textarea:not([aria-hidden])").fill("private draft");
    await page.evaluate(() =>
      (
        window as unknown as { uiTest: { render(input: unknown): void } }
      ).uiTest.render({ restoring: false, platformId: 18 }),
    );
    await expect(page.getByText("private draft")).not.toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Who will you work with today?" }),
    ).toBeVisible();
    const status = await page.evaluate(() => {
      const api = (
        window as unknown as {
          uiTest: {
            unmount(): void;
            auth: { getSnapshot(): { status: string } };
            manager: { getSnapshot(): { status: string } };
          };
        }
      ).uiTest;
      api.unmount();
      return {
        auth: api.auth.getSnapshot().status,
        manager: api.manager.getSnapshot().status,
      };
    });
    expect(status.auth).toBe("authenticated");
    expect(status.manager).not.toBe("disposed");
  });
  test("401 retains only same-identity text; 403 stays an access error; switching organizations isolates drafts", async ({
    page,
  }) => {
    await mount(page, { platformId: 17 });
    await login(page);
    await expect(page.getByText("从一个想法开始。")).toBeVisible();
    await page.locator("textarea:not([aria-hidden])").fill("同身份临时草稿");
    await page.evaluate(async (origin) => {
      await fetch(`${origin}/__test/directory-status`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: 401 }),
      });
      await (
        window as unknown as {
          uiTest: { manager: { refresh(): Promise<unknown> } };
        }
      ).uiTest.manager
        .refresh()
        .catch(() => {});
    }, process.env["TF_CHAT_MANAGER_ORIGIN"] ?? "https://localhost:4312");
    await expect(
      page.getByText("登录已过期，请重新登录后继续。"),
    ).toBeVisible();
    await expect(page.locator("textarea:not([aria-hidden])")).toHaveCount(0);
    await page.getByLabel("账号", { exact: true }).fill("ui");
    await page.getByLabel("密码", { exact: true }).fill("transient");
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await page.getByRole("button", { name: /Word 测试组织/ }).click();
    await page.getByRole("button", { name: "进入组织" }).click();
    await expect(page.locator("textarea:not([aria-hidden])")).toHaveValue(
      "同身份临时草稿",
    );
    await page.getByRole("button", { name: "账号与设置", exact: true }).click();
    await page.getByRole("button", { name: "切换组织", exact: true }).click();
    await page
      .getByRole("button", { name: "使用其他账号", exact: true })
      .click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.getByRole("button", { name: "取消", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "选择工作组织" }),
    ).toBeVisible();
    await page.getByRole("button", { name: /另一个组织/ }).click();
    await page.getByRole("button", { name: "进入组织" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.getByRole("button", { name: "确认", exact: true }).click();
    await page.getByRole("button", { name: /legacy/ }).click();
    await page.getByRole("button", { name: "使用这个机器人" }).click();
    await expect(page.locator("textarea:not([aria-hidden])")).toHaveValue("");
    await page.getByRole("button", { name: /legacy/ }).click();
    await page.evaluate(async (origin) => {
      await fetch(`${origin}/__test/directory-status`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: 403 }),
      });
      await (
        window as unknown as {
          uiTest: { manager: { refresh(): Promise<unknown> } };
        }
      ).uiTest.manager
        .refresh()
        .catch(() => {});
    }, process.env["TF_CHAT_MANAGER_ORIGIN"] ?? "https://localhost:4312");
    await expect(
      page.getByText("你暂时没有访问权限，请联系管理员。"),
    ).toBeVisible();
    await expect(page.getByText("private-fixture-detail")).not.toBeVisible();
    await expect(page.locator("[data-chat-compact-workspace]")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /legacy/ })).toHaveCount(0);
    await expect(page.locator("input[type=password]")).toHaveCount(0);
  });
  test("RobotServer 403 hides loaded messages and composer without renewing credentials", async ({
    page,
  }) => {
    let exchanges = 0;
    page.on("request", (req) => {
      if (req.url().endsWith("/api/v1/oauth/token")) exchanges++;
    });
    await mount(page, { platformId: 17 });
    await login(page);
    await expect(page.getByText("从一个想法开始。")).toBeVisible();
    await page.getByRole("button", { name: "历史对话", exact: true }).click();
    await page
      .getByRole("button", { name: /Manager browser fixture/, exact: false })
      .first()
      .click();
    await expect(
      page.getByText("Persisted private reply", { exact: true }),
    ).toBeVisible();
    const before = exchanges;
    await page.evaluate(async (origin) => {
      await fetch(`${origin}/__test/chat-status`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: 403 }),
      });
    }, process.env["TF_CHAT_MANAGER_ORIGIN"] ?? "https://localhost:4312");
    await page
      .locator("textarea:not([aria-hidden])")
      .fill("Browser round trip");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect(
      page.getByText("你暂时没有访问权限，请联系管理员。"),
    ).toBeVisible();
    await expect(
      page.getByText("Persisted private reply", { exact: true }),
    ).not.toBeVisible();
    await expect(page.locator("textarea:not([aria-hidden])")).toHaveCount(0);
    await expect(page.locator("input[type=password]")).toHaveCount(0);
    expect(exchanges).toBe(before);
  });
  test("localized login errors retain account and clear password", async ({
    page,
  }) => {
    await mount(page);
    await page.getByLabel("账号", { exact: true }).fill("ui");
    await page.getByLabel("密码", { exact: true }).fill("invalid");
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await expect(
      page.getByText("登录失败，请检查账号与密码后重试。"),
    ).toBeVisible();
    await expect(page.getByLabel("账号", { exact: true })).toHaveValue("ui");
    await expect(page.getByLabel("密码", { exact: true })).toHaveValue("");
    await expect(page.getByText("private-fixture-detail")).not.toBeVisible();
  });
  test("history pagination 403 hides loaded titles and messages", async ({
    page,
  }) => {
    await mount(page, { platformId: 17 });
    await login(page);
    await expect(page.getByText("从一个想法开始。")).toBeVisible();
    await page.getByRole("button", { name: "历史对话", exact: true }).click();
    await page
      .getByRole("list")
      .getByText("Manager browser fixture", { exact: true })
      .click();
    await expect(
      page.getByText("Persisted private reply", { exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "历史对话", exact: true }).click();
    await page.evaluate(async (origin) => {
      await fetch(`${origin}/__test/history-status`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: 403 }),
      });
    }, process.env["TF_CHAT_MANAGER_ORIGIN"] ?? "https://localhost:4312");
    await page.getByRole("button", { name: "加载更多", exact: true }).click();
    await expect(
      page.getByText("你暂时没有访问权限，请联系管理员。"),
    ).toBeVisible();
    await expect(
      page.getByText("Persisted private reply", { exact: true }),
    ).not.toBeVisible();
    await expect(
      page.getByText("Manager browser fixture", { exact: true }),
    ).not.toBeVisible();
    await expect(page.locator("textarea:not([aria-hidden])")).toHaveCount(0);
  });
  test("long pasted welcome draft survives navigation and sends its complete content", async ({
    page,
  }) => {
    await mount(page, { platformId: 17 });
    await login(page);
    const message = "UI long text:" + "长文本".repeat(1700);
    const input = page.locator("textarea:not([aria-hidden])");
    await input.waitFor();
    await input.evaluate((element, message) => {
      const data = new DataTransfer();
      data.setData("text/plain", message);
      element.dispatchEvent(
        new ClipboardEvent("paste", {
          bubbles: true,
          cancelable: true,
          clipboardData: data,
        }),
      );
    }, message);
    await page.getByRole("button", { name: "历史对话", exact: true }).click();
    await page.getByRole("button", { name: "返回对话", exact: false }).click();
    const request = page.waitForRequest(
      (req) => req.method() === "POST" && req.url().includes("/messages"),
    );
    await page.getByRole("button", { name: "发送", exact: true }).click();
    expect((await request).postDataJSON().content).toBe(message);
    await expect(
      page.getByText("Direct browser reply", { exact: true }),
    ).toBeVisible();
  });
}
