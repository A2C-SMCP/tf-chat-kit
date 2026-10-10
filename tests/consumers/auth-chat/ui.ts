import { createElement } from "react";
import type { AuthStatusProps } from "@turingfocus/chat-auth/antd";
import { setupDom, check } from "../auth-common.js";
import { runAuthChatConsumerVerification } from "./consumer.js";

export const runAuthChatUiConsumerVerification = async (): Promise<void> => {
  const dom = setupDom();
  const { createRoot } = await import("react-dom/client");
  const { act } = await import("react-dom/test-utils");
  const { AuthProvider } = await import("@turingfocus/chat-auth/react");
  const { AuthStatus } = await import("@turingfocus/chat-auth/antd");
  const { ChatProvider, ChatConversationView } =
    await import("@turingfocus/chat-kit/antd");
  const root = createRoot(dom.container);
  try {
    await runAuthChatConsumerVerification({
      render: async (auth, chat) => {
        await act(async () => {
          root.render(
            createElement(
              AuthProvider,
              { client: auth },
              createElement<AuthStatusProps>(AuthStatus, { showLogout: false }),
              createElement(
                ChatProvider,
                { client: chat, key: auth.getSnapshot().account?.accountId },
                createElement(ChatConversationView, {
                  getDeadlineAt: () => Date.now() + 8_000,
                }),
              ),
            ),
          );
        });
        check(
          !dom.container.innerHTML.includes("packed-fixture"),
          "Credential appeared in authenticated chat DOM",
        );
        if (auth.getSnapshot().account?.accountId === "b") {
          check(
            !dom.container.textContent?.includes("History a"),
            "Previous account remained in the chat UI",
          );
        }
      },
      assertText: (text) =>
        check(
          dom.container.textContent?.includes(text),
          "Authenticated chat UI did not render server content",
        ),
      close: async () => {
        await act(async () => root.unmount());
      },
    });
  } finally {
    dom.close();
  }
};
