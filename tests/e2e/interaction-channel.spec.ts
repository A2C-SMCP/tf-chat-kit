import path from "node:path";

import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from "@playwright/test";

const MANAGER =
  process.env["TF_CHAT_MANAGER_ORIGIN"] ?? "http://127.0.0.1:4312";
const HARNESS = `/@fs/${path.resolve(
  "tests/e2e/fixtures/interaction-channel.ts",
)}`;
const CONVERSATION_ID = "conversation-contract";

const interaction = (
  interactionId: string,
  question: string,
  expiresAt: number,
  conversationId = CONVERSATION_ID,
) => ({
  protocolVersion: 1,
  interactionId,
  conversationId,
  conversationTitle: "E2E conversation",
  robotId: "robot-a",
  namespace: "/remote-tool",
  requester: { id: "user-1", name: "Alice" },
  target: { id: "user-2", kind: "human", name: "Bob" },
  question,
  options: [
    { label: "Yes", value: "yes" },
    { label: "No", value: "no" },
  ],
  multiSelect: false,
  timeoutSeconds: 30,
  expiresAt,
});

const mount = async (page: Page): Promise<void> => {
  await page.goto("/");
  await page.evaluate(
    async ({ entry, origin }) => {
      const harness = await import(/* @vite-ignore */ entry);
      await harness.mount({ origin });
    },
    { entry: HARNESS, origin: MANAGER },
  );
};

const reset = async (request: APIRequestContext): Promise<void> => {
  await request.post(`${MANAGER}/__test/interaction-reset`);
};

const waitForReady = async (
  request: APIRequestContext,
  count: number,
): Promise<void> => {
  await expect
    .poll(async () => {
      const state = await (
        await request.get(`${MANAGER}/__test/interaction-state`)
      ).json();
      return state.connections >= count && state.hellos.length >= count
        ? count
        : 0;
    })
    .toBe(count);
};

test.describe("Interaction channel UI", () => {
  test.beforeEach(async ({ request }) => {
    await reset(request);
  });

  test("two tabs receive the same question and the first answer closes both", async ({
    browser,
    page,
    request,
  }) => {
    const secondContext = await browser.newContext();
    const secondPage = await secondContext.newPage();
    try {
      await mount(page);
      await mount(secondPage);
      await waitForReady(request, 2);
      await request.post(`${MANAGER}/__test/interaction-request`, {
        data: {
          interaction: interaction("e2e-1", "Deploy now?", Date.now() + 30_000),
        },
      });
      await expect(page.getByText("Deploy now?")).toBeVisible();
      await expect(secondPage.getByText("Deploy now?")).toBeVisible();
      await page.locator('input[value="yes"]').check();
      await page.getByRole("button", { name: "Submit answers" }).click();
      await expect(page.getByText("Deploy now?")).toHaveCount(0);
      await expect(secondPage.getByText("Deploy now?")).toHaveCount(0);
      const state = await (
        await request.get(`${MANAGER}/__test/interaction-state`)
      ).json();
      expect(state.responses).toHaveLength(1);
      expect(state.responses[0]).toMatchObject({
        interactionId: "e2e-1",
        selectedOptions: ["yes"],
        status: "answered",
      });
    } finally {
      await secondContext.close();
    }
  });

  test("renders an interaction for another conversation in the global modal", async ({
    page,
    request,
  }) => {
    await mount(page);
    await waitForReady(request, 1);
    await request.post(`${MANAGER}/__test/interaction-request`, {
      data: {
        interaction: interaction(
          "modal-1",
          "Modal question",
          Date.now() + 30_000,
          "another-conversation",
        ),
      },
    });
    await expect(page.getByText("Modal question")).toBeVisible();
    await page.locator('input[value="yes"]').check();
    await page.getByRole("button", { name: "Submit answers" }).click();
    await expect(page.getByText("Modal question")).toHaveCount(0);
    const state = await (
      await request.get(`${MANAGER}/__test/interaction-state`)
    ).json();
    expect(state.responses).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          interactionId: "modal-1",
          status: "answered",
        }),
      ]),
    );
  });

  test("early frames and reconnect pending snapshots keep the question visible", async ({
    page,
    request,
  }) => {
    const early = interaction("early-1", "Early question", Date.now() + 30_000);
    await request.post(`${MANAGER}/__test/interaction-options`, {
      data: { earlyInteraction: early, pendingOnConnect: [early] },
    });
    await mount(page);
    await waitForReady(request, 1);
    await expect(page.getByText("Early question")).toBeVisible();
    await request.post(`${MANAGER}/__test/interaction-disconnect`);
    await expect
      .poll(async () => {
        const state = await (
          await request.get(`${MANAGER}/__test/interaction-state`)
        ).json();
        return state.connections;
      })
      .toBeGreaterThanOrEqual(2);
    await expect(page.getByText("Early question")).toBeVisible();
    await expect(page.locator('input[value="yes"]')).toBeEnabled();
  });

  test("runtime EDF selection and the 10-item queue bound are reflected", async ({
    page,
    request,
  }) => {
    await mount(page);
    await waitForReady(request, 1);
    const now = Date.now();
    const interactions = Array.from({ length: 12 }, (_, index) =>
      interaction(
        `edf-${index}`,
        `Question ${index}`,
        now + 30_000 + index * 1_000,
      ),
    );
    await request.post(`${MANAGER}/__test/interaction-requests`, {
      data: { interactions },
    });
    await expect(page.getByText("Question 0")).toBeVisible();
    await expect(page.getByTestId("interaction-queue-badge")).toHaveAttribute(
      "aria-label",
      /\(9\)/,
    );
  });

  test("timeout removes a short-lived question", async ({ page, request }) => {
    await mount(page);
    await waitForReady(request, 1);
    await request.post(`${MANAGER}/__test/interaction-request`, {
      data: {
        interaction: interaction(
          "timeout-1",
          "Short question",
          Date.now() + 1_500,
        ),
      },
    });
    await expect(page.getByText("Short question")).toBeVisible();
    await expect(page.getByText("Short question")).toHaveCount(0, {
      timeout: 10_000,
    });
  });

  test("cancel closes the question and the server records a cancellation", async ({
    page,
    request,
  }) => {
    await mount(page);
    await waitForReady(request, 1);
    await request.post(`${MANAGER}/__test/interaction-request`, {
      data: {
        interaction: interaction(
          "cancel-1",
          "Cancel question",
          Date.now() + 30_000,
        ),
      },
    });
    await expect(page.getByText("Cancel question")).toBeVisible();
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(page.getByText("Cancel question")).toHaveCount(0);
    const state = await (
      await request.get(`${MANAGER}/__test/interaction-state`)
    ).json();
    expect(state.responses).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          interactionId: "cancel-1",
          status: "cancelled",
        }),
      ]),
    );
  });

  test("the interaction-only client does not register a legacy adapter", async ({
    page,
    request,
  }) => {
    await mount(page);
    await waitForReady(request, 1);
    const state = await (
      await request.get(`${MANAGER}/__test/interaction-state`)
    ).json();
    expect(state.registerCalls).toBe(0);
    expect(state.hellos).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          protocolVersion: 1,
          supportsAskUserAdapter: false,
        }),
      ]),
    );
  });
});
