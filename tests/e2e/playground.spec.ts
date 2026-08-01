import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from "@playwright/test";
import { io as connectSocket } from "socket.io-client";

const ROBOTSERVER = "http://localhost:4310";
const ORIGIN_HEADERS = { Origin: "http://localhost:3000" };

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
    readonly joins: number;
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
  auth: "admin" | "bearer",
  credential: string,
) => {
  await page.getByRole("button", { name: "RobotServer mode" }).click();
  await page.getByLabel("HTTP base URL").fill(`${ROBOTSERVER}/`);
  await page.getByLabel("Socket namespace URL").fill(`${ROBOTSERVER}/chat`);
  await page.getByLabel("Socket path").fill("/socket.io");
  await page.getByLabel("platformId").fill("platform-e2e");
  await page.getByLabel("Creator ID").fill("developer-e2e");
  await page.getByLabel("Creator name").fill("Playwright developer");
  if (auth === "admin") {
    await page.getByRole("radio", { name: "Admin Key" }).check();
  }
  await page
    .locator(
      `input[aria-label="${auth === "bearer" ? "Bearer Token" : "Admin Key"}"]`,
    )
    .fill(credential);
  await page.getByRole("button", { name: "Connect in real mode" }).click();
};

const socketRejection = async (auth: Record<string, string>) =>
  new Promise<number | undefined>((resolve, reject) => {
    const socket = connectSocket(`${ROBOTSERVER}/chat`, {
      auth,
      extraHeaders: ORIGIN_HEADERS,
      path: "/socket.io",
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
  page.getByLabel("Message").locator("..").getByRole("button");

test.beforeEach(async ({ request }) => {
  await request.post(`${ROBOTSERVER}/__test/reset`);
});

test("Mock mode renders and exercises the formal Runtime scenarios", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Chat Kit Playground" }),
  ).toBeVisible();
  await expect(
    page.getByText("PRIVATE LOCAL APP · MEMORY GATEWAY"),
  ).toBeVisible();
  await expect(
    page.getByText("Welcome to the local Chat Kit playground."),
  ).toBeVisible();

  await page.getByLabel("New conversation title").fill("Browser conversation");
  await page.getByRole("button", { name: "Create conversation" }).click();
  await expect(page.getByText("Browser conversation").first()).toBeVisible();
  await page.getByLabel("Message").fill("Browser mock message");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByText("Browser mock message")).toBeVisible();
  await expect(
    page.getByText(
      "Streaming complete. The formal Runtime applied each update.",
    ),
  ).toBeVisible();

  await page.getByRole("button", { name: "Stream reply" }).click();
  await expect(page.getByText("Thinking…")).toBeVisible();
  await page.getByRole("button", { name: "Interrupt run" }).click();
  await expect(page.getByText("Active run interrupted.")).toBeVisible();
  await page.getByRole("button", { name: "Server error" }).click();
  await expect(
    page.getByText("Mock RobotServer rejected the active scenario."),
  ).toBeVisible();

  await page.getByRole("button", { name: "Contract conversation" }).click();
  await expect(
    page.getByText("Welcome to the local Chat Kit playground."),
  ).toBeVisible();
  await page.getByRole("button", { name: "Disconnect" }).click();
  await expect(page.locator(".playground-hero .ant-tag")).toHaveText(
    "Disconnected",
  );
  await page.getByRole("button", { name: "Reconnect" }).click();
  await expect(page.locator(".playground-hero .ant-tag")).toHaveText(
    "Connected",
  );
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
  await expect(
    page.getByText("PRIVATE LOCAL APP · TFROBOT GATEWAY"),
  ).toBeVisible();
  await expect(
    page.getByText("RobotServer fixture conversation").first(),
  ).toBeVisible();

  await page
    .getByRole("button", { name: "Create retained test session" })
    .click();
  await expect(
    page
      .getByText(
        /^\[tf-chat-kit playground\] \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/u,
      )
      .first(),
  ).toBeVisible();
  const messageInput = page.getByLabel("Message");
  const sendButton = composerSendButton(page);
  await messageInput.fill("Browser real message");
  await sendButton.click();
  await expect(
    page.getByText("RobotServer streamed: Browser real message"),
  ).toBeVisible();
  await expect(page.getByText("running", { exact: true })).toBeVisible();
  await expect(page.getByText("running", { exact: true })).toBeHidden();
  await expect(messageInput).toHaveValue("");
  await expect(sendButton).not.toHaveClass(/ant-btn-loading/u);

  await messageInput.fill("Interrupt this answer");
  await expect(sendButton).toBeEnabled();
  await sendButton.click();
  await expect(page.getByText("running", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Interrupt active run" }).click();
  await expect(
    page.getByText("RobotServer interrupt request accepted."),
  ).toBeVisible();
  await page.getByRole("button", { name: "Reconnect REST and Socket" }).click();
  await expect(page.locator(".playground-hero .ant-tag")).toHaveText(
    "Connected",
  );

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
  await page.getByRole("button", { name: "Mock mode" }).click();
  await expect(
    page.getByText("PRIVATE LOCAL APP · MEMORY GATEWAY"),
  ).toBeVisible();
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
  await expect(
    page.getByText("PRIVATE LOCAL APP · TFROBOT GATEWAY"),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByText("PRIVATE LOCAL APP · MEMORY GATEWAY"),
  ).toBeVisible();
  await expect(page.getByLabel("Bearer Token")).toHaveCount(0);
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
      /^\[tf-chat-kit playground\] \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/u.test(
        title,
      ),
    ),
  ).toBe(true);
  expect(state.observations).toMatchObject({
    activeSockets: 0,
    adminRequests: 0,
    interrupts: 1,
    invalidOrigins: 0,
  });
  expect(state.observations.bearerRequests).toBeGreaterThan(0);
  expect(state.observations.contentTypeRequests).toBeGreaterThan(0);
  expect(state.observations.corsPreflights).toBeGreaterThan(0);
  expect(state.observations.joins).toBeGreaterThanOrEqual(3);
  expect(state.observations.socketDisconnections).toBeGreaterThanOrEqual(3);
});

test("Admin mode forwards admin_key to REST and Socket without Bearer fallback", async ({
  page,
  request,
}) => {
  await page.goto("/");
  await fillConnection(page, "admin", "admin-good");
  await expect(page.locator(".playground-hero .ant-tag")).toHaveText(
    "Connected",
  );
  const state = await stateOf(request);
  expect(state.observations.adminRequests).toBeGreaterThan(0);
  expect(state.observations.bearerRequests).toBe(0);
  expect(state.observations.socketConnections).toBeGreaterThan(0);
});
