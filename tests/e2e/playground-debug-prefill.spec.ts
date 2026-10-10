import { expect, test, type Page } from "@playwright/test";

const prefillPath = "/__tf_chat_playground/robotserver-prefill";
const openPanel = async (page: Page) => {
  await page.goto("/");
  await page.getByRole("button", { name: "进入 Chat Kit" }).click();
  await page.getByRole("button", { name: "RobotServer 模式" }).click();
  await expect(
    page.getByRole("heading", { name: "连接 RobotServer" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Manager 一键连接", exact: true }),
  ).toHaveCount(0);
};

test("manual panel starts empty when no debug configuration exists", async ({
  page,
}) => {
  await page.route(`**${prefillPath}`, (route) =>
    route.fulfill({ status: 204 }),
  );
  await openPanel(page);
  for (const label of [
    "RobotServer 服务地址",
    "Namespace",
    "Robot ID",
    "管理员密码",
  ]) {
    await expect(page.locator(`input[aria-label="${label}"]`)).toHaveValue("");
  }
});

test("development debug configuration still prefills the manual panel in memory", async ({
  page,
}) => {
  await page.route(`**${prefillPath}`, (route) =>
    route.fulfill({
      json: {
        serverOrigin: "http://localhost:4310",
        namespace: "synthetic-ns",
        robotId: "synthetic-robot",
        authKind: "admin",
        secret: "synthetic-debug-only",
      },
    }),
  );
  await openPanel(page);
  await expect(
    page.getByLabel("RobotServer 服务地址", { exact: true }),
  ).toHaveValue("http://localhost:4310");
  await expect(page.getByLabel("Namespace", { exact: true })).toHaveValue(
    "synthetic-ns",
  );
  await expect(page.getByLabel("Robot ID", { exact: true })).toHaveValue(
    "synthetic-robot",
  );
  await expect(page.locator('input[aria-label="Admin Token"]')).toHaveValue(
    "synthetic-debug-only",
  );
  const state = await page.evaluate(() =>
    JSON.stringify({
      local: { ...localStorage },
      session: { ...sessionStorage },
      cookie: document.cookie,
      url: location.href,
    }),
  );
  expect(state).not.toContain("synthetic-debug-only");
});

test("invalid debug configuration shows a warning that manual editing clears", async ({
  page,
}) => {
  await page.route(`**${prefillPath}`, (route) =>
    route.fulfill({ json: { namespace: 7 } }),
  );
  await openPanel(page);
  await expect(
    page.getByText("本地 .debug 预填配置格式无效。", { exact: true }),
  ).toBeVisible();
  await page.getByLabel("Namespace", { exact: true }).fill("manual-ns");
  await expect(
    page.getByText("本地 .debug 预填配置格式无效。", { exact: true }),
  ).toHaveCount(0);
});

test("late debug configuration does not replace manual input", async ({
  page,
}) => {
  let release!: () => void;
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(`**${prefillPath}`, async (route) => {
    started();
    await held;
    await route.fulfill({
      json: {
        serverOrigin: "http://localhost:4310",
        namespace: "late-ns",
        robotId: "late-robot",
      },
    });
  });
  try {
    await openPanel(page);
    await ready;
    await page
      .getByLabel("RobotServer 服务地址", { exact: true })
      .fill("http://manual.example.test");
    const response = page.waitForResponse((candidate) =>
      candidate.url().endsWith(prefillPath),
    );
    release();
    await (await response).finished();
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    await expect(
      page.getByLabel("RobotServer 服务地址", { exact: true }),
    ).toHaveValue("http://manual.example.test");
    await expect(page.getByLabel("Namespace", { exact: true })).toHaveValue("");
    await expect(page.getByLabel("Robot ID", { exact: true })).toHaveValue("");
  } finally {
    release();
  }
});
