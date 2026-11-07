import { createElement } from "react";
import { createRoot } from "react-dom/client";
import {
  ChatProvider,
  ChatWorkspace,
  createChatClient,
} from "../../../packages/chat-kit/src/index.js";
import { createMemoryChatGateway } from "../../../packages/chat-testing/src/index.js";

let active: { emitError(): void; dispose(): Promise<void> } | undefined;

/** Isolated UI consumer; no dependency on the Playground's connection workflow. */
export async function mount() {
  await dispose();
  const memory = createMemoryChatGateway();
  const client = createChatClient({ gateway: memory.gateway });
  const element = document.createElement("div");
  element.id = "diagnostics-workspace";
  Object.assign(element.style, {
    position: "fixed",
    inset: "0",
    zIndex: "1",
    background: "white",
  });
  document.body.append(element);
  const root = createRoot(element);
  root.render(
    createElement(
      ChatProvider,
      { client },
      createElement(ChatWorkspace, {
        getDeadlineAt: () => Date.now() + 10000,
        conversationViewProps: { debug: true },
      }),
    ),
  );
  active = {
    emitError() {
      const conversationId = client.getSnapshot()?.conversation.id;
      if (conversationId === undefined)
        throw new Error("Workspace has not loaded");
      memory.controller.emitError({
        code: "server",
        message: "Diagnostic fixture failure",
        retryable: true,
        conversationId,
      });
    },
    async dispose() {
      root.unmount();
      element.remove();
      await client.dispose({ deadlineAt: Date.now() + 10000 });
    },
  };
}
export const emitError = () => active?.emitError();
export async function dispose() {
  await active?.dispose();
  active = undefined;
}
