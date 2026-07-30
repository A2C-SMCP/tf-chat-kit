import { Component, createElement, Fragment, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

import type { ChatGateway } from "../packages/chat-protocol/src/index.js";
import {
  createChatClient,
  type ChatClientSubscription,
} from "../packages/chat-runtime/src/index.js";
import {
  ChatProvider,
  OwnedChatProvider,
  useChatClient,
  useChatSelector,
  useChatSnapshot,
  type ChatClientFactory,
} from "../packages/chat-react/src/index.js";
import { createMemoryChatGateway } from "../packages/chat-testing/src/index.js";
import {
  createLoadedClient,
  deadlineAt,
  flushMicrotasks,
} from "./support/chat-react.js";

interface ErrorBoundaryProps {
  readonly children?: ReactNode;
}

interface ErrorBoundaryState {
  readonly failed: boolean;
}

class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { failed: true };
  }

  override render(): ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}

describe("@turingfocus/chat-react", () => {
  it("keeps provider context stable and only re-renders selectors whose value changed", async () => {
    const { client, memory } = await createLoadedClient();
    let clientRenderCount = 0;
    let titleRenderCount = 0;
    let snapshotRenderCount = 0;

    const ClientConsumer = () => {
      useChatClient();
      clientRenderCount += 1;
      return null;
    };
    const TitleConsumer = () => {
      const title = useChatSelector(
        (snapshot) => snapshot?.conversation.title ?? "",
      );
      titleRenderCount += 1;
      return createElement("span", null, title);
    };
    const SnapshotConsumer = () => {
      useChatSnapshot();
      snapshotRenderCount += 1;
      return null;
    };

    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(
        createElement(
          ChatProvider,
          { client },
          createElement(
            Fragment,
            null,
            createElement(ClientConsumer),
            createElement(TitleConsumer),
            createElement(SnapshotConsumer),
          ),
        ),
      );
    });

    expect(clientRenderCount).toBe(1);
    expect(titleRenderCount).toBe(1);
    expect(snapshotRenderCount).toBe(1);

    act(() => {
      memory.controller.emitUpdateToAll(memory.fixtures.realtimeMessageUpdate);
    });
    expect(clientRenderCount).toBe(1);
    expect(titleRenderCount).toBe(1);
    expect(snapshotRenderCount).toBe(2);

    act(() => {
      memory.controller.emitUpdateToAll({
        kind: "conversation.upsert",
        conversation: {
          ...memory.fixtures.conversation,
          title: "Renamed conversation",
        },
      });
    });
    expect(clientRenderCount).toBe(1);
    expect(titleRenderCount).toBe(2);
    expect(snapshotRenderCount).toBe(3);
    expect(renderer.root.findByType("span").children).toEqual([
      "Renamed conversation",
    ]);

    act(() => {
      renderer.unmount();
    });
    await client.dispose({ deadlineAt: deadlineAt() });
  });

  it("uses custom selector equality to suppress unrelated object selection updates", async () => {
    const { client, memory } = await createLoadedClient();
    let renderCount = 0;
    const isEqual = vi.fn(
      (left: { readonly title: string }, right: { readonly title: string }) =>
        left.title === right.title,
    );

    const Consumer = () => {
      const selection = useChatSelector(
        (snapshot) => ({
          title: snapshot?.conversation.title ?? "",
        }),
        isEqual,
      );
      renderCount += 1;
      return createElement("span", null, selection.title);
    };

    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(
        createElement(ChatProvider, { client }, createElement(Consumer)),
      );
    });

    act(() => {
      memory.controller.emitUpdateToAll(memory.fixtures.realtimeMessageUpdate);
    });
    expect(isEqual).toHaveBeenCalled();
    expect(renderCount).toBe(1);

    act(() => {
      memory.controller.emitUpdateToAll({
        kind: "conversation.upsert",
        conversation: {
          ...memory.fixtures.conversation,
          title: "Custom equality update",
        },
      });
    });
    expect(renderCount).toBe(2);
    expect(renderer.root.findByType("span").children).toEqual([
      "Custom equality update",
    ]);

    act(() => {
      renderer.unmount();
    });
    await client.dispose({ deadlineAt: deadlineAt() });
  });

  it("unsubscribes when a host-owned client changes without disposing either client", async () => {
    const first = await createLoadedClient();
    const secondMemory = createMemoryChatGateway();
    secondMemory.controller.setSnapshot({
      ...secondMemory.fixtures.initialSnapshot,
      conversation: {
        ...secondMemory.fixtures.conversation,
        title: "Second client",
      },
    });
    const second = await createLoadedClient(secondMemory);
    const firstSubscriptions: ChatClientSubscription[] = [];
    const secondSubscriptions: ChatClientSubscription[] = [];
    const firstSubscribe = first.client.subscribe.bind(first.client);
    const secondSubscribe = second.client.subscribe.bind(second.client);
    vi.spyOn(first.client, "subscribe").mockImplementation((listener) => {
      const subscription = firstSubscribe(listener);
      firstSubscriptions.push(subscription);
      return subscription;
    });
    vi.spyOn(second.client, "subscribe").mockImplementation((listener) => {
      const subscription = secondSubscribe(listener);
      secondSubscriptions.push(subscription);
      return subscription;
    });

    const Consumer = () =>
      createElement(
        "span",
        null,
        useChatSelector((snapshot) => snapshot?.conversation.title ?? "empty"),
      );
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(
        createElement(
          ChatProvider,
          { client: first.client },
          createElement(Consumer),
        ),
      );
    });
    expect(firstSubscriptions.length).toBeGreaterThan(0);

    act(() => {
      renderer.update(
        createElement(
          ChatProvider,
          { client: second.client },
          createElement(Consumer),
        ),
      );
    });
    expect(firstSubscriptions.every(({ closed }) => closed)).toBe(true);
    expect(first.client.disposed).toBe(false);
    expect(second.client.disposed).toBe(false);
    expect(renderer.root.findByType("span").children).toEqual([
      "Second client",
    ]);

    act(() => {
      renderer.unmount();
    });
    expect(secondSubscriptions.every(({ closed }) => closed)).toBe(true);
    expect(second.client.disposed).toBe(false);
    await Promise.all([
      first.client.dispose({ deadlineAt: deadlineAt() }),
      second.client.dispose({ deadlineAt: deadlineAt() }),
    ]);
  });

  it("creates clients after mount and disposes them on factory replacement and unmount", async () => {
    const first = await createLoadedClient();
    const secondMemory = createMemoryChatGateway();
    secondMemory.controller.setSnapshot({
      ...secondMemory.fixtures.initialSnapshot,
      conversation: {
        ...secondMemory.fixtures.conversation,
        title: "Owned replacement",
      },
    });
    const second = await createLoadedClient(secondMemory);
    const firstFactory: ChatClientFactory = {
      create: vi.fn(() => first.client),
      getDisposeOptions: () => ({ deadlineAt: deadlineAt() }),
    };
    const secondFactory: ChatClientFactory = {
      create: vi.fn(() => second.client),
      getDisposeOptions: () => ({ deadlineAt: deadlineAt() }),
    };
    const onDisposeError = vi.fn();
    const Consumer = () =>
      createElement(
        "span",
        null,
        useChatSelector((snapshot) => snapshot?.conversation.title ?? "empty"),
      );

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        createElement(
          OwnedChatProvider,
          {
            factory: firstFactory,
            fallback: createElement("i", null, "loading"),
            onDisposeError,
          },
          createElement(Consumer),
        ),
      );
    });
    expect(firstFactory.create).toHaveBeenCalledOnce();
    expect(first.client.disposed).toBe(false);

    await act(async () => {
      renderer.update(
        createElement(
          OwnedChatProvider,
          {
            factory: secondFactory,
            fallback: createElement("i", null, "loading"),
            onDisposeError,
          },
          createElement(Consumer),
        ),
      );
      await flushMicrotasks();
    });
    expect(first.client.disposed).toBe(true);
    expect(secondFactory.create).toHaveBeenCalledOnce();
    expect(renderer.root.findByType("span").children).toEqual([
      "Owned replacement",
    ]);

    await act(async () => {
      renderer.unmount();
      await flushMicrotasks();
    });
    expect(second.client.disposed).toBe(true);
    expect(onDisposeError).not.toHaveBeenCalled();
  });

  it("reports provider-owned disposal failures", async () => {
    const memory = createMemoryChatGateway();
    const disposalError = new Error("dispose failed");
    const gateway: ChatGateway = {
      dispose: async () => {
        throw disposalError;
      },
      interrupt: (input) => memory.gateway.interrupt(input),
      listConversations: (input) => memory.gateway.listConversations(input),
      loadConversation: (input) => memory.gateway.loadConversation(input),
      sendText: (input) => memory.gateway.sendText(input),
      subscribe: (input, observer) => memory.gateway.subscribe(input, observer),
    };
    const client = createChatClient({ gateway });
    const factory: ChatClientFactory = {
      create: () => client,
      getDisposeOptions: () => ({ deadlineAt: deadlineAt() }),
    };
    const onDisposeError = vi.fn();
    let renderer!: ReactTestRenderer;

    await act(async () => {
      renderer = create(
        createElement(OwnedChatProvider, {
          factory,
          onDisposeError,
        }),
      );
    });
    await act(async () => {
      renderer.unmount();
      await flushMicrotasks();
    });

    expect(onDisposeError).toHaveBeenCalledOnce();
    expect(onDisposeError).toHaveBeenCalledWith(disposalError);
    await memory.gateway.dispose({ deadlineAt: deadlineAt() });
  });

  it("reports synchronous disposal option failures", async () => {
    const { client, memory } = await createLoadedClient();
    const disposalOptionsError = new Error("dispose options failed");
    const factory: ChatClientFactory = {
      create: () => client,
      getDisposeOptions: () => {
        throw disposalOptionsError;
      },
    };
    const onDisposeError = vi.fn();
    let renderer!: ReactTestRenderer;

    await act(async () => {
      renderer = create(
        createElement(OwnedChatProvider, {
          factory,
          onDisposeError,
        }),
      );
    });
    await act(async () => {
      renderer.unmount();
      await flushMicrotasks();
    });

    expect(onDisposeError).toHaveBeenCalledOnce();
    expect(onDisposeError).toHaveBeenCalledWith(disposalOptionsError);
    expect(client.disposed).toBe(true);
    expect(memory.controller.disposed).toBe(true);
  });

  it("keeps disposal failures bound to the last committed handler", async () => {
    const memory = createMemoryChatGateway();
    const disposalError = new Error("dispose failed");
    const renderError = new Error("render abandoned");
    const gateway: ChatGateway = {
      dispose: async () => {
        throw disposalError;
      },
      interrupt: (input) => memory.gateway.interrupt(input),
      listConversations: (input) => memory.gateway.listConversations(input),
      loadConversation: (input) => memory.gateway.loadConversation(input),
      sendText: (input) => memory.gateway.sendText(input),
      subscribe: (input, observer) => memory.gateway.subscribe(input, observer),
    };
    const client = createChatClient({ gateway });
    const factory: ChatClientFactory = {
      create: () => client,
      getDisposeOptions: () => ({ deadlineAt: deadlineAt() }),
    };
    const committedHandler = vi.fn();
    const abandonedHandler = vi.fn();
    const ThrowDuringRender = (): never => {
      throw renderError;
    };
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    let renderer!: ReactTestRenderer;

    try {
      await act(async () => {
        renderer = create(
          createElement(
            ErrorBoundary,
            null,
            createElement(
              OwnedChatProvider,
              {
                factory,
                onDisposeError: committedHandler,
              },
              createElement("span", null, "committed"),
            ),
          ),
        );
      });
      await act(async () => {
        renderer.update(
          createElement(
            ErrorBoundary,
            null,
            createElement(
              OwnedChatProvider,
              {
                factory,
                onDisposeError: abandonedHandler,
              },
              createElement(ThrowDuringRender),
            ),
          ),
        );
        await flushMicrotasks();
      });
    } finally {
      consoleError.mockRestore();
    }

    expect(client.disposed).toBe(true);
    expect(committedHandler).toHaveBeenCalledOnce();
    expect(committedHandler).toHaveBeenCalledWith(disposalError);
    expect(abandonedHandler).not.toHaveBeenCalled();
    await memory.gateway.dispose({ deadlineAt: deadlineAt() });
  });

  it("isolates multiple providers and supplies an explicit server snapshot", async () => {
    const first = await createLoadedClient();
    const second = await createLoadedClient();
    let firstRenderCount = 0;
    let secondRenderCount = 0;

    const Consumer = ({ owner }: { readonly owner: "first" | "second" }) => {
      useChatSelector((snapshot) => snapshot?.timeline.length ?? 0);
      if (owner === "first") firstRenderCount += 1;
      else secondRenderCount += 1;
      return null;
    };
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(
        createElement(
          Fragment,
          null,
          createElement(
            ChatProvider,
            { client: first.client },
            createElement(Consumer, { owner: "first" }),
          ),
          createElement(
            ChatProvider,
            { client: second.client },
            createElement(Consumer, { owner: "second" }),
          ),
        ),
      );
    });
    act(() => {
      first.memory.controller.emitUpdateToAll(
        first.memory.fixtures.realtimeMessageUpdate,
      );
    });
    expect(firstRenderCount).toBe(2);
    expect(secondRenderCount).toBe(1);

    const ServerConsumer = () =>
      createElement(
        "span",
        null,
        useChatSelector(
          (snapshot) => snapshot?.conversation.title ?? "missing",
        ),
      );
    const html = renderToString(
      createElement(
        ChatProvider,
        {
          client: first.client,
          serverSnapshot: first.memory.fixtures.initialSnapshot,
        },
        createElement(ServerConsumer),
      ),
    );
    expect(html).toContain(first.memory.fixtures.conversation.title);

    act(() => {
      renderer.unmount();
    });
    await Promise.all([
      first.client.dispose({ deadlineAt: deadlineAt() }),
      second.client.dispose({ deadlineAt: deadlineAt() }),
    ]);
  });
});
