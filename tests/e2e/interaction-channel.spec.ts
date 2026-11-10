import { expect, test } from "@playwright/test";
import { io, type Socket } from "socket.io-client";

import {
  MANAGER,
  interaction,
  mount,
  reset,
  waitForReady,
} from "./fixtures/interaction-channel-helpers.js";

const SOCKET_PATH = "/c/tfrobot/tenant/robot-a/socket.io/";

const openInteractionSocket = (): {
  readonly connected: Promise<void>;
  readonly pending: Promise<{ readonly interactions: unknown[] }>;
  readonly socket: Socket;
} => {
  const socket = io(`${MANAGER}/remote-tool`, {
    auth: { token: "tool-browser" },
    path: SOCKET_PATH,
    reconnection: false,
    transports: ["websocket"],
  });
  return {
    connected: new Promise<void>((resolve, reject) => {
      socket.once("connect", () => resolve());
      socket.once("connect_error", reject);
    }),
    pending: new Promise((resolve) =>
      socket.once("interaction_pending", resolve),
    ),
    socket,
  };
};

test.describe("Interaction channel UI", () => {
  test.beforeEach(async ({ request }) => {
    await reset(request);
  });

  test("the controlled server validates responses and never resurrects an answered item", async ({
    request,
  }) => {
    const first = openInteractionSocket();
    await first.connected;
    try {
      const invalidAck = await new Promise<unknown>((resolve) => {
        first.socket.timeout(2_000).emit(
          "interaction_response",
          {
            protocolVersion: 1,
            interactionId: "invalid-1",
            status: "answered",
            answer: 42,
          },
          (error: unknown, ack: unknown) => resolve(error ?? ack),
        );
      });
      expect(invalidAck).toMatchObject({ status: "unknown_request" });

      const pendingInteraction = interaction(
        "server-validated-1",
        "Server validation question",
        Date.now() + 30_000,
      );
      await request.post(`${MANAGER}/__test/interaction-options`, {
        data: { pendingOnConnect: [pendingInteraction] },
      });
      const accepted = await new Promise<unknown>((resolve) => {
        first.socket.timeout(2_000).emit(
          "interaction_response",
          {
            protocolVersion: 1,
            interactionId: "server-validated-1",
            status: "answered",
            selectedOptions: ["yes"],
          },
          (error: unknown, ack: unknown) => resolve(error ?? ack),
        );
      });
      expect(accepted).toMatchObject({ status: "accepted" });
      const after = await (
        await request.get(`${MANAGER}/__test/interaction-state`)
      ).json();
      expect(after.responses).toEqual([
        expect.objectContaining({ interactionId: "server-validated-1" }),
      ]);
      expect(after.pending).toEqual([]);
    } finally {
      first.socket.disconnect();
    }

    const second = openInteractionSocket();
    await second.connected;
    try {
      expect(await second.pending).toMatchObject({ interactions: [] });
      const unknownAck = await new Promise<unknown>((resolve) => {
        second.socket.timeout(2_000).emit(
          "interaction_response",
          {
            protocolVersion: 1,
            interactionId: "missing-1",
            status: "answered",
          },
          (error: unknown, ack: unknown) => resolve(error ?? ack),
        );
      });
      expect(unknownAck).toMatchObject({ status: "unknown_request" });
    } finally {
      second.socket.disconnect();
    }
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
