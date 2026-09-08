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
  it("renders GFM and resource images while dropping raw HTML and active URLs", () => {
    const maliciousMessage: Message = {
      ...textMessage,
      content: {
        kind: "text",
        text: [
          "~~removed~~",
          "",
          "| A | B |",
          "| - | - |",
          "| 1 | 2 |",
          "",
          '<script>alert("xss")</script>',
          "[unsafe](javascript:alert(1))",
          "![tracking](https://example.invalid/pixel.png)",
        ].join("\n"),
      },
    };
    const markup = renderToStaticMarkup(
      createElement(ChatTimelineItem, {
        item: maliciousMessage,
        registry: createChatRendererRegistry(),
      }),
    );

    expect(markup).toContain("<del>removed</del>");
    expect(markup).toContain("<table>");
    expect(markup).not.toContain("<script");
    expect(markup).not.toContain("javascript:");
    expect(markup).toContain('alt="tracking"');
    expect(markup).toContain('referrerPolicy="no-referrer"');
  });

  it("renders normalized image resources and blocks active URI schemes", () => {
    const imageMessage: Message = {
      ...textMessage,
      id: "image-message",
      content: {
        kind: "multipart",
        summary: "Text and image",
        parts: [
          { kind: "text", text: "Rendered caption" },
          {
            kind: "media",
            mediaType: "image",
            summary: "diagram.png",
            resource: { uri: "https://cdn.example/diagram.png" },
          },
        ],
      },
    };
    const markup = renderToStaticMarkup(
      createElement(ChatTimelineItem, {
        item: imageMessage,
        registry: createChatRendererRegistry(),
      }),
    );
    expect(markup).toContain("Rendered caption");
    expect(markup).toContain('alt="diagram.png"');
    expect(markup).toContain('src="https://cdn.example/diagram.png"');
    expect(markup).toContain('referrerPolicy="no-referrer"');

    const unsafeMarkup = renderToStaticMarkup(
      createElement(ChatTimelineItem, {
        item: {
          ...imageMessage,
          content: {
            kind: "media",
            mediaType: "image",
            summary: "Blocked image",
            resource: { uri: "javascript:alert(1)" },
          },
        },
        registry: createChatRendererRegistry(),
      }),
    );
    expect(unsafeMarkup).not.toContain("<img");
    expect(unsafeMarkup).not.toContain("javascript:");
    expect(unsafeMarkup).toContain("Blocked image");
  });

  it("renders normalized Ask User history without reading raw Tool payloads", () => {
    const toolEvent: AgentEvent = {
      kind: "agent-event",
      eventCategory: "tool",
      id: "ask-user-event",
      conversationId,
      eventType: "Tool",
      status: "success",
      createdAt: textMessage.createdAt,
      transitions: [
        {
          id: "ask-user-transition",
          status: "success",
          occurredAt: textMessage.createdAt,
          toolCall: { name: "ask_user" },
          toolReturn: { success: true },
          interaction: {
            kind: "ask-user",
            requestId: "request-1",
            status: "answered",
            questions: [
              {
                id: "0",
                prompt: "Choose one",
                required: true,
                multiple: false,
                options: [],
              },
            ],
            answers: { "0": "Safe answer" },
          },
          raw: { secret: "must-not-render" },
        },
      ],
    };
    const markup = renderToStaticMarkup(
      createElement(ChatTimelineItem, {
        item: toolEvent,
        registry: createChatRendererRegistry(),
      }),
    );

    expect(markup).toContain("Ask User");
    expect(markup).toContain("Choose one");
    expect(markup).toContain("Safe answer");
    expect(markup).not.toContain("must-not-render");
  });

  it("renders bounded normalized Tool results without reading raw payloads", () => {
    const toolEvent: AgentEvent = {
      kind: "agent-event",
      eventCategory: "tool",
      id: "generic-tool-event",
      conversationId,
      eventType: "Tool",
      status: "success",
      createdAt: textMessage.createdAt,
      transitions: [
        {
          id: "generic-tool-transition",
          status: "success",
          occurredAt: textMessage.createdAt,
          toolCall: { name: "search" },
          toolReturn: {
            result: {
              summary: "VISIBLE_RESULT",
              oversized: "x".repeat(5_000),
            },
            success: true,
            done: true,
            raw: { secret: "must-not-render" },
          },
        },
      ],
    };
    const markup = renderToStaticMarkup(
      createElement(ChatTimelineItem, {
        item: toolEvent,
        registry: createChatRendererRegistry(),
      }),
    );

    expect(markup).toContain("VISIBLE_RESULT");
    expect(markup).toContain("Result truncated");
    expect(markup).toContain("success");
    expect(markup).toContain("done");
    expect(markup).not.toContain("must-not-render");
    expect(markup.length).toBeLessThan(8_000);
  });

  it("renders normalized Ask User failures as failures even when the event status is success", () => {
    const toolEvent: AgentEvent = {
      kind: "agent-event",
      eventCategory: "tool",
      id: "failed-ask-user-event",
      conversationId,
      eventType: "Tool",
      status: "success",
      createdAt: textMessage.createdAt,
      transitions: [
        {
          id: "failed-ask-user-transition",
          status: "success",
          occurredAt: textMessage.createdAt,
          toolCall: { name: "ask_user" },
          toolReturn: { success: false },
          interaction: {
            kind: "ask-user",
            requestId: "request-failed",
            status: "failed",
            questions: [
              {
                id: "0",
                prompt: "Choose one",
                required: true,
                multiple: false,
                options: [],
              },
            ],
            error: "backend exploded",
          },
        },
      ],
    };
    const markup = renderToStaticMarkup(
      createElement(ChatTimelineItem, {
        item: toolEvent,
        registry: createChatRendererRegistry(),
      }),
    );

    expect(markup).toContain("failed");
    expect(markup).toContain("backend exploded");
    expect(markup).not.toContain(">success<");
  });

  it("bounds oversized normalized Ask User history within one timeline item", () => {
    const questions = Array.from({ length: 40 }, (_, index) => ({
      id: String(index),
      prompt: `Question ${index} ${"p".repeat(800)}`,
      required: true,
      multiple: false,
      options: [],
    }));
    const toolEvent: AgentEvent = {
      kind: "agent-event",
      eventCategory: "tool",
      id: "oversized-ask-user-event",
      conversationId,
      eventType: "Tool",
      status: "success",
      createdAt: textMessage.createdAt,
      transitions: [
        {
          id: "oversized-ask-user-transition",
          status: "success",
          occurredAt: textMessage.createdAt,
          interaction: {
            kind: "ask-user",
            requestId: "oversized-request",
            status: "answered",
            questions,
            answers: Object.fromEntries(
              questions.map(({ id }, index) => [
                id,
                index === 0
                  ? Array.from({ length: 5_000 }, () => "array-value")
                  : "a".repeat(4_000),
              ]),
            ),
          },
        },
      ],
    };
    const markup = renderToStaticMarkup(
      createElement(ChatTimelineItem, {
        item: toolEvent,
        registry: createChatRendererRegistry(),
      }),
    );

    expect(markup).toContain("Ask User history truncated");
    expect(markup).not.toContain("Question 39");
    expect(markup.length).toBeLessThan(40_000);
  });

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

  it("renders standard events as compact selectable timeline rows and keeps messages unchanged", () => {
    const registry = createChatRendererRegistry();
    const eventMarkup = renderToStaticMarkup(
      createElement(ChatTimelineItem, {
        displayMode: "timeline",
        item: agentEvent,
        registry,
        selected: true,
      }),
    );
    const unknownMarkup = renderToStaticMarkup(
      createElement(ChatTimelineItem, {
        displayMode: "timeline",
        item: unknownEvent,
        registry,
      }),
    );
    const messageMarkup = renderToStaticMarkup(
      createElement(ChatTimelineItem, {
        displayMode: "timeline",
        item: textMessage,
        registry,
      }),
    );

    expect(eventMarkup).toContain('data-chat-event-row=""');
    expect(eventMarkup).toContain('data-selected="true"');
    expect(eventMarkup).toContain("Thinking safely");
    expect(eventMarkup).not.toContain('data-chat-event-detail=""');
    expect(unknownMarkup).toContain('data-chat-event-row=""');
    expect(unknownMarkup).toContain("Safe diagnostic summary");
    expect(unknownMarkup).not.toContain("must-not-render");
    expect(messageMarkup).toContain("Safe text");
    expect(messageMarkup).not.toContain("data-chat-event-row");
  });

  it("shows every normalized transition in detail without rendering raw payloads", () => {
    const transitionedEvent: AgentEvent = {
      ...agentEvent,
      status: "failed",
      summary: "Safe overall summary",
      raw: { credential: "EVENT_SECRET" },
      transitions: [
        {
          id: "transition-running",
          status: "running",
          occurredAt: textMessage.createdAt,
          summary: "Started safely",
          raw: { token: "TRANSITION_SECRET" },
        },
        {
          id: "transition-failed",
          status: "failed",
          occurredAt: textMessage.createdAt + 1,
          summary: "Stopped safely",
          error: {
            code: "server",
            message: "Visible failure",
            retryable: false,
          },
        },
      ],
    };
    const markup = renderToStaticMarkup(
      createElement(ChatTimelineItem, {
        displayMode: "detail",
        item: transitionedEvent,
        registry: createChatRendererRegistry(),
      }),
    );

    expect(markup).toContain('data-chat-event-detail=""');
    expect(markup).toContain("running · 2026-07-28");
    expect(markup).toContain("failed · 2026-07-28");
    expect(markup).toContain("Stopped safely");
    expect(markup).toContain("Visible failure");
    expect(markup).not.toContain("EVENT_SECRET");
    expect(markup).not.toContain("TRANSITION_SECRET");
    expect(markup).not.toContain("credential");
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
