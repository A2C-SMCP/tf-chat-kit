import { expect, test } from "@playwright/test";

import {
  CONVERSATION_ID,
  MANAGER,
  interaction,
  mount,
  reset,
  waitForReady,
} from "./fixtures/interaction-channel-helpers.js";

test.use({ browserName: "webkit" });

test.describe("Interaction channel UI (WebKit)", () => {
  test.beforeEach(async ({ request }) => {
    await reset(request);
  });

  test("two WebKit contexts receive the question and the first answer closes both", async ({
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
          interaction: interaction(
            "webkit-multi-1",
            "WebKit deploy?",
            Date.now() + 30_000,
          ),
        },
      });
      await expect(page.getByText("WebKit deploy?")).toBeVisible();
      await expect(secondPage.getByText("WebKit deploy?")).toBeVisible();
      await page.locator('input[value="yes"]').check();
      await page.getByRole("button", { name: "Submit answers" }).click();
      await expect(page.getByText("WebKit deploy?")).toHaveCount(0);
      await expect(secondPage.getByText("WebKit deploy?")).toHaveCount(0);
      const state = await (
        await request.get(`${MANAGER}/__test/interaction-state`)
      ).json();
      expect(state.responses).toHaveLength(1);
      expect(state.responses[0]).toMatchObject({
        interactionId: "webkit-multi-1",
        selectedOptions: ["yes"],
        status: "answered",
      });
    } finally {
      await secondContext.close();
    }
  });

  test("switches from the inline card to the global modal in WebKit", async ({
    page,
    request,
  }) => {
    await mount(page);
    await waitForReady(request, 1);
    await request.post(`${MANAGER}/__test/interaction-request`, {
      data: {
        interaction: interaction(
          "webkit-inline-1",
          "WebKit inline question",
          Date.now() + 30_000,
          CONVERSATION_ID,
        ),
      },
    });
    await expect(
      page.locator('[data-interaction-id="webkit-inline-1"]'),
    ).toBeVisible();
    await expect(
      page.locator('.ant-modal [data-interaction-id="webkit-inline-1"]'),
    ).toHaveCount(0);
    await page.locator('input[value="yes"]').check();
    await page.getByRole("button", { name: "Submit answers" }).click();
    await expect(
      page.locator('[data-interaction-id="webkit-inline-1"]'),
    ).toHaveCount(0);

    await request.post(`${MANAGER}/__test/interaction-request`, {
      data: {
        interaction: interaction(
          "webkit-modal-1",
          "WebKit modal question",
          Date.now() + 30_000,
          "another-conversation",
        ),
      },
    });
    await expect(
      page.locator('.ant-modal [data-interaction-id="webkit-modal-1"]'),
    ).toBeVisible();
    await page.locator('input[value="yes"]').check();
    await page.getByRole("button", { name: "Submit answers" }).click();
    await expect(page.getByText("WebKit modal question")).toHaveCount(0);
    const state = await (
      await request.get(`${MANAGER}/__test/interaction-state`)
    ).json();
    expect(state.responses).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          interactionId: "webkit-modal-1",
          status: "answered",
        }),
      ]),
    );
  });
});
