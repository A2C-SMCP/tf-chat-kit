import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { Message } from "../packages/chat-protocol/src/index.js";
import {
  ChatConversationList,
  ChatTimeline,
} from "../packages/chat-ui-antd/src/index.js";
import { createConversationItems } from "./support/chat-ui-antd.js";

describe("@turingfocus/chat-ui-antd conversation virtualization", () => {
  it("uses a timezone-independent default date during server rendering", () => {
    const previousTimezone = process.env["TZ"];
    const renderAtTimezone = (timezone: string): string => {
      process.env["TZ"] = timezone;

      return renderToStaticMarkup(
        createElement(ChatConversationList, {
          items: createConversationItems(1),
          onSelect: vi.fn(),
        }),
      );
    };

    try {
      const utcMarkup = renderAtTimezone("UTC");
      const losAngelesMarkup = renderAtTimezone("America/Los_Angeles");

      expect(utcMarkup).toContain("2026-07-01");
      expect(losAngelesMarkup).toBe(utcMarkup);
    } finally {
      if (previousTimezone === undefined) {
        delete process.env["TZ"];
      } else {
        process.env["TZ"] = previousTimezone;
      }
    }
  });

  it("bounds the server-rendered list window for large conversation sets", () => {
    const markup = renderToStaticMarkup(
      createElement(ChatConversationList, {
        formatUpdatedAt: () => "",
        items: createConversationItems(1_000),
        onSelect: vi.fn(),
      }),
    );

    expect(markup).toContain("Conversation 1");
    expect(markup).toContain("Conversation 20");
    expect(markup).not.toContain("Conversation 21");
    expect(markup).not.toContain("Conversation 1000");
  });

  it("bounds a 5,000-item server-rendered timeline window", () => {
    const items: Message[] = Array.from({ length: 5_000 }, (_value, index) => ({
      kind: "message",
      id: `message-${index + 1}`,
      conversationId: "large-timeline",
      role: "assistant",
      content: { kind: "text", text: `Timeline ${index + 1}` },
      createdAt: Date.UTC(2026, 6, 28) + index,
    }));
    const markup = renderToStaticMarkup(
      createElement(ChatTimeline, {
        conversationId: "large-timeline",
        items,
      }),
    );

    expect(markup.match(/role="article"/gu)).toHaveLength(20);
    expect(markup).toContain("Timeline 4981");
    expect(markup).toContain("Timeline 5000");
    expect(markup).not.toContain("Timeline 1<");
    expect(markup).not.toContain("Timeline 2500");
  });
});
