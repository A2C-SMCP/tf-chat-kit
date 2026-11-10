import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

import {
  createTFRobotInteractionClient,
  type InteractionClient,
} from "@turingfocus/chat-kit/headless";
import { ChatProvider, InteractionProvider } from "@turingfocus/chat-react";
import type { ChatClient } from "@turingfocus/chat-runtime";
import {
  ChatConversationView,
  InteractionQueue,
} from "@turingfocus/chat-ui-antd";

import { createLoadedClient } from "../../support/chat-react.js";

export interface InteractionHarnessOptions {
  readonly origin: string;
  readonly robotId?: string | undefined;
}

interface ActiveHarness {
  readonly chat: ChatClient;
  readonly container: HTMLDivElement;
  readonly conversationId: string;
  readonly interaction: InteractionClient;
  readonly root: Root;
}

let active: ActiveHarness | undefined;

export const dispose = (): void => {
  if (active === undefined) return;
  const current = active;
  active = undefined;
  current.root.unmount();
  current.container.remove();
  current.interaction.dispose();
  void current.chat.dispose({ deadlineAt: Date.now() + 5_000 });
};

/** Mounts the real Interaction client against the controlled /remote-tool server. */
export const mount = async (
  options: InteractionHarnessOptions,
): Promise<string> => {
  dispose();
  const { client: chat, memory } = await createLoadedClient();
  const robotId = options.robotId ?? "robot-a";
  const socketPath =
    robotId === "robot-b"
      ? "/c/tfrobot/robot-b/socket.io/"
      : "/c/tfrobot/tenant/robot-a/socket.io/";
  const interaction = createTFRobotInteractionClient({
    baseUrl: options.origin,
    socketPath,
    robotId,
    sessionProvider: {
      getSession: async () => ({ kind: "bearer", token: "tool-browser" }),
    },
    connectionTimeoutMs: 5_000,
  });
  const conversationId = memory.fixtures.conversation.id;
  const container = document.createElement("div");
  container.id = "interaction-e2e-harness";
  container.style.cssText =
    "position:fixed;inset:0;z-index:10;background:#fff;overflow:auto;padding:16px;";
  document.body.append(container);
  const root = createRoot(container);
  root.render(
    createElement(
      ChatProvider,
      { client: chat },
      createElement(
        InteractionProvider,
        { client: interaction },
        createElement(ChatConversationView, {
          getDeadlineAt: () => Date.now() + 30_000,
          interactionInline: true,
        }),
        createElement(InteractionQueue, {
          inlineConversationId: conversationId,
        }),
      ),
    ),
  );
  active = { chat, container, conversationId, interaction, root };
  Reflect.set(window, "__interactionHarness", {
    conversationId,
    dispose,
    getInteractionSnapshot: () => interaction.getSnapshot(),
  });
  return conversationId;
};
