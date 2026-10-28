import { test, expect, type Page } from "@playwright/test";

const readyDialog = async (page: Page, name?: string) => {
  const dialog = page.getByRole("dialog", name ? { name } : {});
  await expect(dialog).toBeVisible();
  // WebKit can drop a click while Ant Design's zoom transition is entering.
  await expect(dialog).not.toHaveClass(/(?:^|\s)ant-zoom-enter(?:\s|$)/);
  return dialog;
};

const mount = async (
  page: Page,
  options: {
    locale?: string;
    platformId?: number;
    restoring?: boolean;
    contentMaxWidth?: number | string;
    conversationContract?: "json-v2" | "query-v1";
  } = {},
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
        conversationContract: options.conversationContract ?? "json-v2",
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
const login = async (page: Page, beforeSelect?: () => Promise<void>) => {
  await page.getByLabel("账号", { exact: true }).fill("ui");
  await page.getByLabel("密码", { exact: true }).fill("transient");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "选择工作组织" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "进入组织" })).toBeDisabled();
  await beforeSelect?.();
  await page.getByRole("button", { name: /Word 测试组织/ }).click();
  await page.getByRole("button", { name: "进入组织" }).click();
  await page.getByRole("button", { name: /legacy/ }).click();
  await page.getByRole("button", { name: "使用这个机器人" }).click();
};

export function registerManagerUiTests() {
  test("Manager generated text: expands only model text and preserves history/live identity", async ({
    page,
  }) => {
    await mount(page, { platformId: 17 });
    await login(page);
    await expect(page.locator("textarea:not([aria-hidden])")).toBeEnabled();
    const origin =
      process.env["TF_CHAT_MANAGER_ORIGIN"] ?? "https://localhost:4312";
    await page.evaluate(async (origin) => {
      await fetch(`${origin}/__test/ui-options`, {
        method: "POST",
        body: JSON.stringify({ generatedTextEvents: true }),
      });
    }, origin);
    await page.getByRole("button", { name: "历史对话", exact: true }).click();
    await page
      .getByRole("list")
      .getByText("Manager browser fixture", { exact: true })
      .click();
    const bodies = page.locator("[data-chat-generated-text]");
    await expect(bodies).toHaveCount(1);
    await expect(bodies.locator("strong")).toHaveText("找到文件了");
    await expect(bodies.first()).toContainText("长段落验收结束");
    await expect(bodies.first().locator("code")).toContainText(
      "model_output_line",
    );
    await expect(
      page.getByText("Persisted private reply", { exact: true }),
    ).toBeVisible();
    await expect(page.locator("[data-chat-event-row]").first()).toBeVisible();
    await page.evaluate(async (origin) => {
      await fetch(`${origin}/__test/generated-text`, { method: "POST" });
    }, origin);
    await page.getByRole("log").evaluate((el) => {
      el.scrollTop = 0;
    });
    await expect(bodies).toHaveCount(2);
    await expect(bodies.filter({ hasText: "继续核对" })).toHaveCount(1);
    for (const width of [320, 380, 760]) {
      await page.locator("#word-pane").evaluate((el, width) => {
        (el as HTMLElement).style.width = `${width}px`;
      }, width);
      const overflow = await bodies
        .filter({ hasText: "长段落验收结束" })
        .evaluate((el) => el.scrollWidth - el.clientWidth);
      expect(overflow).toBeLessThanOrEqual(1);
    }
    await page.screenshot({
      path: test.info().outputPath("generated-text-mixed.png"),
    });
    await page.getByRole("button", { name: "历史对话", exact: true }).click();
    await page.getByRole("button", { name: "返回对话", exact: false }).click();
    await page.getByRole("log").evaluate((el) => {
      el.scrollTop = 0;
    });
    await expect(bodies).toHaveCount(2);
  });
  test("Manager content width: welcome and conversation follow the host without losing drafts", async ({
    page,
  }) => {
    await mount(page, { platformId: 17 });
    await login(page);
    const input = page.locator("textarea:not([aria-hidden])");
    const content = page.locator("[data-chat-compact-content]");
    await expect(input).toBeEnabled();
    const widths = [320, 380, 480, 760, 1024];
    let connections = 0;
    page.on("request", (request) => {
      if (request.url().endsWith("/connection-info")) connections++;
    });
    const resizeAndCheck = async (draft: string) => {
      for (const width of widths) {
        await page.locator("#word-pane").evaluate((el, width) => {
          (el as HTMLElement).style.width = `${width}px`;
        }, width);
        await expect
          .poll(async () => Math.round((await content.boundingBox())!.width))
          .toBe(width);
        const bounds = await input.boundingBox();
        expect(bounds!.width).toBeGreaterThan(width - 160);
        expect(
          (await page.locator("[data-chat-composer]").boundingBox())!.width,
        ).toBeGreaterThan(width - 60);
        await expect(input).toHaveValue(draft);
        const overflow = await content.evaluate(
          (el) => el.scrollWidth - el.clientWidth,
        );
        expect(overflow).toBeLessThanOrEqual(1);
      }
    };
    await input.fill("welcome draft");
    await resizeAndCheck("welcome draft");
    await page.getByRole("button", { name: "历史对话", exact: true }).click();
    await page
      .getByRole("list")
      .getByText("Manager browser fixture", { exact: true })
      .click();
    await expect(
      page.getByText("Persisted private reply", { exact: true }),
    ).toBeVisible();
    await input.fill("conversation draft");
    await resizeAndCheck("conversation draft");
    await page.screenshot({
      path: test.info().outputPath("manager-full-width-1024.png"),
    });
    expect(connections).toBe(0);
  });
  test("Manager content width: configurable limits are responsive and do not reconnect", async ({
    page,
  }) => {
    await mount(page, { platformId: 17, contentMaxWidth: 680 });
    await login(page);
    const input = page.locator("textarea:not([aria-hidden])");
    const content = page.locator("[data-chat-compact-content]");
    await expect(input).toBeEnabled();
    let connections = 0;
    page.on("request", (request) => {
      if (request.url().endsWith("/connection-info")) connections++;
    });
    const checkLimit = async (limit: number) => {
      for (const width of [320, 760, 1024]) {
        await page.locator("#word-pane").evaluate((el, width) => {
          (el as HTMLElement).style.width = `${width}px`;
        }, width);
        await expect
          .poll(async () => Math.round((await content.boundingBox())!.width))
          .toBe(Math.min(width, limit));
        const box = (await content.boundingBox())!;
        const pane = (await page.locator("#word-pane").boundingBox())!;
        expect(
          Math.abs(box.x + box.width / 2 - pane.x - pane.width / 2),
        ).toBeLessThanOrEqual(1);
        await expect(input).toHaveValue("retained draft");
      }
    };
    await input.fill("retained draft");
    await checkLimit(680);
    await page.evaluate(() => {
      (
        window as unknown as { uiTest: { render(input: unknown): void } }
      ).uiTest.render({ contentMaxWidth: "52rem" });
    });
    await checkLimit(832);
    await page.evaluate(() => {
      (
        window as unknown as { uiTest: { render(input: unknown): void } }
      ).uiTest.render({ contentMaxWidth: undefined });
    });
    await checkLimit(Infinity);
    await page.getByRole("button", { name: "历史对话", exact: true }).click();
    await page
      .getByRole("list")
      .getByText("Manager browser fixture", { exact: true })
      .click();
    await expect(
      page.getByText("Persisted private reply", { exact: true }),
    ).toBeVisible();
    await input.fill("retained draft");
    await page.evaluate(() => {
      (
        window as unknown as { uiTest: { render(input: unknown): void } }
      ).uiTest.render({ contentMaxWidth: 680 });
    });
    await checkLimit(680);
    await page.screenshot({
      path: test.info().outputPath("manager-limited-width-1024.png"),
    });
    expect(connections).toBe(0);
  });
  test("compact chat toolbar uses icons and an inline menu while context stays read-only", async ({
    page,
  }) => {
    await mount(page);
    await login(page);
    await page.getByRole("button", { name: /Word fixture/ }).click();
    await page.getByRole("button", { name: "开始对话" }).click();
    const input = page.locator("textarea:not([aria-hidden])");
    await input.fill("保留菜单走查草稿");
    await expect(page.locator(".tf-top")).not.toContainText("当前工作组织");
    const organization = page.getByRole("group", {
      name: "当前工作组织: Word 测试组织",
      exact: true,
    });
    await expect(organization).toBeVisible();
    await organization.click();
    await expect(input).toHaveValue("保留菜单走查草稿");
    await expect(
      page.getByRole("button", { name: /切换组织: Word 测试组织/ }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: "选择工作组织" }),
    ).toHaveCount(0);
    await expect(organization).not.toContainText("⌄");
    await expect(
      page.getByLabel("当前机器人: 目录 ID: legacy", { exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: /切换机器人/ })).toHaveCount(
      0,
    );
    await expect(
      page.getByRole("button", { name: "切换平台", exact: true }),
    ).toHaveCount(0);
    for (const name of ["历史对话", "新建对话", "更多操作"]) {
      const button = page.getByRole("button", { name, exact: true });
      await expect(button.locator("svg")).toHaveCount(1);
      await expect(button).toHaveText("");
      expect(
        await button.evaluate((el) => ({
          width: el.getBoundingClientRect().width,
          height: el.getBoundingClientRect().height,
        })),
      ).toEqual({ width: 28, height: 28 });
      await expect(button.locator("svg")).toHaveAttribute("width", "14");
    }
    const more = page.getByRole("button", { name: "更多操作", exact: true });
    for (const width of [320, 380, 480, 760]) {
      await page.locator("#word-pane").evaluate((el, width) => {
        (el as HTMLElement).style.width = `${width}px`;
      }, width);
      const context = await page.locator(".tf-toolbar").boundingBox();
      expect(
        (await page.locator(".tf-chat-context .tf-top").boundingBox())!.height,
      ).toBeLessThanOrEqual(42);
      const toolbar = await page
        .locator("[data-chat-compact-toolbar]")
        .boundingBox();
      expect(context!.height + toolbar!.height).toBeLessThanOrEqual(76);
      const platform = await page.locator(".tf-platform-context").boundingBox();
      expect(platform!.y).toBeGreaterThanOrEqual(context!.y);
      expect(platform!.y + platform!.height).toBeLessThanOrEqual(
        context!.y + context!.height,
      );
      await more.click();
      const menu = page.getByRole("menu");
      await expect(menu).toBeVisible();
      await expect(
        page.getByRole("menuitem", { name: "切换机器人", exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("menuitem", { name: "切换平台", exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("menuitem", { name: "帮助与诊断", exact: true }),
      ).toBeVisible();
      await expect(input).toBeVisible();
      await expect(input).toHaveValue("保留菜单走查草稿");
      const bounds = await more.boundingBox();
      const menuBounds = await menu.boundingBox();
      expect(menuBounds!.y).toBeGreaterThanOrEqual(
        bounds!.y + bounds!.height - 1,
      );
      expect(
        await page
          .locator("#word-pane")
          .evaluate((el) => el.scrollWidth - el.clientWidth),
      ).toBeLessThanOrEqual(1);
      await page.screenshot({
        path: test.info().outputPath(`compact-menu-${width}.png`),
      });
      await page.keyboard.press("Escape");
      await expect(menu).not.toBeVisible();
      await expect(more).toBeFocused();
    }
    await more.click();
    await page
      .getByRole("menuitem", { name: "帮助与诊断", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "帮助与诊断" }),
    ).toBeVisible();
    await page.getByRole("button", { name: /返回对话/ }).click();
    await expect(more).toBeFocused();
    await expect(input).toHaveValue("保留菜单走查草稿");
    await page.evaluate(() =>
      (
        window as unknown as { uiTest: { render(input: unknown): void } }
      ).uiTest.render({ platformId: 17 }),
    );
    await page.getByRole("button", { name: /legacy/ }).click();
    await page.getByRole("button", { name: "使用这个机器人" }).click();
    await expect(page.getByText("从一个想法开始。")).toBeVisible();
    await more.click();
    await expect(
      page.getByRole("menuitem", { name: "切换平台", exact: true }),
    ).toHaveAttribute("aria-disabled", "true");
  });
  const configureUi = async (page: Page, options: Record<string, unknown>) => {
    await page.evaluate(
      async ({ origin, options }) => {
        await fetch(`${origin}/__test/ui-options`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(options),
        });
      },
      {
        origin:
          process.env["TF_CHAT_MANAGER_ORIGIN"] ?? "https://localhost:4312",
        options,
      },
    );
  };
  test("conversation failure cards show real reasons and safely restore original text in a narrow host", async ({
    page,
  }) => {
    await mount(page, { platformId: 17 });
    await login(page);
    await configureUi(page, { conversationFailures: true });
    await page.getByRole("button", { name: "历史对话", exact: true }).click();
    await page
      .getByRole("list", { name: "历史对话", exact: true })
      .getByRole("listitem")
      .filter({ hasText: "Manager browser fixture" })
      .getByRole("button")
      .first()
      .click();
    const card = page.locator("[data-chat-conversation-failure]");
    await expect(card).toContainText("本轮生成失败");
    await expect(card).toContainText("139132 超过最大限制 128000");
    await expect(card).toContainText("历史错误记录");
    const input = page.locator("textarea:not([aria-hidden])");
    let sent = 0;
    page.on("request", (request) => {
      if (
        request.method() === "POST" &&
        /\/messages(?:\?|$)/u.test(request.url())
      )
        sent++;
    });
    await card.getByRole("button", { name: "回填后编辑" }).click();
    await expect(input).toHaveValue("我选中的文字加粗");
    await expect(input).toBeFocused();
    await input.fill("保留当前草稿");
    await card.getByRole("button", { name: "回填后编辑" }).click();
    let confirmation = await readyDialog(page, "替换当前草稿？");
    await confirmation
      .getByRole("button", { name: "取消", exact: true })
      .click();
    await expect(input).toHaveValue("保留当前草稿");
    await expect(
      page.getByRole("dialog", { name: "替换当前草稿？" }),
    ).not.toBeVisible();
    await card.getByRole("button", { name: "回填后编辑" }).click();
    confirmation = await readyDialog(page, "替换当前草稿？");
    await confirmation
      .getByRole("button", { name: "替换草稿", exact: true })
      .click();
    await expect(
      page.getByRole("dialog", { name: "替换当前草稿？" }),
    ).not.toBeVisible();
    await expect(input).toHaveValue("我选中的文字加粗");
    await expect(input).toBeFocused();
    for (const width of [320, 380, 480, 760]) {
      await page.locator("#word-pane").evaluate((el, value) => {
        (el as HTMLElement).style.width = `${value}px`;
      }, width);
      await expect(card).toBeVisible();
      expect(
        await page
          .locator("#word-pane")
          .evaluate((el) => el.scrollWidth - el.clientWidth),
      ).toBeLessThanOrEqual(1);
      await page.screenshot({
        path: test.info().outputPath(`issue-149-failure-${width}.png`),
      });
    }
    await page.evaluate(async (origin) => {
      await fetch(`${origin}/__test/conversation-failure`, { method: "POST" });
    }, process.env["TF_CHAT_MANAGER_ORIGIN"] ?? "https://localhost:4312");
    const live = page
      .locator("[data-chat-conversation-failure]")
      .filter({ hasText: "实时运行失败" });
    await expect(live).toContainText("实时错误，尚未确认已保存");
    await expect(live.getByRole("button", { name: "回填后编辑" })).toHaveCount(
      0,
    );
    await expect(
      page.locator("[data-chat-notices] .ant-alert-error"),
    ).toHaveCount(0);
    expect(sent).toBe(0);
  });
  test("cross-UID history restores one primary user bubble and retains the transient echo for explicit review", async ({
    page,
  }) => {
    await mount(page, { platformId: 17 });
    await login(page);
    await configureUi(page, { authorMismatch: true });
    const content = `UI long text:历史作者兼容-${test.info().project.name}`;
    const primary = page.getByRole("log", { name: "对话消息", exact: true });
    await page.locator("textarea:not([aria-hidden])").fill(content);
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect(primary.getByText(content, { exact: true })).toHaveCount(1);
    await expect(
      primary.getByText("Direct browser reply", { exact: true }),
    ).toBeVisible();
    await expect(primary.getByText("Admin", { exact: false })).toBeVisible();
    await page.getByRole("button", { name: "历史对话", exact: true }).click();
    await page
      .getByRole("list", { name: "历史对话", exact: true })
      .getByRole("listitem")
      .filter({ hasText: "Manager browser fixture" })
      .getByRole("button")
      .first()
      .click();
    await expect(
      primary.getByText("Persisted private reply", { exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "历史对话", exact: true }).click();
    await page
      .getByRole("list", { name: "历史对话", exact: true })
      .getByRole("listitem")
      .filter({ hasText: content })
      .getByRole("button")
      .first()
      .click();
    await expect(primary.getByText(content, { exact: true })).toHaveCount(1);
    await expect(
      primary.getByText("Word user", { exact: false }),
    ).toBeVisible();
    await expect(primary.getByText("Admin", { exact: false })).toHaveCount(0);
    const review = page.locator("details[data-chat-unconfirmed]");
    await expect(review.locator("summary")).toHaveText("待核对消息 (1)");
    await review.locator("summary").focus();
    await page.keyboard.press("Enter");
    await expect(review.getByText(content, { exact: true })).toBeVisible();
    await expect(review.getByText("Admin", { exact: false })).toBeVisible();
    await page.screenshot({
      path: test.info().outputPath("issue-136-review-expanded.png"),
    });
    await review.locator("summary").click();
    await expect(review.getByText(content, { exact: true })).not.toBeVisible();
    await page
      .locator("textarea:not([aria-hidden])")
      .fill(`UI long text:恢复后继续-${test.info().project.name}`);
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect(
      primary.getByText("Direct browser reply", { exact: true }),
    ).toHaveCount(2);
  });

  test("elementId receipts leave sending records, merge cross-author history and preserve identical sends", async ({
    page,
  }) => {
    await mount(page, { platformId: 17 });
    await login(page);
    await configureUi(page, {
      authorMismatch: true,
      serverMessageIds: true,
      holdMessageEcho: true,
    });
    const content = `UI long text:消息身份-${test.info().project.name}`;
    const primary = page.getByRole("log", { name: "对话消息", exact: true });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route("**/messages", async (route) => {
      if (route.request().method() === "POST") await gate;
      await route.continue();
    });
    await page.locator("textarea:not([aria-hidden])").fill(content);
    await page.getByRole("button", { name: "发送", exact: true }).click();
    const outgoing = page.locator("[data-chat-outgoing]");
    await expect(
      outgoing.locator('[data-send-status="sending"]'),
    ).toContainText(content);
    await expect(primary.getByText(content, { exact: true })).toHaveCount(0);
    release();
    await expect(
      outgoing.locator('[data-send-status="accepted"]'),
    ).toContainText("已接收，等待同步");
    await expect(primary.getByText(content, { exact: true })).toHaveCount(0);
    await page.evaluate(async (origin) => {
      await fetch(`${origin}/__test/release-message-echo`, { method: "POST" });
    }, process.env["TF_CHAT_MANAGER_ORIGIN"] ?? "https://localhost:4312");
    await expect(primary.getByText(content, { exact: true })).toHaveCount(1);
    await expect(outgoing).toHaveCount(0);
    await configureUi(page, { holdMessageEcho: false });
    await page.locator("textarea:not([aria-hidden])").fill(content);
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect(primary.getByText(content, { exact: true })).toHaveCount(2);
    await page.getByRole("button", { name: "历史对话", exact: true }).click();
    await page
      .getByRole("list", { name: "历史对话", exact: true })
      .getByRole("listitem")
      .filter({ hasText: "Manager browser fixture" })
      .getByRole("button")
      .first()
      .click();
    await expect(
      primary.getByText("Persisted private reply", { exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "历史对话", exact: true }).click();
    await page
      .getByRole("list", { name: "历史对话", exact: true })
      .getByRole("listitem")
      .filter({ hasText: content })
      .getByRole("button")
      .first()
      .click();
    await expect(primary.getByText(content, { exact: true })).toHaveCount(2);
    await expect(primary.getByText("Admin", { exact: false })).toHaveCount(0);
    await expect(page.locator("details[data-chat-unconfirmed]")).toHaveCount(0);
    const continued = `${content}-继续发送`;
    await page.locator("textarea:not([aria-hidden])").fill(continued);
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect(primary.getByText(continued, { exact: true })).toHaveCount(1);
    await expect(
      primary.getByText("Direct browser reply", { exact: true }),
    ).toHaveCount(3);
    // Ant Design can retain a hidden, named loading icon after settling.
    // Accept only that decorative prefix while matching the send command,
    // then verify the previous request cleared its draft before fault injection.
    const sendAction = page.getByRole("button", {
      name: /^(?:loading\s+)?发送$/,
    });
    await expect(sendAction).toBeDisabled();
    await page.screenshot({
      path: test.info().outputPath("issue-141-identity.png"),
    });
    let failedPosts = 0;
    await page.route("**/messages", async (route) => {
      if (route.request().method() === "POST") {
        failedPosts++;
        await route.abort("failed");
      } else await route.continue();
    });
    await page
      .locator("textarea:not([aria-hidden])")
      .fill(`${content}-网络失败`);
    await sendAction.click();
    await expect(
      outgoing.locator('[data-send-status="unknown"]'),
    ).toContainText("发送结果未确认");
    await outgoing.getByRole("button", { name: "关闭发送记录" }).click();
    await expect(outgoing).toHaveCount(0);
    expect(failedPosts).toBe(1);
  });

  test("context summaries and candidate platform navigation preserve the active chat until confirmation", async ({
    page,
  }) => {
    await mount(page);
    await login(page);
    await page.getByRole("button", { name: /Word fixture/ }).click();
    await page.getByRole("button", { name: "开始对话" }).click();
    const input = page.locator("textarea:not([aria-hidden])");
    await input.fill("保留的工作空间草稿");
    await page.getByRole("button", { name: "账号与设置", exact: true }).click();
    const identity = page.getByRole("region", {
      name: "登录身份",
      exact: true,
    });
    await expect(identity).toContainText("manager-user");
    const org = page.getByRole("region", { name: "当前工作组织", exact: true });
    await expect(org).toContainText("Word 测试组织");
    await expect(org).toContainText("组织 ID");
    await expect(org).toContainText("账户: account");
    const workspace = page.getByRole("region", {
      name: "当前工作空间",
      exact: true,
    });
    await expect(workspace).toContainText("legacy");
    await expect(workspace).toContainText("Word fixture");
    await expect(workspace).toContainText("平台 ID: 17");
    await page.screenshot({
      path: test.info().outputPath("issue-135-settings.png"),
    });
    const robotSwitch = page.getByRole("button", {
      name: "切换机器人",
      exact: true,
    });
    await robotSwitch.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("button", { name: /legacy/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await page.getByRole("button", { name: /alias/ }).click();
    await page.getByRole("button", { name: "使用这个机器人" }).click();
    await expect(
      page.getByRole("heading", { name: "选择对话平台" }),
    ).toBeVisible();
    await expect(page.getByText("所选机器人: 目录 ID: alias")).toBeVisible();
    await expect(
      page.getByText("当前机器人: 目录 ID: alias"),
    ).not.toBeVisible();
    await page.getByRole("button", { name: "返回账号与设置" }).click();
    await expect(workspace).toContainText("legacy");

    await page.getByRole("button", { name: "切换组织", exact: true }).click();
    await expect(
      page.getByRole("button", { name: /Word 测试组织/ }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByText("当前使用", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "返回账号与设置" }).click();
    await configureUi(page, {
      platforms: [
        { platformId: 17, name: "Word fixture" },
        { platformId: 18, name: "备选平台" },
      ],
      platformsStatus: 500,
    });
    await page.getByRole("button", { name: "切换平台", exact: true }).click();
    await expect(
      page.getByText("加载未完成，请重试。当前工作空间未改变。"),
    ).toBeVisible();
    await page.getByRole("button", { name: "返回账号与设置" }).click();
    await expect(workspace).toContainText("Word fixture");
    await configureUi(page, { platformsStatus: 200 });
    await page.getByRole("button", { name: "切换平台", exact: true }).click();
    await page.getByRole("button", { name: /备选平台/ }).click();
    await page.getByRole("button", { name: "开始对话" }).click();
    await (
      await readyDialog(page)
    )
      .getByRole("button", { name: "取消", exact: true })
      .click();
    await expect(page.getByRole("dialog")).toBeHidden();
    await page.getByRole("button", { name: "返回账号与设置" }).click();
    await expect(workspace).toContainText("Word fixture");
    await page
      .getByRole("button", { name: "返回", exact: false })
      .first()
      .click();
    await expect(input).toHaveValue("保留的工作空间草稿");
    const platformTrigger = page.getByRole("button", {
      name: "更多操作",
      exact: true,
    });
    await platformTrigger.focus();
    await page.keyboard.press("Enter");
    await page.getByRole("menuitem", { name: "切换平台", exact: true }).click();
    await page.getByRole("button", { name: /返回对话/ }).click();
    await expect(platformTrigger).toBeFocused();
    await platformTrigger.click();
    await page.getByRole("menuitem", { name: "切换平台", exact: true }).click();
    const alternativePlatform = page.getByRole("button", { name: /备选平台/ });
    await alternativePlatform.click();
    await expect(alternativePlatform).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("button", { name: "开始对话" }).click();
    const confirmation = await readyDialog(page);
    await confirmation
      .getByRole("button", { name: "确认", exact: true })
      .click();
    await expect(confirmation).toBeHidden();
    await expect(
      page.getByRole("group", { name: "当前平台: 备选平台", exact: true }),
    ).toBeVisible();
    await expect(input).toHaveValue("");
    await expect(page.getByText("备选平台", { exact: true })).toBeVisible();
    await input.fill("UI long text:平台切换后发送");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect(
      page.getByText("Direct browser reply", { exact: true }),
    ).toBeVisible();
  });
  test("failed organization submission returns to safe login with an error and no stale context", async ({
    page,
  }) => {
    await mount(page, { platformId: 17 });
    await login(page);
    await expect(page.getByText("从一个想法开始。")).toBeVisible();
    await page.getByRole("button", { name: "账号与设置", exact: true }).click();
    await page.getByRole("button", { name: "切换组织", exact: true }).click();
    await configureUi(page, { switchAccountStatus: 500 });
    await page.getByRole("button", { name: /另一个组织/ }).click();
    await page.getByRole("button", { name: "进入组织" }).click();
    await expect(
      page.getByRole("button", { name: "登录", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("操作未完成，请重试或联系管理员。", { exact: true }),
    ).toBeVisible();
    await expect(page.locator("[data-chat-compact-workspace]")).toHaveCount(0);
    await expect(
      page.getByText("Word 测试组织", { exact: true }),
    ).not.toBeVisible();
  });

  test("long context names wrap in narrow panes; fixed platforms stay visible without a switch action", async ({
    page,
  }) => {
    await mount(page, { platformId: 17 });
    await login(page, () =>
      configureUi(page, {
        accountName: "用于窄窗格验收的超长账户名称".repeat(4),
        platforms: [
          { platformId: 17, name: "用于窄窗格验收的超长平台名称".repeat(4) },
        ],
      }),
    );
    await expect(page.getByText("从一个想法开始。")).toBeVisible();
    await page.getByRole("button", { name: "账号与设置", exact: true }).click();
    const workspace = page.getByRole("region", {
      name: "当前工作空间",
      exact: true,
    });
    await expect(workspace).toContainText("用于窄窗格验收的超长平台名称");
    await expect(workspace).toContainText("由宿主指定");
    await expect(
      page.getByRole("button", { name: "切换平台", exact: true }),
    ).toHaveCount(0);
    for (const width of [320, 380, 480, 760]) {
      await page.locator("#word-pane").evaluate((el, width) => {
        (el as HTMLElement).style.width = `${width}px`;
      }, width);
      const overflow = await page
        .locator("#word-pane")
        .evaluate((el) => el.scrollWidth - el.clientWidth);
      expect(overflow).toBeLessThanOrEqual(1);
      await expect(
        page.getByRole("button", { name: "切换组织", exact: true }),
      ).toBeInViewport();
      await page.screenshot({
        path: test.info().outputPath(`issue-135-settings-${width}.png`),
      });
    }
    await configureUi(page, { accountsStatus: 500 });
    await page.getByRole("button", { name: "切换组织", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "账号与设置", exact: true }),
    ).toBeVisible();
    await expect(workspace).toContainText("用于窄窗格验收的超长平台名称");
    await expect(page.getByRole("alert")).toBeVisible();
  });

  test("long organization and robot names remain usable in chat and selection pages", async ({
    page,
  }) => {
    await mount(page);
    await login(page, () =>
      configureUi(page, {
        organizationName: "超长工作组织名称".repeat(8),
        robotName: "超长机器人名称".repeat(8) + "legacy",
        platforms: [
          { platformId: 17, name: "超长平台名称".repeat(8) + "Word fixture" },
        ],
      }),
    );
    await page.getByRole("button", { name: /Word fixture/ }).click();
    await page.getByRole("button", { name: "开始对话" }).click();
    await page
      .locator("#word-pane")
      .evaluate((el) => ((el as HTMLElement).style.width = "320px"));
    const noOverflow = async () =>
      expect(
        await page
          .locator("#word-pane")
          .evaluate((el) => el.scrollWidth - el.clientWidth),
      ).toBeLessThanOrEqual(1);
    const input = page.locator("textarea:not([aria-hidden])");
    await expect(input).toBeInViewport();
    await noOverflow();
    for (const width of [320, 380, 480, 760]) {
      await page.locator("#word-pane").evaluate((el, width) => {
        (el as HTMLElement).style.width = `${width}px`;
      }, width);
      await noOverflow();
      const context = await page.locator(".tf-toolbar").boundingBox();
      expect(
        (await page.locator(".tf-chat-context .tf-top").boundingBox())!.height,
      ).toBeLessThanOrEqual(42);
      const toolbar = await page
        .locator("[data-chat-compact-toolbar]")
        .boundingBox();
      expect(context!.height + toolbar!.height).toBeLessThanOrEqual(76);
      await expect(input).toBeInViewport();
    }
    await page.locator(".tf-robot-summary").hover();
    await expect(
      page.getByRole("tooltip").filter({ hasText: "超长机器人名称" }),
    ).toContainText("超长机器人名称".repeat(8) + "legacy");
    await page.locator(".tf-platform-context").hover();
    await expect(
      page.getByRole("tooltip").filter({ hasText: "超长平台名称" }),
    ).toContainText("超长平台名称".repeat(8) + "Word fixture");
    await page.locator(".tf-organization-summary").hover();
    await expect(
      page.getByRole("tooltip").filter({ hasText: "超长工作组织名称" }),
    ).toContainText("超长工作组织名称".repeat(8));
    const orgTrigger = page.getByRole("button", {
      name: "账号与设置",
      exact: true,
    });
    await orgTrigger.focus();
    await page.keyboard.press("Enter");
    await page.getByRole("button", { name: "切换组织", exact: true }).click();
    await noOverflow();
    await page
      .getByRole("button", { name: "返回账号与设置", exact: false })
      .click();
    await page.getByRole("button", { name: /^← 返回$/ }).click();
    await expect(orgTrigger).toBeFocused();
    const robotTrigger = page.getByRole("button", {
      name: "更多操作",
      exact: true,
    });
    await robotTrigger.focus();
    await page.keyboard.press("Enter");
    await page
      .getByRole("menuitem", { name: "切换机器人", exact: true })
      .click();
    await noOverflow();
    await expect(
      page.getByRole("button", { name: /超长机器人/ }),
    ).toBeVisible();
    await page.getByRole("button", { name: /返回对话/ }).click();
    await expect(robotTrigger).toBeFocused();
    const platformTrigger = robotTrigger;
    await platformTrigger.focus();
    await page.keyboard.press("Enter");
    await page.getByRole("menuitem", { name: "切换平台", exact: true }).click();
    await noOverflow();
    await expect(
      page.getByRole("button", { name: "开始对话" }),
    ).toBeInViewport();
    await page.getByRole("button", { name: /返回对话/ }).click();
    await expect(platformTrigger).toBeFocused();
    const message = "UI long text:" + "超长会话标题".repeat(12);
    await input.fill(message);
    await expect(
      page.getByRole("button", { name: "发送", exact: true }),
    ).toBeInViewport();
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect(
      page.getByText("Direct browser reply", { exact: true }),
    ).toBeVisible();
    await page.locator("#word-pane").evaluate((el) => {
      (el as HTMLElement).style.width = "320px";
    });
    await noOverflow();
    await page.locator("[data-chat-compact-toolbar] .ant-typography").hover();
    await expect(
      page.getByRole("tooltip").filter({ hasText: message.slice(0, 60) }),
    ).toHaveText(message.slice(0, 60));
  });

  test("legacy unconfigured platform is described accurately", async ({
    page,
  }) => {
    await mount(page, { conversationContract: "query-v1" });
    await login(page);
    await expect(page.getByText("从一个想法开始。")).toBeVisible();
    await expect(
      page.getByText("此接入未提供平台选择", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("由宿主指定", { exact: true }),
    ).not.toBeVisible();
  });

  test("missing context names use labelled identifier fallbacks consistently", async ({
    page,
  }) => {
    await mount(page);
    await login(page, () =>
      configureUi(page, {
        robotName: "",
        organizationName: "",
        platforms: [{ platformId: 17, name: "" }],
      }),
    );
    await page.getByRole("button", { name: /平台 ID: 17/ }).click();
    await page.getByRole("button", { name: "开始对话" }).click();
    await expect(
      page.getByLabel("当前机器人: 目录 ID: legacy", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("group", { name: /当前工作组织: 组织 ID: org/ }),
    ).toBeVisible();
    await page.getByRole("button", { name: "账号与设置", exact: true }).click();
    const workspace = page.getByRole("region", {
      name: "当前工作空间",
      exact: true,
    });
    await expect(workspace).toContainText("目录 ID: legacy");
    await expect(workspace).toContainText("机器人 ID: robot-a");
    await expect(workspace).toContainText("平台 ID: 17");
    await page.getByRole("button", { name: "切换机器人", exact: true }).click();
    await expect(
      page.getByRole("button", { name: /目录 ID: legacy.*机器人 ID: robot-a/ }),
    ).toBeVisible();
  });

  test("default Word UI: actual login, explicit account/platform, first send, Socket reply, history, drafts and logout", async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const writes: string[] = [];
    const createBodies: unknown[] = [];
    page.on("request", (req) => {
      if (req.method() === "POST" && /\/conversations$/.test(req.url())) {
        writes.push(req.url());
        createBodies.push(req.postDataJSON());
      }
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
    await expect(page.getByRole("textbox", { name: "对话名称" })).toHaveCount(
      0,
    );
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
    expect(createBodies).toEqual([
      { title: "Browser round trip", platformId: 17 },
    ]);
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
    await expect(page.getByRole("dialog")).not.toBeVisible();
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
    await page.getByRole("button", { name: "更多操作", exact: true }).click();
    await page
      .getByRole("menuitem", { name: "切换机器人", exact: true })
      .click();
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
