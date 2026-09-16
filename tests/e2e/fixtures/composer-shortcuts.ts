import { createElement } from "react";
import { createRoot } from "react-dom/client";
import {
  ChatProvider,
  ChatWorkspace,
  createChatClient,
  type ChatComposerSendShortcut,
} from "../../../packages/chat-kit/src/index.js";
import { createMemoryChatGateway } from "../../../packages/chat-testing/src/index.js";

/** A non-Front host consuming the public workspace entry in an actual browser. */
export const mountShortcutWorkspace = async () => {
  const memory = createMemoryChatGateway();
  const client = createChatClient({ gateway: memory.gateway });
  const element = document.createElement("div");
  element.id = "shortcut-workspace";
  Object.assign(element.style, {
    position: "fixed",
    inset: "0",
    zIndex: "10000",
    background: "white",
  });
  document.body.append(element);
  const root = createRoot(element);
  const render = (sendShortcut?: ChatComposerSendShortcut) =>
    root.render(
      createElement(
        ChatProvider,
        { client },
        createElement(ChatWorkspace, {
          getDeadlineAt: () => Date.now() + 10000,
          conversationViewProps: { sendShortcut },
        }),
      ),
    );
  render();
  return {
    setMode: render,
    getSent: () =>
      memory.controller.calls.flatMap((call) =>
        call.operation === "sendText" ? [call.input.text] : [],
      ),
    async dispose() {
      root.unmount();
      element.remove();
      await client.dispose({ deadlineAt: Date.now() + 10000 });
    },
  };
};

let active: Awaited<ReturnType<typeof mountShortcutWorkspace>> | undefined;
export const mount = async () => {
  await active?.dispose();
  active = await mountShortcutWorkspace();
};
export const setMode = (mode: ChatComposerSendShortcut) =>
  active?.setMode(mode);
export const getSent = () => active?.getSent() ?? [];
export const dispose = async () => {
  await active?.dispose();
  active = undefined;
};
