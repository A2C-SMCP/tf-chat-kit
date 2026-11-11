import path from "node:path";

import { expect, type APIRequestContext, type Page } from "@playwright/test";

export const MANAGER =
  process.env["TF_CHAT_MANAGER_ORIGIN"] ?? "http://127.0.0.1:4312";
export const HARNESS = `/@fs/${path.resolve(
  "tests/e2e/fixtures/interaction-channel.ts",
)}`;
export const CONVERSATION_ID = "conversation-contract";

export const interaction = (
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

export const mount = async (page: Page): Promise<void> => {
  await page.goto("/");
  await page.evaluate(
    async ({ entry, origin }) => {
      const harness = await import(/* @vite-ignore */ entry);
      await harness.mount({ origin });
    },
    { entry: HARNESS, origin: MANAGER },
  );
};

export const reset = async (request: APIRequestContext): Promise<void> => {
  await request.post(`${MANAGER}/__test/interaction-reset`);
};

export const waitForReady = async (
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
