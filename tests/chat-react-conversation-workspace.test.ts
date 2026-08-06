import { createElement, StrictMode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

import { ChatProvider } from "../packages/chat-react/src/index.js";
import {
  useConversationWorkspace,
  type ConversationWorkspaceBinding,
} from "../packages/chat-react/src/index.js";
import { createChatClient } from "../packages/chat-runtime/src/index.js";
import {
  createChatContractFixtures,
  createMemoryChatGateway,
} from "../packages/chat-testing/src/index.js";
import { deadlineAt, flushMicrotasks } from "./support/chat-react.js";

describe("useConversationWorkspace", () => {
  it("gives a host managed list, creation and selection actions", async () => {
    const memory = createMemoryChatGateway();
    const client = createChatClient({ gateway: memory.gateway });
    let binding!: ConversationWorkspaceBinding;
    const Consumer = () => {
      binding = useConversationWorkspace({ getDeadlineAt: deadlineAt });
      return createElement(
        "span",
        null,
        `${binding.snapshot.listStatus}:${binding.snapshot.selectionStatus}`,
      );
    };

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        createElement(ChatProvider, { client }, createElement(Consumer)),
      );
      await flushMicrotasks();
    });
    expect(binding.ready).toBe(true);
    expect(binding.snapshot).toMatchObject({
      selectedConversationId: memory.fixtures.conversation.id,
      selectionStatus: "ready",
    });

    await act(async () => {
      await binding.createConversation({ title: "Created by the hook" });
    });
    expect(binding.snapshot).toMatchObject({
      creating: false,
      selectionStatus: "ready",
    });
    expect(binding.snapshot.selectedConversationId).not.toBe(
      memory.fixtures.conversation.id,
    );
    expect(
      binding.snapshot.conversations.some(
        ({ title }) => title === "Created by the hook",
      ),
    ).toBe(true);

    act(() => renderer.unmount());
    expect(client.disposed).toBe(false);
    await client.dispose({ deadlineAt: deadlineAt() });
  });

  it("retires the old controller when the provider client changes", async () => {
    const firstMemory = createMemoryChatGateway();
    const secondMemory = createMemoryChatGateway({
      fixtures: createChatContractFixtures({
        conversationId: "conversation-second-client",
      }),
    });
    const firstClient = createChatClient({ gateway: firstMemory.gateway });
    const secondClient = createChatClient({ gateway: secondMemory.gateway });
    let binding!: ConversationWorkspaceBinding;
    const getDeadlineAt = deadlineAt;
    const Consumer = () => {
      binding = useConversationWorkspace({ getDeadlineAt });
      return null;
    };

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        createElement(
          ChatProvider,
          { client: firstClient },
          createElement(Consumer),
        ),
      );
      await flushMicrotasks();
    });
    const firstController = binding.controller!;
    expect(binding.snapshot.selectedConversationId).toBe(
      firstMemory.fixtures.conversation.id,
    );

    await act(async () => {
      renderer.update(
        createElement(
          ChatProvider,
          { client: secondClient },
          createElement(Consumer),
        ),
      );
      await flushMicrotasks();
    });
    expect(firstController.disposed).toBe(true);
    expect(binding.controller).not.toBe(firstController);
    expect(binding.snapshot.selectedConversationId).toBe(
      secondMemory.fixtures.conversation.id,
    );
    expect(firstClient.disposed).toBe(false);

    act(() => renderer.unmount());
    await firstClient.dispose({ deadlineAt: deadlineAt() });
    await secondClient.dispose({ deadlineAt: deadlineAt() });
  });

  it("does not leak effect-owned controllers under StrictMode replay", async () => {
    const memory = createMemoryChatGateway();
    const client = createChatClient({ gateway: memory.gateway });
    const onUnhandledError = vi.fn();
    let binding!: ConversationWorkspaceBinding;
    const Consumer = () => {
      binding = useConversationWorkspace({
        getDeadlineAt: deadlineAt,
        onUnhandledError,
      });
      return null;
    };

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        createElement(
          StrictMode,
          null,
          createElement(ChatProvider, { client }, createElement(Consumer)),
        ),
      );
      await flushMicrotasks();
    });
    expect(binding.ready).toBe(true);
    expect(binding.controller?.disposed).toBe(false);
    expect(onUnhandledError).not.toHaveBeenCalled();

    const activeController = binding.controller!;
    act(() => renderer.unmount());
    expect(activeController.disposed).toBe(true);
    await client.dispose({ deadlineAt: deadlineAt() });
  });
});
