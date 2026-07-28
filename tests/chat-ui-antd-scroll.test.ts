// @vitest-environment jsdom

import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, expect, it } from "vitest";

import type { Message } from "../packages/chat-protocol/src/index.js";

import { ChatTimeline } from "../packages/chat-ui-antd/src/index.js";

const message = (id: string, text = id): Message => ({
  kind: "message",
  id,
  conversationId: "conversation-a",
  role: "assistant",
  content: { kind: "text", text },
  createdAt: Date.UTC(2026, 6, 28) + Number(id.replace(/\D/gu, "")),
});

interface DomRender {
  readonly container: HTMLDivElement;
  readonly root: Root;
  unmount(): Promise<void>;
}

const renderInDom = async (node: ReactNode): Promise<DomRender> => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const previous = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  await act(async () => {
    root.render(node);
    await Promise.resolve();
  });
  return {
    container,
    root,
    async unmount() {
      await act(async () => {
        root.unmount();
        await Promise.resolve();
      });
      container.remove();
      if (previous === undefined) {
        Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
      } else {
        Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previous);
      }
    },
  };
};

describe("@turingfocus/chat-ui-antd smart scrolling", () => {
  it("does not steal scroll while away, counts only new IDs, and resets on conversation switch", async () => {
    const initial = [message("message-1"), message("message-2")];
    const rendered = await renderInDom(
      createElement(ChatTimeline, {
        conversationId: "conversation-a",
        items: initial,
      }),
    );

    try {
      const scroller = rendered.container.querySelector<HTMLElement>(
        "[data-virtuoso-scroller]",
      );
      if (scroller === null) throw new Error("Timeline scroller not found");
      Object.defineProperties(scroller, {
        clientHeight: { configurable: true, value: 200 },
        scrollHeight: { configurable: true, value: 1_000 },
        scrollTop: { configurable: true, value: 100, writable: true },
      });
      await act(async () => {
        scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
        await Promise.resolve();
      });

      await act(async () => {
        rendered.root.render(
          createElement(ChatTimeline, {
            conversationId: "conversation-a",
            items: [...initial, message("message-3")],
          }),
        );
        await Promise.resolve();
      });
      expect(rendered.container.textContent).toContain("1 new messages");
      expect(scroller.scrollTop).toBe(100);

      for (let update = 0; update < 25; update += 1) {
        await act(async () => {
          rendered.root.render(
            createElement(ChatTimeline, {
              conversationId: "conversation-a",
              items: [
                initial[0]!,
                message("message-2", `stream replacement ${update}`),
                message("message-3"),
              ],
            }),
          );
          await Promise.resolve();
        });
      }
      expect(rendered.container.textContent).toContain("1 new messages");
      expect(scroller.scrollTop).toBe(100);

      const jumpButton = [
        ...rendered.container.querySelectorAll("button"),
      ].find((candidate) => candidate.textContent?.includes("Jump to latest"));
      if (jumpButton === undefined) throw new Error("Jump button not found");
      await act(async () => {
        jumpButton.click();
        await Promise.resolve();
      });
      expect(rendered.container.textContent).not.toContain("new messages");

      await act(async () => {
        rendered.root.render(
          createElement(ChatTimeline, {
            conversationId: "conversation-b",
            items: [
              {
                ...message("message-4"),
                conversationId: "conversation-b",
              },
            ],
          }),
        );
        await Promise.resolve();
      });
      expect(rendered.container.textContent).not.toContain("new messages");
    } finally {
      await rendered.unmount();
    }
  });
});
