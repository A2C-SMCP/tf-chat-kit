// @vitest-environment jsdom

import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  ChatConversationList,
  ChatStateView,
  ChatUiShell,
  defaultChatUiLabels,
  type ChatContentState,
} from "../packages/chat-ui-antd/src/index.js";
import { createConversationItems } from "./support/chat-ui-antd.js";

const findButtonByText = (
  container: HTMLElement,
  text: string,
): HTMLButtonElement => {
  const button = [...container.querySelectorAll("button")].find((candidate) =>
    candidate.textContent?.includes(text),
  );
  if (button === undefined) throw new Error(`Button not found: ${text}`);
  return button;
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
  const actEnvironmentKey = "IS_REACT_ACT_ENVIRONMENT";
  const previousActEnvironment = Reflect.get(globalThis, actEnvironmentKey);
  Reflect.set(globalThis, actEnvironmentKey, true);
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
      if (previousActEnvironment === undefined) {
        Reflect.deleteProperty(globalThis, actEnvironmentKey);
      } else {
        Reflect.set(globalThis, actEnvironmentKey, previousActEnvironment);
      }
    },
  };
};

describe("@turingfocus/chat-ui-antd shell", () => {
  it("keeps conversation selection controlled and renders ready content", async () => {
    const onConversationSelect = vi.fn();
    const items = createConversationItems(3);
    const rendered = await renderInDom(
      createElement(
        ChatUiShell,
        {
          contentState: { kind: "ready" },
          conversations: items,
          formatConversationUpdatedAt: () => "Jul 2026",
          onConversationSelect,
          pendingConversationId: items[1]!.id,
          selectedConversationId: items[0]!.id,
        },
        createElement("p", null, "Ready timeline slot"),
      ),
    );

    try {
      expect(
        rendered.container.querySelector('[aria-current="true"]'),
      ).not.toBeNull();
      expect(rendered.container.textContent).toContain("Ready timeline slot");
      expect(
        rendered.container.querySelector('[aria-label="Conversations"]'),
      ).not.toBeNull();

      await act(async () => {
        findButtonByText(rendered.container, "Conversation 3").click();
      });
      expect(onConversationSelect).toHaveBeenCalledOnce();
      expect(onConversationSelect).toHaveBeenCalledWith(items[2]!.id);
    } finally {
      await rendered.unmount();
    }
  });

  it("renders every required state without exposing raw error objects", () => {
    const states: readonly ChatContentState[] = [
      { kind: "loading" },
      { kind: "empty" },
      { kind: "error", description: "Safe error summary" },
      { kind: "disconnected" },
      {
        kind: "capability-unavailable",
        capability: "sendText",
      },
    ];

    const markup = states
      .map((contentState) =>
        renderToStaticMarkup(
          createElement(ChatUiShell, {
            contentState,
            conversations: [],
            onConversationSelect: vi.fn(),
          }),
        ),
      )
      .join("\n");

    expect(markup).toContain("Loading conversation");
    expect(markup).toContain("No conversation selected");
    expect(markup).toContain("Safe error summary");
    expect(markup).toContain("Disconnected");
    expect(markup).toContain(
      "sendText is not available in the current session.",
    );
  });

  it("supports host copy, state retry, and conversation-list retry", async () => {
    const retryState = vi.fn();
    const retryList = vi.fn();
    const rendered = await renderInDom(
      createElement(ChatUiShell, {
        contentState: {
          kind: "disconnected",
          onRetry: retryState,
        },
        conversationListError: {
          message: "Conversation list failed",
          onRetry: retryList,
        },
        conversations: [],
        labels: {
          conversationListLabel: "Sessions",
          disconnectedTitle: "Connection lost",
          retry: "Reconnect",
        },
        onConversationSelect: vi.fn(),
      }),
    );

    try {
      expect(
        rendered.container.querySelector('[aria-label="Sessions"]'),
      ).not.toBeNull();
      expect(rendered.container.textContent).toContain("Connection lost");

      const retryButtons = [
        ...rendered.container.querySelectorAll("button"),
      ].filter((button) => button.textContent?.includes("Reconnect"));
      expect(retryButtons).toHaveLength(2);

      await act(async () => {
        retryButtons.forEach((button) => {
          button.click();
        });
      });
      expect(retryState).toHaveBeenCalledOnce();
      expect(retryList).toHaveBeenCalledOnce();
    } finally {
      await rendered.unmount();
    }
  });

  it("keeps virtualization in an explicit height chain while loading", async () => {
    const items = createConversationItems(3);
    const rendered = await renderInDom(
      createElement(ChatConversationList, {
        items,
        loading: true,
        onSelect: vi.fn(),
      }),
    );

    try {
      const list =
        rendered.container.querySelector<HTMLElement>('[role="list"]');
      const listRoot = list?.parentElement;

      expect(list).not.toBeNull();
      expect(listRoot?.style.height).toBe("100%");
      expect(listRoot?.style.minHeight).toBe("160px");
      expect(listRoot?.style.overflow).toBe("hidden");
      expect(listRoot?.style.position).toBe("relative");
      expect(list?.style.height).toBe("100%");
      expect(list?.style.minHeight).toBe("0px");
      expect(
        rendered.container.querySelector(".ant-spin-nested-loading"),
      ).toBeNull();
      expect(
        rendered.container.querySelector('[role="status"]'),
      ).not.toBeNull();
      expect(list?.getAttribute("aria-busy")).toBe("true");

      await act(async () => {
        rendered.root.render(
          createElement(ChatConversationList, {
            items,
            loading: false,
            onSelect: vi.fn(),
          }),
        );
        await Promise.resolve();
      });

      expect(rendered.container.querySelector('[role="status"]')).toBeNull();
      expect(
        rendered.container
          .querySelector('[role="list"]')
          ?.getAttribute("aria-busy"),
      ).toBe("false");
    } finally {
      await rendered.unmount();
    }
  });

  it("provides composable state and list components with accessible defaults", () => {
    const stateMarkup = renderToStaticMarkup(
      createElement(ChatStateView, {
        state: { kind: "empty" },
      }),
    );
    const listMarkup = renderToStaticMarkup(
      createElement(ChatConversationList, {
        items: [],
        onSelect: vi.fn(),
      }),
    );

    expect(stateMarkup).toContain(defaultChatUiLabels.emptyTitle as string);
    expect(stateMarkup).toContain('role="status"');
    expect(listMarkup).toContain(defaultChatUiLabels.noConversations as string);
    expect(listMarkup).toContain('role="list"');
  });
});
