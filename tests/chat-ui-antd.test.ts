// @vitest-environment jsdom

import { act, createElement, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  ChatWorkspace,
  ChatComposer,
  type ChatComposerProps,
  ChatConversationList,
  ChatStateView,
  ChatUiShell,
  defaultChatUiLabels,
  type ChatCompactNavigationConfig,
  type ChatContentState,
} from "../packages/chat-ui-antd/src/index.js";
import {
  ChatProvider,
  type ChatAttachmentUploader,
  type ComposerDraft,
} from "../packages/chat-react/src/index.js";
import { createChatClient } from "../packages/chat-runtime/src/index.js";
import { createMemoryChatGateway } from "../packages/chat-testing/src/index.js";
import { deadlineAt, flushMicrotasks } from "./support/chat-react.js";
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

const findElementByText = (text: string): HTMLElement => {
  const element = [...document.body.querySelectorAll<HTMLElement>("*")].find(
    (candidate) =>
      candidate.children.length === 0 && candidate.textContent?.trim() === text,
  );
  if (element === undefined) throw new Error(`Element not found: ${text}`);
  return element;
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
  it("manages conversation listing, creation and selection without host state", async () => {
    const memory = createMemoryChatGateway();
    const client = createChatClient({ gateway: memory.gateway });
    const rendered = await renderInDom(
      createElement(
        ChatProvider,
        { client },
        createElement(ChatWorkspace, {
          allowCreate: true,
          getDeadlineAt: deadlineAt,
        }),
      ),
    );

    try {
      await act(async () => {
        await flushMicrotasks();
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
      });
      expect(rendered.container.textContent).toContain("Contract conversation");
      expect(
        rendered.container.querySelector('[aria-current="true"]')?.textContent,
      ).toContain("Contract conversation");

      await act(async () => {
        findButtonByText(rendered.container, "New conversation").click();
        await Promise.resolve();
      });
      const input = document.body.querySelector<HTMLInputElement>(
        'input[aria-label="Conversation title"]',
      );
      if (input === null) throw new Error("Creation title input not found");
      await act(async () => {
        const valueSetter = Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          "value",
        )?.set;
        valueSetter?.call(input, "Created without host orchestration");
        input.dispatchEvent(new Event("input", { bubbles: true }));
        await flushMicrotasks();
      });
      const dialog =
        document.body.querySelector<HTMLElement>('[role="dialog"]');
      if (dialog === null) throw new Error("Creation dialog not found");
      await act(async () => {
        findButtonByText(dialog, "Create").click();
        await flushMicrotasks();
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
      });

      expect(rendered.container.textContent).toContain(
        "Created without host orchestration",
      );
      expect(
        rendered.container.querySelector('[aria-current="true"]')?.textContent,
      ).toContain("Created without host orchestration");
      expect(
        memory.controller.calls.filter(
          ({ operation }) => operation === "createConversation",
        ),
      ).toHaveLength(1);
    } finally {
      await rendered.unmount();
      await client.dispose({ deadlineAt: deadlineAt() });
    }
  });

  it("offers opt-in rename and confirmed deletion actions", async () => {
    const memory = createMemoryChatGateway();
    const client = createChatClient({ gateway: memory.gateway });
    const rendered = await renderInDom(
      createElement(
        ChatProvider,
        { client },
        createElement(ChatWorkspace, {
          allowDelete: true,
          allowRename: true,
          getDeadlineAt: deadlineAt,
        }),
      ),
    );

    try {
      await act(async () => {
        await flushMicrotasks();
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
      });
      const originalTitle = memory.fixtures.conversation.title;
      await act(async () => {
        rendered.container
          .querySelector<HTMLButtonElement>(
            `button[aria-label="${originalTitle} actions"]`,
          )
          ?.click();
        await flushMicrotasks();
      });
      await act(async () => {
        findElementByText("Rename conversation").click();
        await flushMicrotasks();
      });
      const renameInput = document.body.querySelector<HTMLInputElement>(
        'input[aria-label="Conversation title"]',
      );
      if (renameInput === null) throw new Error("Rename input not found");
      await act(async () => {
        const valueSetter = Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          "value",
        )?.set;
        valueSetter?.call(renameInput, "Renamed in workspace");
        renameInput.dispatchEvent(new Event("input", { bubbles: true }));
        await flushMicrotasks();
      });
      const renameDialog =
        document.body.querySelector<HTMLElement>('[role="dialog"]');
      if (renameDialog === null) throw new Error("Rename dialog not found");
      await act(async () => {
        findButtonByText(renameDialog, "Rename").click();
        await flushMicrotasks();
      });
      expect(rendered.container.textContent).toContain("Renamed in workspace");

      await act(async () => {
        rendered.container
          .querySelector<HTMLButtonElement>(
            'button[aria-label="Renamed in workspace actions"]',
          )
          ?.click();
        await flushMicrotasks();
      });
      await act(async () => {
        findElementByText("Delete conversation").click();
        await flushMicrotasks();
      });
      const deleteDialog = [
        ...document.body.querySelectorAll<HTMLElement>('[role="dialog"]'),
      ].find((dialog) => dialog.textContent?.includes("Delete conversation"));
      if (deleteDialog === undefined)
        throw new Error("Delete dialog not found");
      expect(deleteDialog.textContent).toContain(
        "Delete this conversation permanently?",
      );
      await act(async () => {
        findButtonByText(deleteDialog, "Delete").click();
        await flushMicrotasks();
      });
      expect(rendered.container.textContent).not.toContain(
        "Renamed in workspace",
      );
      expect(
        memory.controller.calls.filter(
          ({ operation }) => operation === "renameConversation",
        ),
      ).toHaveLength(1);
      expect(
        memory.controller.calls.filter(
          ({ operation }) => operation === "deleteConversation",
        ),
      ).toHaveLength(1);
    } finally {
      await rendered.unmount();
      await client.dispose({ deadlineAt: deadlineAt() });
    }
  });

  it("keeps the timeline visible and gates commands during recovery", async () => {
    const memory = createMemoryChatGateway();
    const client = createChatClient({ gateway: memory.gateway });
    const rendered = await renderInDom(
      createElement(
        ChatProvider,
        { client },
        createElement(ChatWorkspace, {
          getDeadlineAt: deadlineAt,
          labels: { lifecycleStatus: { recovering: "Custom recovering…" } },
        }),
      ),
    );

    try {
      await act(async () => {
        await flushMicrotasks();
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
      });
      const conversationId = memory.fixtures.conversation.id;
      await act(async () => {
        memory.controller.emitUpdateToAll({
          kind: "lifecycle.changed",
          conversationId,
          lifecycle: {
            status: "recovering",
            generation: 2,
            subscriptionId: "subscription-2",
            recovery: { complete: false },
          },
        });
        await flushMicrotasks();
      });

      expect(rendered.container.textContent).toContain("Custom recovering…");
      expect(rendered.container.textContent).toContain("Contract conversation");
      const composer = rendered.container.querySelector<HTMLTextAreaElement>(
        'textarea[aria-label="Message"]',
      );
      expect(composer?.disabled).toBe(true);

      await act(async () => {
        memory.controller.emitUpdateToAll({
          kind: "lifecycle.changed",
          conversationId,
          lifecycle: {
            status: "degraded",
            generation: 2,
            subscriptionId: "subscription-2",
            recovery: {
              assurance: "best-effort",
              complete: false,
              source: "rest-rebase",
            },
          },
        });
        await flushMicrotasks();
      });
      expect(rendered.container.textContent).toContain(
        "Connected with best-effort recovery",
      );
      expect(composer?.disabled).toBe(false);

      await act(async () => {
        memory.controller.emitUpdateToAll({
          kind: "lifecycle.changed",
          conversationId,
          lifecycle: {
            status: "auth-required",
            generation: 2,
            subscriptionId: "subscription-2",
          },
        });
        await flushMicrotasks();
      });
      expect(rendered.container.textContent).toContain(
        "Sign in again to continue.",
      );

      await act(async () => {
        memory.controller.emitUpdateToAll({
          kind: "lifecycle.changed",
          conversationId,
          lifecycle: {
            status: "active",
            generation: 2,
            subscriptionId: "subscription-2",
            recovery: { complete: true },
          },
        });
        await flushMicrotasks();
      });
      expect(composer?.disabled).toBe(false);
    } finally {
      await rendered.unmount();
      await client.dispose({ deadlineAt: deadlineAt() });
    }
  });

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

  it("renders compact navigation header by default", async () => {
    const compactNav: ChatCompactNavigationConfig = {
      conversationTitle: "Current Chat",
      conversationHistoryOpen: false,
      conversationHistoryItems: [],
      onConversationHistoryOpenChange: vi.fn(),
      onNewConversation: vi.fn(),
    };
    const rendered = await renderInDom(
      createElement(ChatUiShell, {
        compactNavigation: compactNav,
        contentState: { kind: "ready" },
        conversations: [],
        navigationMode: "compact",
        onConversationSelect: vi.fn(),
      }),
    );

    try {
      expect(rendered.container.textContent).toContain("Current Chat");
      expect(
        rendered.container.querySelector(
          'button[aria-label="New conversation"]',
        ),
      ).not.toBeNull();
      expect(
        rendered.container.querySelector('button[aria-label="History"]'),
      ).not.toBeNull();
      expect(
        rendered.container.querySelector('aside[aria-label="Conversations"]'),
      ).toBeNull();
    } finally {
      await rendered.unmount();
    }
  });

  it("renders sidebar when navigationMode is sidebar", async () => {
    const rendered = await renderInDom(
      createElement(ChatUiShell, {
        contentState: { kind: "ready" },
        conversations: [],
        navigationMode: "sidebar",
        onConversationSelect: vi.fn(),
      }),
    );

    try {
      expect(
        rendered.container.querySelector('aside[aria-label="Conversations"]'),
      ).not.toBeNull();
      expect(
        rendered.container.querySelector(
          'button[aria-label="New conversation"]',
        ),
      ).toBeNull();
    } finally {
      await rendered.unmount();
    }
  });

  it("shows empty state when dropdown has no items", async () => {
    const config: ChatCompactNavigationConfig = {
      conversationTitle: "Empty",
      conversationHistoryOpen: true,
      conversationHistoryItems: [],
      onConversationHistoryOpenChange: vi.fn(),
      onNewConversation: vi.fn(),
    };
    const rendered = await renderInDom(
      createElement(ChatUiShell, {
        compactNavigation: config,
        navigationMode: "compact",
        contentState: { kind: "ready" },
        conversations: [],
        onConversationSelect: vi.fn(),
      }),
    );

    try {
      expect(document.body.textContent).toContain(
        String(defaultChatUiLabels.noHistoryConversations),
      );
    } finally {
      await rendered.unmount();
    }
  });

  it("shows conversation items in dropdown", async () => {
    const items = createConversationItems(2);
    const config: ChatCompactNavigationConfig = {
      conversationTitle: "With Items",
      conversationHistoryOpen: true,
      conversationHistoryItems: items,
      onConversationHistoryOpenChange: vi.fn(),
      onNewConversation: vi.fn(),
    };
    const rendered = await renderInDom(
      createElement(ChatUiShell, {
        compactNavigation: config,
        navigationMode: "compact",
        contentState: { kind: "ready" },
        conversations: [],
        onConversationSelect: vi.fn(),
        selectedConversationId: items[0]!.id,
      }),
    );

    try {
      expect(document.body.textContent).toContain("Conversation 1");
      expect(document.body.textContent).toContain("Conversation 2");
    } finally {
      await rendered.unmount();
    }
  });

  it("shows error state in dropdown", async () => {
    const config: ChatCompactNavigationConfig = {
      conversationTitle: "Error",
      conversationHistoryOpen: true,
      conversationHistoryError: "Failed to load",
      conversationHistoryItems: [],
      onConversationHistoryOpenChange: vi.fn(),
      onNewConversation: vi.fn(),
    };
    const rendered = await renderInDom(
      createElement(ChatUiShell, {
        compactNavigation: config,
        navigationMode: "compact",
        contentState: { kind: "ready" },
        conversations: [],
        onConversationSelect: vi.fn(),
      }),
    );

    try {
      expect(document.body.textContent).toContain("Failed to load");
    } finally {
      await rendered.unmount();
    }
  });

  it("shows loading state in dropdown", async () => {
    const config: ChatCompactNavigationConfig = {
      conversationTitle: "Loading",
      conversationHistoryOpen: true,
      conversationHistoryLoading: true,
      conversationHistoryItems: [],
      onConversationHistoryOpenChange: vi.fn(),
      onNewConversation: vi.fn(),
    };
    const rendered = await renderInDom(
      createElement(ChatUiShell, {
        compactNavigation: config,
        navigationMode: "compact",
        contentState: { kind: "ready" },
        conversations: [],
        onConversationSelect: vi.fn(),
      }),
    );

    try {
      expect(document.body.textContent).toContain(
        String(defaultChatUiLabels.loadingHistoryConversations),
      );
    } finally {
      await rendered.unmount();
    }
  });
});

describe("ChatComposer attachments and long text", () => {
  const Harness = ({
    onSend,
    resetKey,
    textInputDisabled,
    uploader,
  }: {
    readonly onSend: ChatComposerProps["onSend"];
    readonly resetKey?: string;
    readonly textInputDisabled?: boolean;
    readonly uploader?: ChatAttachmentUploader;
  }) => {
    const [draft, setDraft] = useState<ComposerDraft>({
      attachments: [],
      conversationId: "conversation-1",
      longTexts: [],
      revision: 0,
      text: "",
    });
    return createElement(ChatComposer, {
      attachmentUploader: uploader,
      draft,
      getDeadlineAt: deadlineAt,
      longTextThreshold: 5,
      onDraftChange: (next) =>
        setDraft((current) => ({
          ...current,
          ...next,
          revision: current.revision + 1,
        })),
      onSend,
      resetKey,
      textInputDisabled,
    });
  };

  it("compacts a long paste but sends its complete content", async () => {
    const onSend = vi.fn(async () => true);
    const rendered = await renderInDom(createElement(Harness, { onSend }));
    try {
      const textarea = rendered.container.querySelector("textarea")!;
      const event = new Event("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(event, "clipboardData", {
        value: { files: [], getData: () => "complete pasted content" },
      });
      await act(async () => {
        textarea.dispatchEvent(event);
        await flushMicrotasks();
      });
      expect(textarea.value).toBe("[Pasted text 1]");
      await act(async () => {
        findButtonByText(rendered.container, "Send").click();
        await flushMicrotasks();
      });
      expect(onSend).toHaveBeenCalledWith("complete pasted content", []);
    } finally {
      await rendered.unmount();
    }
  });

  it("uploads with the injected default-shaped port and sends the resource", async () => {
    const onSend = vi.fn(async () => true);
    const uploader: ChatAttachmentUploader = {
      upload: vi.fn(async () => ({
        ok: true as const,
        value: { uri: "s3://notes", mimeType: "text/plain", name: "notes.txt" },
      })),
    };
    const rendered = await renderInDom(
      createElement(Harness, { onSend, textInputDisabled: true, uploader }),
    );
    try {
      const input =
        rendered.container.querySelector<HTMLInputElement>(
          'input[type="file"]',
        )!;
      const file = new File(["notes"], "notes.txt", { type: "text/plain" });
      Object.defineProperty(input, "files", {
        configurable: true,
        value: [file],
      });
      await act(async () => {
        input.dispatchEvent(new Event("change", { bubbles: true }));
        await flushMicrotasks();
      });
      expect(rendered.container.textContent).toContain("notes.txt");
      await act(async () => {
        findButtonByText(rendered.container, "Send").click();
        await flushMicrotasks();
      });
      expect(onSend).toHaveBeenCalledWith("", [
        { uri: "s3://notes", mimeType: "text/plain", name: "notes.txt" },
      ]);
    } finally {
      await rendered.unmount();
    }
  });

  it("discards an upload completion from a previous conversation reset", async () => {
    let cancellation:
      | Parameters<ChatAttachmentUploader["upload"]>[0]["cancellation"]
      | undefined;
    let resolveUpload:
      | ((
          result: Awaited<ReturnType<ChatAttachmentUploader["upload"]>>,
        ) => void)
      | undefined;
    const uploader: ChatAttachmentUploader = {
      upload: (input) =>
        new Promise((resolve) => {
          cancellation = input.cancellation;
          resolveUpload = resolve;
        }),
    };
    const onSend = vi.fn(async () => true);
    const rendered = await renderInDom(
      createElement(Harness, { onSend, resetKey: "first", uploader }),
    );
    try {
      const input =
        rendered.container.querySelector<HTMLInputElement>(
          'input[type="file"]',
        )!;
      Object.defineProperty(input, "files", {
        configurable: true,
        value: [new File(["late"], "late.txt", { type: "text/plain" })],
      });
      await act(async () => {
        input.dispatchEvent(new Event("change", { bubbles: true }));
        await flushMicrotasks();
      });
      expect(cancellation?.aborted).toBe(false);
      await act(async () => {
        rendered.root.render(
          createElement(Harness, { onSend, resetKey: "second", uploader }),
        );
        await flushMicrotasks();
      });
      expect(cancellation?.aborted).toBe(true);
      await act(async () => {
        resolveUpload?.({
          ok: true,
          value: {
            mimeType: "text/plain",
            name: "late.txt",
            uri: "s3://late",
          },
        });
        await flushMicrotasks();
      });
      expect(rendered.container.textContent).not.toContain("late.txt");
      expect(onSend).not.toHaveBeenCalled();
    } finally {
      await rendered.unmount();
    }
  });
});
