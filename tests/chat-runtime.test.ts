import { describe, expect, it, vi } from "vitest";

import type {
  AgentEvent,
  ChatError,
  ChatGateway,
  ChatSnapshot,
  ChatUpdate,
  GatewayRequestOptions,
  GatewaySubscription,
  LoadConversationInput,
  Message,
} from "../packages/chat-protocol/src/index.js";
import {
  createChatClient,
  type ChatClient,
} from "../packages/chat-runtime/src/index.js";
import {
  createChatContractFixtures,
  createMemoryChatGateway,
  createRuntimeContractCases,
  type RuntimeContractAdapter,
} from "../packages/chat-testing/src/index.js";

const deadlineAt = (): number => Date.now() + 60_000;

const wrapGateway = (
  gateway: ChatGateway,
  overrides: Partial<ChatGateway>,
): ChatGateway => ({
  dispose: (input) => gateway.dispose(input),
  interrupt: (input) => gateway.interrupt(input),
  listConversations: (input) => gateway.listConversations(input),
  loadConversation: (input) => gateway.loadConversation(input),
  sendText: (input) => gateway.sendText(input),
  subscribe: (input, observer) => gateway.subscribe(input, observer),
  ...overrides,
});

const realtimeTextUpdate = (template: ChatUpdate, text: string): ChatUpdate => {
  if (
    template.kind !== "timeline.upsert" ||
    template.item.kind !== "message" ||
    template.item.content.kind !== "text"
  ) {
    throw new Error("Expected a realtime text message fixture");
  }
  return {
    ...template,
    item: {
      ...template.item,
      content: { kind: "text", text },
    },
  };
};

const createRuntimeAdapter = (gateway: ChatGateway): RuntimeContractAdapter => {
  const client = createChatClient({ gateway });
  return {
    dispose: (options) => client.dispose(options),
    getSnapshot: () => client.getSnapshot(),
    interrupt: (input) => client.interrupt(input),
    loadConversation: async (input) => {
      await client.loadConversation(input);
    },
    sendText: (input) => client.sendText(input),
    settle: () => Promise.resolve(),
    subscribe: (listener) => client.subscribe(listener),
  };
};

describe("ChatClient Runtime contract", () => {
  const cases = createRuntimeContractCases((gateway) =>
    createRuntimeAdapter(gateway),
  );

  expect(new Set(cases.map(({ name }) => name)).size).toBe(cases.length);
  for (const contractCase of cases) {
    it(contractCase.name, () => contractCase.run());
  }
});

const loadInitialSnapshot = async (
  client: ChatClient,
  conversationId: string,
): Promise<ChatSnapshot> => {
  const loaded = await client.loadConversation({
    conversationId,
    deadlineAt: deadlineAt(),
  });
  expect(loaded.ok).toBe(true);
  const snapshot = client.getSnapshot();
  expect(snapshot).not.toBeNull();
  return snapshot!;
};

describe("ChatClient lifecycle and merge behavior", () => {
  it("buffers realtime messages, Run changes, and errors before the initial snapshot loads", async () => {
    const memory = createMemoryChatGateway();
    const gateway = wrapGateway(memory.gateway, {
      loadConversation: (input) => {
        expect(
          memory.controller.emitUpdateToAll(
            memory.fixtures.realtimeMessageUpdate,
          ),
        ).toBe(1);
        expect(
          memory.controller.emitUpdateToAll(memory.fixtures.runUpdate),
        ).toBe(1);
        expect(
          memory.controller.emitError(memory.fixtures.authenticationError),
        ).toBe(1);
        return memory.gateway.loadConversation(input);
      },
    });
    const client = createChatClient({ gateway });

    await expect(
      client.loadConversation({
        conversationId: memory.fixtures.conversation.id,
        deadlineAt: deadlineAt(),
      }),
    ).resolves.toMatchObject({ ok: true });
    expect(
      client
        .getSnapshot()
        ?.timeline.some(({ id }) => id === "message-realtime"),
    ).toBe(true);
    expect(client.getSnapshot()?.run).toMatchObject({
      id: "run-replaced",
      status: "succeeded",
    });
    expect(client.getSnapshot()?.error).toMatchObject({
      code: "authentication",
      conversationId: memory.fixtures.conversation.id,
    });

    await client.dispose({ deadlineAt: deadlineAt() });
  });

  it("loads snapshots that explicitly disable live updates", async () => {
    const memory = createMemoryChatGateway();
    memory.controller.setSnapshot({
      ...memory.fixtures.initialSnapshot,
      capabilities: {
        ...memory.fixtures.initialSnapshot.capabilities,
        liveUpdates: false,
      },
    });
    const client = createChatClient({ gateway: memory.gateway });

    await expect(
      client.loadConversation({
        conversationId: memory.fixtures.conversation.id,
        deadlineAt: deadlineAt(),
      }),
    ).resolves.toMatchObject({
      ok: true,
      value: { capabilities: { liveUpdates: false } },
    });
    expect(
      memory.controller.calls.filter(
        ({ operation }) => operation === "subscribe",
      ),
    ).toHaveLength(1);
    expect(
      memory.controller.emitUpdateToAll(memory.fixtures.realtimeMessageUpdate),
    ).toBe(0);

    await client.dispose({ deadlineAt: deadlineAt() });
  });

  it("notifies independent subscriptions only for actual state changes", async () => {
    const memory = createMemoryChatGateway();
    const client = createChatClient({ gateway: memory.gateway });
    await loadInitialSnapshot(client, memory.fixtures.conversation.id);

    const firstListener = vi.fn();
    const secondListener = vi.fn();
    const first = client.subscribe(firstListener);
    const second = client.subscribe(secondListener);
    expect(firstListener).toHaveBeenCalledOnce();
    expect(secondListener).toHaveBeenCalledOnce();

    expect(
      memory.controller.emitUpdateToAll(
        memory.fixtures.duplicateMessageUpdates[0]!,
      ),
    ).toBe(1);
    expect(firstListener).toHaveBeenCalledTimes(2);
    expect(secondListener).toHaveBeenCalledTimes(2);

    expect(
      memory.controller.emitUpdateToAll(
        memory.fixtures.duplicateMessageUpdates[1]!,
      ),
    ).toBe(1);
    expect(firstListener).toHaveBeenCalledTimes(2);
    expect(secondListener).toHaveBeenCalledTimes(2);

    first.dispose();
    memory.controller.emitUpdateToAll(memory.fixtures.unknownEventUpdate);
    expect(first.closed).toBe(true);
    expect(firstListener).toHaveBeenCalledTimes(2);
    expect(secondListener).toHaveBeenCalledTimes(3);

    second.dispose();
    await client.dispose({ deadlineAt: deadlineAt() });
  });

  it("merges an older page without overwriting newer realtime items", async () => {
    const memory = createMemoryChatGateway();
    memory.controller.setSnapshot({
      ...memory.fixtures.initialSnapshot,
      pageInfo: { previousCursor: "current-cursor", hasPreviousPage: true },
    });
    const client = createChatClient({ gateway: memory.gateway });
    await loadInitialSnapshot(client, memory.fixtures.conversation.id);
    memory.controller.emitUpdateToAll(memory.fixtures.replacementMessageUpdate);

    const replacement = client
      .getSnapshot()!
      .timeline.find(({ id }) => id === "message-realtime")!;
    const initialCreatedAt =
      memory.fixtures.initialSnapshot.timeline[0]!.createdAt;
    const olderMessage: Message = {
      kind: "message",
      id: "message-older-page",
      conversationId: memory.fixtures.conversation.id,
      role: "assistant",
      content: { kind: "text", text: "Older page" },
      createdAt: initialCreatedAt - 10_000,
    };
    memory.controller.setSnapshot({
      ...memory.fixtures.initialSnapshot,
      timeline: [
        olderMessage,
        {
          ...replacement,
          ...(replacement.kind === "message" &&
          replacement.content.kind === "text"
            ? { content: { kind: "text" as const, text: "Stale history" } }
            : {}),
        },
      ],
      pageInfo: { previousCursor: "older-cursor", hasPreviousPage: true },
    });

    const loaded = await client.loadConversation({
      conversationId: memory.fixtures.conversation.id,
      previousCursor: "current-cursor",
      deadlineAt: deadlineAt(),
    });
    expect(loaded.ok).toBe(true);
    const snapshot = client.getSnapshot()!;
    expect(snapshot.timeline.map(({ id }) => id)).toContain(
      "message-older-page",
    );
    const retained = snapshot.timeline.find(
      ({ id }) => id === "message-realtime",
    );
    expect(retained).toBe(replacement);
    expect(
      retained?.kind === "message" &&
        retained.content.kind === "text" &&
        retained.content.text,
    ).toBe("Realtime replacement");
    expect(snapshot.pageInfo.previousCursor).toBe("older-cursor");

    await client.dispose({ deadlineAt: deadlineAt() });
  });

  it("ignores a load result superseded by a newer load", async () => {
    const memory = createMemoryChatGateway();
    const client = createChatClient({ gateway: memory.gateway });
    const hold = memory.controller.holdNext("loadConversation");
    const input: LoadConversationInput = {
      conversationId: memory.fixtures.conversation.id,
      deadlineAt: deadlineAt(),
    };
    const staleLoad = client.loadConversation(input);
    await hold.started;

    const newestSnapshot: ChatSnapshot = {
      ...memory.fixtures.initialSnapshot,
      conversation: {
        ...memory.fixtures.conversation,
        title: "Newest load",
      },
    };
    memory.controller.setSnapshot(newestSnapshot);
    const newestLoad = await client.loadConversation(input);
    expect(newestLoad.ok).toBe(true);
    expect(client.getSnapshot()?.conversation.title).toBe("Newest load");

    memory.controller.setSnapshot({
      ...memory.fixtures.initialSnapshot,
      conversation: {
        ...memory.fixtures.conversation,
        title: "Late stale load",
      },
    });
    hold.release();
    await expect(staleLoad).resolves.toMatchObject({
      ok: false,
      error: { code: "conflict" },
    });
    expect(client.getSnapshot()?.conversation.title).toBe("Newest load");

    await client.dispose({ deadlineAt: deadlineAt() });
  });

  it("returns conflict when a subscription-establishing load is superseded", async () => {
    const memory = createMemoryChatGateway();
    const client = createChatClient({ gateway: memory.gateway });
    const hold = memory.controller.holdNext("subscribe");
    const input: LoadConversationInput = {
      conversationId: memory.fixtures.conversation.id,
      deadlineAt: deadlineAt(),
    };
    const staleLoad = client.loadConversation(input);
    await hold.started;

    memory.controller.setSnapshot({
      ...memory.fixtures.initialSnapshot,
      conversation: {
        ...memory.fixtures.conversation,
        title: "Replacement subscription",
      },
    });
    await expect(client.loadConversation(input)).resolves.toMatchObject({
      ok: true,
      value: { conversation: { title: "Replacement subscription" } },
    });

    hold.release();
    await expect(staleLoad).resolves.toMatchObject({
      ok: false,
      error: { code: "conflict" },
    });
    expect(hold.resourceDisposeCount).toBe(1);
    expect(client.getSnapshot()?.conversation.title).toBe(
      "Replacement subscription",
    );

    await client.dispose({ deadlineAt: deadlineAt() });
  });

  it("returns conflict and releases a subscription that completes after dispose", async () => {
    const memory = createMemoryChatGateway();
    const client = createChatClient({ gateway: memory.gateway });
    const hold = memory.controller.holdNext("subscribe");
    const pending = client.loadConversation({
      conversationId: memory.fixtures.conversation.id,
      deadlineAt: deadlineAt(),
    });
    await hold.started;

    const disposing = client.dispose({ deadlineAt: deadlineAt() });
    hold.release();
    await expect(pending).resolves.toMatchObject({
      ok: false,
      error: { code: "conflict" },
    });
    await disposing;
    expect(client.getSnapshot()).toBeNull();
    expect(hold.resourceDisposeCount).toBe(1);
  });

  it("keeps the prior conversation subscribed when a switch fails", async () => {
    const memory = createMemoryChatGateway();
    const client = createChatClient({ gateway: memory.gateway });
    await loadInitialSnapshot(client, memory.fixtures.conversation.id);

    const failed = await client.loadConversation({
      conversationId: "conversation-missing",
      deadlineAt: deadlineAt(),
    });
    expect(failed).toMatchObject({
      ok: false,
      error: { code: "not-found" },
    });
    expect(client.getSnapshot()?.conversation.id).toBe(
      memory.fixtures.conversation.id,
    );

    expect(
      memory.controller.emitUpdateToAll(memory.fixtures.realtimeMessageUpdate),
    ).toBe(1);
    expect(
      client
        .getSnapshot()
        ?.timeline.some(({ id }) => id === "message-realtime"),
    ).toBe(true);

    await client.dispose({ deadlineAt: deadlineAt() });
  });

  it("replays old-subscription updates received during a same-conversation reload", async () => {
    const memory = createMemoryChatGateway();
    const client = createChatClient({ gateway: memory.gateway });
    await loadInitialSnapshot(client, memory.fixtures.conversation.id);
    const realtimeVisibility: boolean[] = [];
    const subscription = client.subscribe((snapshot) => {
      realtimeVisibility.push(
        snapshot.timeline.some(({ id }) => id === "message-realtime"),
      );
    });

    const hold = memory.controller.holdNext("subscribe");
    const reloading = client.loadConversation({
      conversationId: memory.fixtures.conversation.id,
      deadlineAt: deadlineAt(),
    });
    await hold.started;
    expect(
      memory.controller.emitUpdateToAll(memory.fixtures.realtimeMessageUpdate),
    ).toBe(1);
    expect(
      client
        .getSnapshot()
        ?.timeline.some(({ id }) => id === "message-realtime"),
    ).toBe(true);

    hold.release();
    await expect(reloading).resolves.toMatchObject({ ok: true });
    expect(
      client
        .getSnapshot()
        ?.timeline.some(({ id }) => id === "message-realtime"),
    ).toBe(true);
    expect(realtimeVisibility).toEqual([false, true]);

    subscription.dispose();
    await client.dispose({ deadlineAt: deadlineAt() });
  });

  it("retains history committed while a same-conversation reload establishes its subscription", async () => {
    const memory = createMemoryChatGateway();
    const conversationId = memory.fixtures.conversation.id;
    memory.controller.setSnapshot({
      ...memory.fixtures.initialSnapshot,
      pageInfo: { previousCursor: "cursor-1", hasPreviousPage: true },
    });
    const client = createChatClient({ gateway: memory.gateway });
    await loadInitialSnapshot(client, conversationId);

    const hold = memory.controller.holdNext("subscribe");
    const reloading = client.loadConversation({
      conversationId,
      deadlineAt: deadlineAt(),
    });
    await hold.started;

    const olderMessage: Message = {
      kind: "message",
      id: "message-older-during-reload",
      conversationId,
      role: "assistant",
      content: { kind: "text", text: "Older during reload" },
      createdAt: memory.fixtures.initialSnapshot.timeline[0]!.createdAt - 1,
    };
    memory.controller.setSnapshot({
      ...memory.fixtures.initialSnapshot,
      timeline: [olderMessage, ...memory.fixtures.initialSnapshot.timeline],
      pageInfo: { previousCursor: "cursor-2", hasPreviousPage: true },
    });
    await expect(
      client.loadConversation({
        conversationId,
        previousCursor: "cursor-1",
        deadlineAt: deadlineAt(),
      }),
    ).resolves.toMatchObject({
      ok: true,
      value: { pageInfo: { previousCursor: "cursor-2" } },
    });

    hold.release();
    await expect(reloading).resolves.toMatchObject({ ok: true });
    expect(client.getSnapshot()?.pageInfo.previousCursor).toBe("cursor-2");
    expect(
      client.getSnapshot()?.timeline.some(({ id }) => id === olderMessage.id),
    ).toBe(true);

    await client.dispose({ deadlineAt: deadlineAt() });
  });

  it("replays old-subscription updates received while a reload snapshot is pending", async () => {
    const memory = createMemoryChatGateway();
    const client = createChatClient({ gateway: memory.gateway });
    await loadInitialSnapshot(client, memory.fixtures.conversation.id);

    const hold = memory.controller.holdNext("loadConversation");
    const reloading = client.loadConversation({
      conversationId: memory.fixtures.conversation.id,
      deadlineAt: deadlineAt(),
    });
    await hold.started;
    expect(
      memory.controller.emitUpdateToAll(memory.fixtures.realtimeMessageUpdate),
    ).toBe(2);
    expect(
      client
        .getSnapshot()
        ?.timeline.some(({ id }) => id === "message-realtime"),
    ).toBe(true);

    hold.release();
    await expect(reloading).resolves.toMatchObject({ ok: true });
    expect(
      client
        .getSnapshot()
        ?.timeline.some(({ id }) => id === "message-realtime"),
    ).toBe(true);

    await client.dispose({ deadlineAt: deadlineAt() });
  });

  it.each(["loadConversation", "subscribe"] as const)(
    "replays global errors during the %s reload handoff window",
    async (holdPoint) => {
      const memory = createMemoryChatGateway();
      const client = createChatClient({ gateway: memory.gateway });
      await loadInitialSnapshot(client, memory.fixtures.conversation.id);

      const hold = memory.controller.holdNext(holdPoint);
      const reloading = client.loadConversation({
        conversationId: memory.fixtures.conversation.id,
        deadlineAt: deadlineAt(),
      });
      await hold.started;
      memory.controller.emitUpdateToAll({
        kind: "error.reported",
        error: {
          code: "network",
          message: "Global error during reload",
          retryable: true,
        },
      });
      expect(client.getSnapshot()?.error?.message).toBe(
        "Global error during reload",
      );

      hold.release();
      await expect(reloading).resolves.toMatchObject({ ok: true });
      expect(client.getSnapshot()?.error?.message).toBe(
        "Global error during reload",
      );

      await client.dispose({ deadlineAt: deadlineAt() });
    },
  );

  it("drains prepared subscription notifications in FIFO order under listener reentry", async () => {
    const memory = createMemoryChatGateway();
    const first = realtimeTextUpdate(
      memory.fixtures.realtimeMessageUpdate,
      "v1",
    );
    const second = realtimeTextUpdate(
      memory.fixtures.realtimeMessageUpdate,
      "v2",
    );
    const reentrant = realtimeTextUpdate(
      memory.fixtures.realtimeMessageUpdate,
      "v3",
    );
    let emitReentrant: (() => void) | undefined;
    const gateway = wrapGateway(memory.gateway, {
      subscribe: async (input, observer) => {
        emitReentrant = () => observer.next(reentrant);
        observer.next(first);
        observer.next(second);
        return memory.gateway.subscribe(input, observer);
      },
    });
    const client = createChatClient({ gateway });
    client.subscribe((snapshot) => {
      const item = snapshot.timeline.find(
        ({ id }) => id === "message-realtime",
      );
      if (
        item?.kind === "message" &&
        item.content.kind === "text" &&
        item.content.text === "v1"
      ) {
        emitReentrant?.();
      }
    });

    await loadInitialSnapshot(client, memory.fixtures.conversation.id);
    const item = client
      .getSnapshot()!
      .timeline.find(({ id }) => id === "message-realtime");
    expect(
      item?.kind === "message" &&
        item.content.kind === "text" &&
        item.content.text,
    ).toBe("v3");

    await client.dispose({ deadlineAt: deadlineAt() });
  });

  it("notifies every listener once per snapshot under synchronous reentry", async () => {
    const memory = createMemoryChatGateway();
    const client = createChatClient({ gateway: memory.gateway });
    await loadInitialSnapshot(client, memory.fixtures.conversation.id);
    const first = realtimeTextUpdate(
      memory.fixtures.realtimeMessageUpdate,
      "v1",
    );
    const second = realtimeTextUpdate(
      memory.fixtures.realtimeMessageUpdate,
      "v2",
    );
    const seen: string[] = [];
    const firstSubscription = client.subscribe((snapshot) => {
      const item = snapshot.timeline.find(
        ({ id }) => id === "message-realtime",
      );
      if (
        item?.kind === "message" &&
        item.content.kind === "text" &&
        item.content.text === "v1"
      ) {
        memory.controller.emitUpdateToAll(second);
      }
    });
    const secondSubscription = client.subscribe((snapshot) => {
      const item = snapshot.timeline.find(
        ({ id }) => id === "message-realtime",
      );
      if (item?.kind === "message" && item.content.kind === "text") {
        expect(client.getSnapshot()).toBe(snapshot);
        seen.push(item.content.text);
      }
    });

    memory.controller.emitUpdateToAll(first);
    expect(seen).toEqual(["v1", "v2"]);

    firstSubscription.dispose();
    secondSubscription.dispose();
    await client.dispose({ deadlineAt: deadlineAt() });
  });

  it("keeps pagination cursor monotonic when responses settle out of order", async () => {
    const memory = createMemoryChatGateway();
    memory.controller.setSnapshot({
      ...memory.fixtures.initialSnapshot,
      pageInfo: { previousCursor: "cursor-1", hasPreviousPage: true },
    });
    const client = createChatClient({ gateway: memory.gateway });
    await loadInitialSnapshot(client, memory.fixtures.conversation.id);

    const hold = memory.controller.holdNext("loadConversation");
    const input: LoadConversationInput = {
      conversationId: memory.fixtures.conversation.id,
      previousCursor: "cursor-1",
      deadlineAt: deadlineAt(),
    };
    const stalePage = client.loadConversation(input);
    await hold.started;

    memory.controller.setSnapshot({
      ...memory.fixtures.initialSnapshot,
      pageInfo: { previousCursor: "cursor-3", hasPreviousPage: true },
    });
    await expect(client.loadConversation(input)).resolves.toMatchObject({
      ok: true,
      value: { pageInfo: { previousCursor: "cursor-3" } },
    });

    memory.controller.setSnapshot({
      ...memory.fixtures.initialSnapshot,
      pageInfo: { previousCursor: "cursor-2", hasPreviousPage: true },
    });
    hold.release();
    await expect(stalePage).resolves.toMatchObject({
      ok: false,
      error: { code: "conflict" },
    });
    expect(client.getSnapshot()?.pageInfo.previousCursor).toBe("cursor-3");

    await client.dispose({ deadlineAt: deadlineAt() });
  });

  it("rejects history snapshots returned for another conversation", async () => {
    const memory = createMemoryChatGateway();
    memory.controller.setSnapshot({
      ...memory.fixtures.initialSnapshot,
      pageInfo: { previousCursor: "cursor-1", hasPreviousPage: true },
    });
    const foreignMessage: Message = {
      kind: "message",
      id: "foreign-history",
      conversationId: "conversation-foreign",
      role: "assistant",
      content: { kind: "text", text: "Must remain isolated" },
      createdAt: memory.fixtures.initialSnapshot.timeline[0]!.createdAt - 10,
    };
    const gateway = wrapGateway(memory.gateway, {
      loadConversation: async (input) => {
        if (input.previousCursor === undefined) {
          return memory.gateway.loadConversation(input);
        }
        return {
          ok: true,
          value: {
            ...memory.fixtures.initialSnapshot,
            conversation: {
              ...memory.fixtures.conversation,
              id: "conversation-foreign",
            },
            timeline: [foreignMessage],
            pageInfo: {
              previousCursor: "foreign-cursor",
              hasPreviousPage: true,
            },
          },
        };
      },
    });
    const client = createChatClient({ gateway });
    await loadInitialSnapshot(client, memory.fixtures.conversation.id);
    const before = client.getSnapshot();
    const listener = vi.fn();
    const subscription = client.subscribe(listener);
    listener.mockClear();

    await expect(
      client.loadConversation({
        conversationId: memory.fixtures.conversation.id,
        previousCursor: "cursor-1",
        deadlineAt: deadlineAt(),
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "validation" },
    });
    expect(client.getSnapshot()).toBe(before);
    expect(listener).not.toHaveBeenCalled();

    subscription.dispose();
    await client.dispose({ deadlineAt: deadlineAt() });
  });

  it("returns a structured conflict when a history listener disposes the client", async () => {
    const memory = createMemoryChatGateway();
    const conversationId = memory.fixtures.conversation.id;
    memory.controller.setSnapshot({
      ...memory.fixtures.initialSnapshot,
      pageInfo: { previousCursor: "cursor-1", hasPreviousPage: true },
    });
    const client = createChatClient({ gateway: memory.gateway });
    await loadInitialSnapshot(client, conversationId);
    const olderMessage: Message = {
      kind: "message",
      id: "message-dispose-during-history",
      conversationId,
      role: "assistant",
      content: { kind: "text", text: "Dispose during history" },
      createdAt: memory.fixtures.initialSnapshot.timeline[0]!.createdAt - 1,
    };
    memory.controller.setSnapshot({
      ...memory.fixtures.initialSnapshot,
      timeline: [olderMessage, ...memory.fixtures.initialSnapshot.timeline],
      pageInfo: { hasPreviousPage: false },
    });
    let disposing: Promise<void> | undefined;
    const subscription = client.subscribe((snapshot) => {
      if (
        disposing === undefined &&
        snapshot.timeline.some(({ id }) => id === olderMessage.id)
      ) {
        disposing = client.dispose({ deadlineAt: deadlineAt() });
      }
    });

    await expect(
      client.loadConversation({
        conversationId,
        previousCursor: "cursor-1",
        deadlineAt: deadlineAt(),
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "conflict" },
    });
    await disposing;
    expect(subscription.closed).toBe(true);
    expect(client.getSnapshot()).toBeNull();
  });

  it("keeps message and event namespaces independent for the same raw id", async () => {
    const memory = createMemoryChatGateway();
    const sharedMessage: Message = {
      kind: "message",
      id: "shared-id",
      conversationId: memory.fixtures.conversation.id,
      role: "user",
      content: { kind: "text", text: "Shared identity" },
      createdAt: memory.fixtures.initialSnapshot.timeline[0]!.createdAt + 10,
    };
    memory.controller.setSnapshot({
      ...memory.fixtures.initialSnapshot,
      timeline: [...memory.fixtures.initialSnapshot.timeline, sharedMessage],
    });
    const client = createChatClient({ gateway: memory.gateway });
    await loadInitialSnapshot(client, memory.fixtures.conversation.id);

    memory.controller.emitUpdateToAll({
      kind: "event.transition.upsert",
      conversationId: memory.fixtures.conversation.id,
      event: {
        eventCategory: "generic",
        id: "shared-id",
        eventType: "shared-event",
        createdAt: sharedMessage.createdAt + 10,
        transition: {
          id: "shared-transition",
          status: "running",
          occurredAt: sharedMessage.createdAt + 20,
        },
      },
    });

    const sharedItems = client
      .getSnapshot()!
      .timeline.filter(({ id }) => id === "shared-id");
    expect(sharedItems.map(({ kind }) => kind)).toEqual([
      "message",
      "agent-event",
    ]);
    expect(client.getSnapshot()?.error).toBeUndefined();

    await client.dispose({ deadlineAt: deadlineAt() });
  });

  it("does not attach an old interrupt failure to a replacement run", async () => {
    const memory = createMemoryChatGateway();
    const client = createChatClient({ gateway: memory.gateway });
    await loadInitialSnapshot(client, memory.fixtures.conversation.id);
    const hold = memory.controller.holdNext("interrupt");
    const pending = client.interrupt({
      conversationId: memory.fixtures.conversation.id,
      runId: memory.fixtures.initialSnapshot.run!.id,
      deadlineAt: deadlineAt(),
    });
    await hold.started;

    memory.controller.emitUpdateToAll({
      kind: "run.replace",
      conversationId: memory.fixtures.conversation.id,
      run: {
        id: "replacement-run",
        conversationId: memory.fixtures.conversation.id,
        status: "running",
        canInterrupt: true,
      },
    });
    memory.controller.setInterruptResult({
      ok: false,
      error: {
        code: "network",
        message: "Late interrupt failure",
        retryable: true,
        conversationId: memory.fixtures.conversation.id,
      },
    });
    hold.release();

    await expect(pending).resolves.toMatchObject({
      ok: false,
      error: { code: "network" },
    });
    expect(client.getSnapshot()?.run?.id).toBe("replacement-run");
    expect(client.getSnapshot()?.error).toBeUndefined();

    await client.dispose({ deadlineAt: deadlineAt() });
  });

  it("pins an omitted interrupt runId before a replacement run appears", async () => {
    const memory = createMemoryChatGateway();
    const client = createChatClient({ gateway: memory.gateway });
    await loadInitialSnapshot(client, memory.fixtures.conversation.id);
    const initialRunId = memory.fixtures.initialSnapshot.run!.id;
    const hold = memory.controller.holdNext("interrupt");
    const pending = client.interrupt({
      conversationId: memory.fixtures.conversation.id,
      deadlineAt: deadlineAt(),
    });
    await hold.started;

    expect(
      memory.controller.calls.find(
        ({ operation }) => operation === "interrupt",
      ),
    ).toMatchObject({
      operation: "interrupt",
      input: { runId: initialRunId },
    });

    const replacementRun = {
      id: "replacement-run",
      conversationId: memory.fixtures.conversation.id,
      status: "running" as const,
      canInterrupt: true,
    };
    memory.controller.setSnapshot({
      ...memory.fixtures.initialSnapshot,
      run: replacementRun,
    });
    memory.controller.emitUpdateToAll({
      kind: "run.replace",
      conversationId: memory.fixtures.conversation.id,
      run: replacementRun,
    });
    hold.release();

    await expect(pending).resolves.toMatchObject({
      ok: false,
      error: { code: "conflict", retryable: false },
    });
    expect(client.getSnapshot()?.run).toEqual(replacementRun);
    expect(client.getSnapshot()?.error).toBeUndefined();

    await client.dispose({ deadlineAt: deadlineAt() });
  });

  it("rejects stale interrupts without dispatching them", async () => {
    const memory = createMemoryChatGateway();
    const client = createChatClient({ gateway: memory.gateway });
    await loadInitialSnapshot(client, memory.fixtures.conversation.id);

    const result = await client.interrupt({
      conversationId: memory.fixtures.conversation.id,
      runId: "stale-run",
      deadlineAt: deadlineAt(),
    });
    expect(result).toMatchObject({
      ok: false,
      error: { code: "conflict", retryable: false },
    });
    expect(
      memory.controller.calls.filter(
        ({ operation }) => operation === "interrupt",
      ),
    ).toHaveLength(0);

    await client.dispose({ deadlineAt: deadlineAt() });
  });

  it("surfaces command failures without leaking mutable error data", async () => {
    const memory = createMemoryChatGateway();
    const client = createChatClient({ gateway: memory.gateway });
    await loadInitialSnapshot(client, memory.fixtures.conversation.id);
    const error: ChatError = {
      code: "authentication",
      message: "Session expired",
      retryable: true,
      conversationId: memory.fixtures.conversation.id,
      details: { reason: "expired" },
    };
    memory.controller.failNext("sendText", error);

    const result = await client.sendText({
      conversationId: memory.fixtures.conversation.id,
      text: "Will fail",
      deadlineAt: deadlineAt(),
    });
    expect(result).toEqual({ ok: false, error });
    const exposed = client.getSnapshot()!.error!;
    expect(Object.isFrozen(exposed)).toBe(true);
    expect(Object.isFrozen(exposed.details)).toBe(true);

    await client.dispose({ deadlineAt: deadlineAt() });
  });

  it("preserves special raw keys without changing the cloned prototype", async () => {
    const memory = createMemoryChatGateway();
    const client = createChatClient({ gateway: memory.gateway });
    await loadInitialSnapshot(client, memory.fixtures.conversation.id);

    memory.controller.emitUpdateToAll(memory.fixtures.unknownEventUpdate);
    const event = client
      .getSnapshot()!
      .timeline.find(({ id }) => id === "event-unknown");
    expect(event?.kind).toBe("unknown-event");
    if (event?.kind !== "unknown-event") throw new Error("Missing event");
    const raw = event.raw as Record<string, unknown>;
    expect(Object.hasOwn(raw, "__proto__")).toBe(true);
    expect(raw["__proto__"]).toEqual({ preserved: true });
    expect(Object.getPrototypeOf(raw)).toBe(Object.prototype);

    await client.dispose({ deadlineAt: deadlineAt() });
  });

  it.each(["generic", "tool"] as const)(
    "preserves %s event raw data across transition upserts",
    async (eventCategory) => {
      const memory = createMemoryChatGateway();
      const conversationId = memory.fixtures.conversation.id;
      const event: AgentEvent =
        eventCategory === "tool"
          ? {
              kind: "agent-event",
              eventCategory,
              id: "event-with-raw",
              conversationId,
              eventType: "raw-probe",
              status: "running",
              createdAt: 1,
              raw: { diagnostic: "keep-me" },
              transitions: [
                {
                  id: "transition-initial",
                  status: "running",
                  occurredAt: 1,
                  toolCall: { name: "probe" },
                },
              ],
            }
          : {
              kind: "agent-event",
              eventCategory,
              id: "event-with-raw",
              conversationId,
              eventType: "raw-probe",
              status: "running",
              createdAt: 1,
              raw: { diagnostic: "keep-me" },
              transitions: [
                {
                  id: "transition-initial",
                  status: "running",
                  occurredAt: 1,
                },
              ],
            };
      memory.controller.setSnapshot({
        ...memory.fixtures.initialSnapshot,
        timeline: [event],
      });
      const client = createChatClient({ gateway: memory.gateway });
      await loadInitialSnapshot(client, conversationId);

      const update: ChatUpdate =
        eventCategory === "tool"
          ? {
              kind: "event.transition.upsert",
              conversationId,
              event: {
                eventCategory,
                id: event.id,
                eventType: event.eventType,
                createdAt: event.createdAt,
                transition: {
                  id: "transition-complete",
                  status: "success",
                  occurredAt: 2,
                  toolReturn: { success: true },
                },
              },
            }
          : {
              kind: "event.transition.upsert",
              conversationId,
              event: {
                eventCategory,
                id: event.id,
                eventType: event.eventType,
                createdAt: event.createdAt,
                transition: {
                  id: "transition-complete",
                  status: "success",
                  occurredAt: 2,
                },
              },
            };
      memory.controller.emitUpdateToAll(update);

      const merged = client
        .getSnapshot()!
        .timeline.find(({ id }) => id === event.id);
      expect(merged?.raw).toEqual({ diagnostic: "keep-me" });
      expect(Object.isFrozen(merged?.raw)).toBe(true);

      await client.dispose({ deadlineAt: deadlineAt() });
    },
  );

  it("ignores nested foreign conversation errors without a wrapper scope", async () => {
    const memory = createMemoryChatGateway();
    const client = createChatClient({ gateway: memory.gateway });
    await loadInitialSnapshot(client, memory.fixtures.conversation.id);
    const listener = vi.fn();
    const subscription = client.subscribe(listener);
    listener.mockClear();

    expect(
      memory.controller.emitUpdateToAll({
        kind: "error.reported",
        error: {
          code: "network",
          message: "Foreign conversation error",
          retryable: true,
          conversationId: "conversation-foreign",
        },
      }),
    ).toBe(1);
    expect(client.getSnapshot()?.error).toBeUndefined();
    expect(listener).not.toHaveBeenCalled();

    subscription.dispose();
    await client.dispose({ deadlineAt: deadlineAt() });
  });

  it("preserves unchanged item identities during a large timeline update", async () => {
    const fixtures = createChatContractFixtures();
    const memory = createMemoryChatGateway({ fixtures });
    const initialCreatedAt = fixtures.initialSnapshot.timeline[0]!.createdAt;
    const messages: Message[] = Array.from({ length: 5_000 }, (_, index) => ({
      kind: "message",
      id: `message-${String(index).padStart(5, "0")}`,
      conversationId: fixtures.conversation.id,
      role: "assistant",
      content: { kind: "text", text: `Message ${index}` },
      createdAt: initialCreatedAt + index,
    }));
    memory.controller.setSnapshot({
      ...fixtures.initialSnapshot,
      timeline: messages,
    });
    const client = createChatClient({ gateway: memory.gateway });
    const before = await loadInitialSnapshot(client, fixtures.conversation.id);
    const unchanged = before.timeline[100]!;
    const replaced = before.timeline[4_900]!;

    memory.controller.emitUpdateToAll({
      kind: "timeline.upsert",
      conversationId: fixtures.conversation.id,
      item: {
        ...replaced,
        ...(replaced.kind === "message" && replaced.content.kind === "text"
          ? { content: { kind: "text" as const, text: "Updated" } }
          : {}),
        updatedAt: initialCreatedAt + 10_000,
      },
    });
    const after = client.getSnapshot()!;
    expect(after.timeline).toHaveLength(5_000);
    expect(after.timeline[100]).toBe(unchanged);
    expect(after.timeline[4_900]).not.toBe(replaced);

    await client.dispose({ deadlineAt: deadlineAt() });
  });

  it("makes dispose idempotent and synchronously closes listeners", async () => {
    const memory = createMemoryChatGateway();
    const client = createChatClient({ gateway: memory.gateway });
    await loadInitialSnapshot(client, memory.fixtures.conversation.id);
    const listener = vi.fn();
    const subscription = client.subscribe(listener);

    const options: GatewayRequestOptions = { deadlineAt: deadlineAt() };
    const firstDispose = client.dispose(options);
    const secondDispose = client.dispose(options);
    expect(secondDispose).toBe(firstDispose);
    expect(client.disposed).toBe(true);
    expect(subscription.closed).toBe(true);
    expect(client.getSnapshot()).toBeNull();
    memory.controller.emitUpdateToAll(memory.fixtures.realtimeMessageUpdate);
    await firstDispose;
    expect(listener).toHaveBeenCalledOnce();
    expect(memory.controller.disposed).toBe(true);
  });

  it.each(["gateway", "subscription"] as const)(
    "propagates %s cleanup failures after attempting every owned cleanup",
    async (failureSource) => {
      const memory = createMemoryChatGateway();
      const gateway = wrapGateway(memory.gateway, {
        dispose: async (options) => {
          await memory.gateway.dispose(options);
          if (failureSource === "gateway") {
            throw new Error("Gateway cleanup failed");
          }
        },
        subscribe: async (input, observer) => {
          const subscribed = await memory.gateway.subscribe(input, observer);
          if (!subscribed.ok || failureSource !== "subscription") {
            return subscribed;
          }
          const subscription: GatewaySubscription = {
            dispose: async (options) => {
              await subscribed.value.dispose(options);
              throw new Error("Subscription cleanup failed");
            },
          };
          return { ok: true, value: subscription };
        },
      });
      const client = createChatClient({ gateway });
      await loadInitialSnapshot(client, memory.fixtures.conversation.id);

      await expect(
        client.dispose({ deadlineAt: deadlineAt() }),
      ).rejects.toThrow(
        failureSource === "gateway"
          ? "Gateway cleanup failed"
          : "Subscription cleanup failed",
      );
      expect(client.disposed).toBe(true);
      expect(client.getSnapshot()).toBeNull();
      expect(memory.controller.disposed).toBe(true);
    },
  );

  it("reports listener failures without preventing healthy subscribers", async () => {
    const memory = createMemoryChatGateway();
    const failures = vi.fn();
    const client = createChatClient({
      gateway: memory.gateway,
      onUnhandledError: failures,
    });
    await loadInitialSnapshot(client, memory.fixtures.conversation.id);
    const broken = client.subscribe(() => {
      throw new Error("Listener failed");
    });
    const healthy = vi.fn();
    const healthySubscription = client.subscribe(healthy);

    memory.controller.emitUpdateToAll(memory.fixtures.realtimeMessageUpdate);

    expect(healthy).toHaveBeenCalledTimes(2);
    expect(failures).toHaveBeenCalledTimes(2);
    expect(failures).toHaveBeenLastCalledWith(
      expect.objectContaining({
        cause: expect.any(Error),
        source: "listener",
      }),
    );

    broken.dispose();
    healthySubscription.dispose();
    await client.dispose({ deadlineAt: deadlineAt() });
  });

  it("reports best-effort subscription cleanup failures without failing a reload", async () => {
    const memory = createMemoryChatGateway();
    let subscriptionCount = 0;
    const gateway = wrapGateway(memory.gateway, {
      subscribe: async (input, observer) => {
        const subscribed = await memory.gateway.subscribe(input, observer);
        subscriptionCount += 1;
        if (!subscribed.ok || subscriptionCount !== 1) return subscribed;
        return {
          ok: true,
          value: {
            dispose: async (options: GatewayRequestOptions) => {
              await subscribed.value.dispose(options);
              throw new Error("Previous subscription cleanup failed");
            },
          },
        };
      },
    });
    const failures = vi.fn();
    const client = createChatClient({
      gateway,
      onUnhandledError: failures,
    });
    await loadInitialSnapshot(client, memory.fixtures.conversation.id);

    await expect(
      client.loadConversation({
        conversationId: memory.fixtures.conversation.id,
        deadlineAt: deadlineAt(),
      }),
    ).resolves.toMatchObject({ ok: true });
    expect(failures).toHaveBeenCalledOnce();
    expect(failures).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: memory.fixtures.conversation.id,
        cause: expect.any(Error),
        source: "subscription-cleanup",
      }),
    );

    await client.dispose({ deadlineAt: deadlineAt() });
  });
});
