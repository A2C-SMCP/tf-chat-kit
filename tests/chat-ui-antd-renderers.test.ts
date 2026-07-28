// @vitest-environment jsdom

import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type {
  AgentEvent,
  Message,
  UnknownEvent,
} from "../packages/chat-protocol/src/index.js";
import {
  ChatTimelineItem,
  createChatRendererRegistry,
  resolveChatRenderer,
  type ChatRenderer,
  type ChatRendererFailure,
} from "../packages/chat-ui-antd/src/index.js";

const conversationId = "renderer-conversation";
const textMessage: Message = {
  kind: "message",
  id: "message-1",
  conversationId,
  role: "assistant",
  content: { kind: "text", text: "Safe text" },
  createdAt: Date.UTC(2026, 6, 28),
};

const unknownEvent: UnknownEvent = {
  kind: "unknown-event",
  id: "unknown-1",
  conversationId,
  originalType: "future.secret-event",
  createdAt: Date.UTC(2026, 6, 28),
  summary: "Safe diagnostic summary",
  raw: { token: "must-not-render" },
};

const agentEvent: AgentEvent = {
  kind: "agent-event",
  id: "agent-event-1",
  conversationId,
  eventCategory: "generic",
  eventType: "agent.thinking",
  status: "running",
  createdAt: Date.UTC(2026, 6, 28),
  transitions: [
    {
      id: "transition-1",
      status: "running",
      occurredAt: Date.UTC(2026, 6, 28),
      summary: "Thinking safely",
    },
  ],
};

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

describe("@turingfocus/chat-ui-antd renderer registry", () => {
  it("prefers host-specific overrides and falls back to safe defaults", () => {
    const Override: ChatRenderer = ({ item }) =>
      createElement("strong", null, `Host renderer: ${item.id}`);
    const GenericOverride: ChatRenderer = ({ item }) =>
      createElement("strong", null, `Generic host renderer: ${item.id}`);
    const registry = createChatRendererRegistry({
      "message:text": Override,
    });

    expect(resolveChatRenderer(registry, textMessage)).toBe(Override);
    expect(
      resolveChatRenderer(
        createChatRendererRegistry({ message: GenericOverride }),
        textMessage,
      ),
    ).toBe(GenericOverride);
    const markup = renderToStaticMarkup(
      createElement(ChatTimelineItem, {
        item: textMessage,
        registry,
      }),
    );
    expect(markup).toContain("Host renderer: message-1");
  });

  it("resolves exact, category, and generic keys in order and lets null select the safe fallback", () => {
    const Exact: ChatRenderer = () => createElement("span", null, "exact");
    const Category: ChatRenderer = () =>
      createElement("span", null, "category");
    const Generic: ChatRenderer = () => createElement("span", null, "generic");

    expect(
      resolveChatRenderer(
        createChatRendererRegistry({
          "agent-event": Generic,
          "agent-event:agent.thinking": Exact,
          "agent-event:generic": Category,
        }),
        agentEvent,
      ),
    ).toBe(Exact);
    expect(
      resolveChatRenderer(
        createChatRendererRegistry({
          "agent-event": Generic,
          "agent-event:generic": Category,
        }),
        agentEvent,
      ),
    ).toBe(Category);
    expect(
      resolveChatRenderer(
        createChatRendererRegistry({
          "agent-event": Generic,
          "agent-event:agent.thinking": null,
          "agent-event:generic": Category,
        }),
        agentEvent,
      ),
    ).toBeUndefined();
    expect(
      resolveChatRenderer(
        createChatRendererRegistry({ message: null }),
        textMessage,
      ),
    ).toBeUndefined();
    expect(
      resolveChatRenderer(
        createChatRendererRegistry({
          "unknown-event:future.secret-event": null,
        }),
        unknownEvent,
      ),
    ).toBeUndefined();
    const fallbackMarkup = renderToStaticMarkup(
      createElement(ChatTimelineItem, {
        item: textMessage,
        registry: createChatRendererRegistry({ message: null }),
      }),
    );
    expect(fallbackMarkup).toContain("Safe text");
    expect(fallbackMarkup).not.toContain("Host renderer");
  });

  it("shows unknown type, time, and safe summary without rendering raw data", () => {
    const markup = renderToStaticMarkup(
      createElement(ChatTimelineItem, {
        item: unknownEvent,
        registry: createChatRendererRegistry(),
      }),
    );

    expect(markup).toContain("future.secret-event");
    expect(markup).toContain("2026-07-28");
    expect(markup).toContain("Safe diagnostic summary");
    expect(markup).not.toContain("must-not-render");
    expect(markup).not.toContain("token");
  });

  it("isolates one renderer exception and reports it without exposing the error", async () => {
    const onRendererError = vi.fn<(failure: ChatRendererFailure) => void>(
      () => {
        throw new Error("host diagnostics failed");
      },
    );
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const preventExpectedError = (event: ErrorEvent): void => {
      event.preventDefault();
    };
    window.addEventListener("error", preventExpectedError);
    const ThrowingRenderer: ChatRenderer = () => {
      throw new Error("private renderer failure");
    };
    const rendered = await renderInDom(
      createElement(ChatTimelineItem, {
        item: textMessage,
        onRendererError,
        registry: createChatRendererRegistry({
          "message:text": ThrowingRenderer,
        }),
      }),
    );

    try {
      expect(rendered.container.textContent).toContain("Renderer unavailable");
      expect(rendered.container.textContent).toContain("Safe text");
      expect(rendered.container.textContent).not.toContain(
        "private renderer failure",
      );
      expect(rendered.container.textContent).not.toContain(
        "host diagnostics failed",
      );
      expect(onRendererError).toHaveBeenCalledOnce();
      expect(onRendererError.mock.calls[0]?.[0].item).toBe(textMessage);
    } finally {
      await rendered.unmount();
      window.removeEventListener("error", preventExpectedError);
      consoleError.mockRestore();
    }
  });

  it("resets an isolated failure when the same item is replaced with renderable content", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const preventExpectedError = (event: ErrorEvent): void => {
      event.preventDefault();
    };
    window.addEventListener("error", preventExpectedError);
    const ConditionalRenderer: ChatRenderer = ({ item }) => {
      if (
        item.kind === "message" &&
        item.content.kind === "text" &&
        item.content.text === "Safe text"
      ) {
        throw new Error("first version failed");
      }
      return createElement("strong", null, "Recovered renderer");
    };
    const registry = createChatRendererRegistry({
      "message:text": ConditionalRenderer,
    });
    const rendered = await renderInDom(
      createElement(ChatTimelineItem, {
        item: textMessage,
        registry,
      }),
    );

    try {
      expect(rendered.container.textContent).toContain("Renderer unavailable");
      await act(async () => {
        rendered.root.render(
          createElement(ChatTimelineItem, {
            item: {
              ...textMessage,
              content: { kind: "text", text: "Replacement content" },
            },
            registry,
          }),
        );
        await Promise.resolve();
      });
      expect(rendered.container.textContent).toContain("Recovered renderer");
    } finally {
      await rendered.unmount();
      window.removeEventListener("error", preventExpectedError);
      consoleError.mockRestore();
    }
  });
});
