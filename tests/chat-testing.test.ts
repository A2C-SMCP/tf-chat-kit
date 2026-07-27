import { isDeepStrictEqual } from "node:util";

import { describe, expect, it, vi } from "vitest";

import {
  chatSnapshotSchema,
  compareAgentEventTransitions,
  compareTimelineItems,
  getTimelineItemKey,
  hasCompatibleAgentEventMetadata,
  type AgentEvent,
  type ChatError,
  type ChatGateway,
  type ChatSnapshot,
  type ChatUpdate,
  type GatewayRequestOptions,
  type GatewayResult,
  type GatewaySubscription,
  type InterruptRunInput,
  type InterruptRunSuccess,
  type LoadConversationInput,
  type SendTextInput,
  type SendTextSuccess,
  type TimelineItem,
} from "../packages/chat-protocol/src/index.js";
import {
  ChatContractViolation,
  createChatContractFixtures,
  createGatewayContractCases,
  createMemoryChatGateway,
  createRuntimeContractCases,
  type RuntimeContractAdapter,
  type RuntimeContractSubscription,
} from "../packages/chat-testing/src/index.js";

const requestDeadlineAt = (): number => Date.now() + 60_000;

class ReferenceRuntimeAdapter implements RuntimeContractAdapter {
  readonly #gateway: ChatGateway;
  readonly #listeners = new Set<(snapshot: ChatSnapshot) => void>();
  #disposed = false;
  #gatewaySubscription: GatewaySubscription | undefined;
  #snapshot: ChatSnapshot | null = null;

  constructor(gateway: ChatGateway) {
    this.#gateway = gateway;
  }

  async loadConversation(input: LoadConversationInput): Promise<void> {
    const pending: ChatUpdate[] = [];
    const pendingErrors: ChatError[] = [];
    let buffering = true;
    const subscribed = await this.#gateway.subscribe(input, {
      next: (update) => {
        if (buffering) pending.push(update);
        else this.#apply(update);
      },
      error: (error) => {
        if (buffering) {
          pendingErrors.push(error);
          return;
        }
        this.#applyError(error);
      },
    });
    const loaded = await this.#gateway.loadConversation(input);
    if (!loaded.ok) throw new Error(loaded.error.message);
    if (loaded.value.capabilities.liveUpdates && !subscribed.ok) {
      throw new Error(subscribed.error.message);
    }
    const snapshot = chatSnapshotSchema.parse(loaded.value);
    if (
      this.#snapshot === null ||
      !isDeepStrictEqual(snapshot, this.#snapshot)
    ) {
      this.#snapshot = snapshot;
    }
    buffering = false;
    for (const update of pending) this.#apply(update);
    for (const error of pendingErrors) this.#applyError(error);
    const previousSubscription = this.#gatewaySubscription;
    this.#gatewaySubscription = subscribed.ok ? subscribed.value : undefined;
    await previousSubscription?.dispose(input);
  }

  getSnapshot(): ChatSnapshot | null {
    return this.#snapshot;
  }

  sendText(input: SendTextInput): Promise<GatewayResult<SendTextSuccess>> {
    return this.#gateway.sendText(input);
  }

  interrupt(
    input: InterruptRunInput,
  ): Promise<GatewayResult<InterruptRunSuccess>> {
    const runId = input.runId ?? this.#snapshot?.run?.id;
    return this.#gateway.interrupt(
      runId === undefined ? input : { ...input, runId },
    );
  }

  settle(): Promise<void> {
    return Promise.resolve();
  }

  subscribe(
    listener: (snapshot: ChatSnapshot) => void,
  ): RuntimeContractSubscription {
    this.#listeners.add(listener);
    if (this.#snapshot !== null) listener(this.#snapshot);
    return {
      dispose: () => {
        this.#listeners.delete(listener);
      },
    };
  }

  async dispose(options: GatewayRequestOptions): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#listeners.clear();
    this.#snapshot = null;
    await this.#gatewaySubscription?.dispose(options);
    await this.#gateway.dispose(options);
  }

  #notify(): void {
    if (this.#disposed || this.#snapshot === null) return;
    for (const listener of this.#listeners) listener(this.#snapshot);
  }

  #applyError(error: ChatError): void {
    if (this.#snapshot === null) return;
    this.#snapshot = chatSnapshotSchema.parse({
      ...this.#snapshot,
      error,
    });
    this.#notify();
  }

  #replaceTimelineItem(item: TimelineItem): void {
    if (this.#snapshot === null) return;
    const items = new Map(
      this.#snapshot.timeline.map((current) => [
        getTimelineItemKey(current),
        current,
      ]),
    );
    items.set(getTimelineItemKey(item), item);
    this.#snapshot = chatSnapshotSchema.parse({
      ...this.#snapshot,
      timeline: [...items.values()].sort(compareTimelineItems),
    });
  }

  #applyTransition(
    update: Extract<ChatUpdate, { kind: "event.transition.upsert" }>,
  ): void {
    if (this.#snapshot === null) return;
    const existing = this.#snapshot.timeline.find(
      (item): item is AgentEvent =>
        item.kind === "agent-event" && item.id === update.event.id,
    );
    if (
      existing !== undefined &&
      !hasCompatibleAgentEventMetadata(existing, update)
    ) {
      return;
    }

    const transitions = new Map(
      existing?.transitions.map((transition) => [transition.id, transition]),
    );
    transitions.set(update.event.transition.id, update.event.transition);
    const orderedTransitions = [...transitions.values()].sort(
      compareAgentEventTransitions,
    );
    const latest = orderedTransitions.at(-1)!;
    const event: AgentEvent =
      update.event.eventCategory === "tool"
        ? {
            kind: "agent-event",
            eventCategory: "tool",
            id: update.event.id,
            conversationId: update.conversationId,
            eventType: update.event.eventType,
            status: latest.status,
            createdAt: update.event.createdAt,
            ...(update.event.sequence === undefined
              ? {}
              : { sequence: update.event.sequence }),
            transitions: orderedTransitions,
          }
        : {
            kind: "agent-event",
            eventCategory: "generic",
            id: update.event.id,
            conversationId: update.conversationId,
            eventType: update.event.eventType,
            status: latest.status,
            createdAt: update.event.createdAt,
            ...(update.event.sequence === undefined
              ? {}
              : { sequence: update.event.sequence }),
            transitions: orderedTransitions,
          };
    this.#replaceTimelineItem(event);
  }

  #apply(update: ChatUpdate): void {
    if (this.#disposed) return;
    if (this.#snapshot !== null) {
      const activeConversationId = this.#snapshot.conversation.id;
      const updateConversationId =
        update.kind === "snapshot.replace"
          ? update.snapshot.conversation.id
          : update.kind === "conversation.upsert"
            ? update.conversation.id
            : update.kind === "error.reported"
              ? update.conversationId
              : update.conversationId;
      if (
        updateConversationId !== undefined &&
        updateConversationId !== activeConversationId
      ) {
        return;
      }
    }
    switch (update.kind) {
      case "snapshot.replace":
        this.#snapshot = chatSnapshotSchema.parse(update.snapshot);
        break;
      case "conversation.upsert":
        if (this.#snapshot !== null) {
          this.#snapshot = chatSnapshotSchema.parse({
            ...this.#snapshot,
            conversation: update.conversation,
          });
        }
        break;
      case "timeline.upsert":
        this.#replaceTimelineItem(update.item);
        break;
      case "event.transition.upsert":
        this.#applyTransition(update);
        break;
      case "run.replace":
        if (this.#snapshot !== null) {
          this.#snapshot = chatSnapshotSchema.parse({
            ...this.#snapshot,
            run: update.run,
          });
        }
        break;
      case "capabilities.replace":
        if (this.#snapshot !== null) {
          this.#snapshot = chatSnapshotSchema.parse({
            ...this.#snapshot,
            capabilities: update.capabilities,
          });
        }
        break;
      case "error.reported":
        if (this.#snapshot !== null) {
          this.#snapshot = chatSnapshotSchema.parse({
            ...this.#snapshot,
            error: update.error,
          });
        }
        break;
    }
    this.#notify();
  }
}

class MutableCloneRuntimeAdapter implements RuntimeContractAdapter {
  readonly #delegate: RuntimeContractAdapter;

  constructor(delegate: RuntimeContractAdapter) {
    this.#delegate = delegate;
  }

  dispose(options: GatewayRequestOptions): Promise<void> {
    return Promise.resolve(this.#delegate.dispose(options));
  }

  async getSnapshot(): Promise<ChatSnapshot | null> {
    const snapshot = await this.#delegate.getSnapshot();
    return snapshot === null ? null : structuredClone(snapshot);
  }

  interrupt(
    input: InterruptRunInput,
  ): Promise<GatewayResult<InterruptRunSuccess>> {
    return Promise.resolve(this.#delegate.interrupt(input));
  }

  loadConversation(input: LoadConversationInput): Promise<void> {
    return Promise.resolve(this.#delegate.loadConversation(input));
  }

  sendText(input: SendTextInput): Promise<GatewayResult<SendTextSuccess>> {
    return Promise.resolve(this.#delegate.sendText(input));
  }

  settle(): Promise<void> {
    return Promise.resolve(this.#delegate.settle());
  }

  subscribe(
    listener: (snapshot: ChatSnapshot) => void,
  ): Promise<RuntimeContractSubscription> {
    return Promise.resolve(this.#delegate.subscribe(listener));
  }
}

class ZombieListenerRuntimeAdapter implements RuntimeContractAdapter {
  readonly #delegate: ReferenceRuntimeAdapter;
  readonly #listeners = new Set<(snapshot: ChatSnapshot) => void>();
  readonly #zombieListeners: Set<(snapshot: ChatSnapshot) => void>;
  #bridged = false;

  constructor(
    gateway: ChatGateway,
    zombieListeners: Set<(snapshot: ChatSnapshot) => void>,
  ) {
    this.#delegate = new ReferenceRuntimeAdapter(gateway);
    this.#zombieListeners = zombieListeners;
  }

  async dispose(options: GatewayRequestOptions): Promise<void> {
    for (const listener of this.#listeners) {
      this.#zombieListeners.add(listener);
    }
    this.#listeners.clear();
    await this.#delegate.dispose(options);
  }

  getSnapshot(): ChatSnapshot | null {
    return this.#delegate.getSnapshot();
  }

  interrupt(
    input: InterruptRunInput,
  ): Promise<GatewayResult<InterruptRunSuccess>> {
    return this.#delegate.interrupt(input);
  }

  async loadConversation(input: LoadConversationInput): Promise<void> {
    await this.#delegate.loadConversation(input);
    if (this.#bridged) return;
    this.#bridged = true;
    this.#delegate.subscribe((snapshot) => {
      for (const listener of this.#listeners) listener(snapshot);
      for (const listener of this.#zombieListeners) listener(snapshot);
    });
  }

  sendText(input: SendTextInput): Promise<GatewayResult<SendTextSuccess>> {
    return this.#delegate.sendText(input);
  }

  settle(): Promise<void> {
    return this.#delegate.settle();
  }

  subscribe(
    listener: (snapshot: ChatSnapshot) => void,
  ): RuntimeContractSubscription {
    this.#listeners.add(listener);
    const snapshot = this.#delegate.getSnapshot();
    if (snapshot !== null) listener(snapshot);
    return {
      dispose: () => {
        this.#listeners.delete(listener);
        this.#zombieListeners.delete(listener);
      },
    };
  }
}

const withFirstWriteWinsTimeline = (gateway: ChatGateway): ChatGateway => ({
  dispose: (options) => gateway.dispose(options),
  interrupt: (input) => gateway.interrupt(input),
  listConversations: (input) => gateway.listConversations(input),
  loadConversation: (input) => gateway.loadConversation(input),
  sendText: (input) => gateway.sendText(input),
  subscribe: (input, observer) => {
    const seen = new Set<string>();
    return gateway.subscribe(input, {
      ...(observer.error === undefined ? {} : { error: observer.error }),
      next: (update) => {
        if (update.kind === "timeline.upsert") {
          const key = getTimelineItemKey(update.item);
          if (seen.has(key)) return;
          seen.add(key);
        }
        observer.next(update);
      },
    });
  },
});

const withUpdateMutation = (
  gateway: ChatGateway,
  mutate: (update: ChatUpdate) => ChatUpdate,
): ChatGateway => ({
  dispose: (options) => gateway.dispose(options),
  interrupt: (input) => gateway.interrupt(input),
  listConversations: (input) => gateway.listConversations(input),
  loadConversation: (input) => gateway.loadConversation(input),
  sendText: (input) => gateway.sendText(input),
  subscribe: (input, observer) =>
    gateway.subscribe(input, {
      ...(observer.error === undefined ? {} : { error: observer.error }),
      next: (update) => observer.next(mutate(update)),
    }),
});

const withGatewayDispose = (
  gateway: ChatGateway,
  dispose: ChatGateway["dispose"],
): ChatGateway => ({
  dispose,
  interrupt: (input) => gateway.interrupt(input),
  listConversations: (input) => gateway.listConversations(input),
  loadConversation: (input) => gateway.loadConversation(input),
  sendText: (input) => gateway.sendText(input),
  subscribe: (input, observer) => gateway.subscribe(input, observer),
});

const withGatewayCommands = (
  gateway: ChatGateway,
  overrides: Partial<Pick<ChatGateway, "interrupt" | "sendText">>,
): ChatGateway => ({
  dispose: (options) => gateway.dispose(options),
  interrupt: overrides.interrupt ?? ((input) => gateway.interrupt(input)),
  listConversations: (input) => gateway.listConversations(input),
  loadConversation: (input) => gateway.loadConversation(input),
  sendText: overrides.sendText ?? ((input) => gateway.sendText(input)),
  subscribe: (input, observer) => gateway.subscribe(input, observer),
});

const withDuplicateMessageAppend = (gateway: ChatGateway): ChatGateway => {
  let realtimeMessageCount = 0;
  return withUpdateMutation(gateway, (update) => {
    if (
      update.kind !== "timeline.upsert" ||
      update.item.id !== "message-realtime"
    ) {
      return update;
    }
    realtimeMessageCount += 1;
    return realtimeMessageCount === 2
      ? {
          ...update,
          item: { ...update.item, id: "message-realtime-duplicate" },
        }
      : update;
  });
};

const withDuplicateTransitionAppend = (gateway: ChatGateway): ChatGateway => {
  const seen = new Set<string>();
  return withUpdateMutation(gateway, (update) => {
    if (update.kind !== "event.transition.upsert") return update;
    const key = `${update.conversationId}:${update.event.id}:${update.event.transition.id}`;
    if (!seen.has(key)) {
      seen.add(key);
      return update;
    }
    return {
      ...update,
      event: {
        ...update.event,
        transition: {
          ...update.event.transition,
          id: `${update.event.transition.id}-duplicate`,
        },
      },
    };
  });
};

describe("chat-testing fixtures", () => {
  it("creates isolated, frozen, credential-free normalized scenarios", () => {
    const first = createChatContractFixtures();
    const second = createChatContractFixtures({
      conversationId: "conversation-other",
      baseTimestamp: 2_000,
    });

    expect(first).not.toBe(second);
    expect(first.conversation.id).toBe("conversation-contract");
    expect(second.conversation.id).toBe("conversation-other");
    expect(second.initialSnapshot.timeline[0]?.createdAt).toBe(2_000);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.initialSnapshot)).toBe(true);
    const unknownEvent = first.unknownEventUpdate;
    expect(unknownEvent.kind).toBe("timeline.upsert");
    if (
      unknownEvent.kind === "timeline.upsert" &&
      unknownEvent.item.kind === "unknown-event"
    ) {
      const { raw } = unknownEvent.item;
      expect(raw).toBeTypeOf("object");
      expect(raw).not.toBeNull();
      expect(Array.isArray(raw)).toBe(false);
      if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
        expect(Object.hasOwn(raw, "__proto__")).toBe(true);
      }
    }
    expect(JSON.stringify(first)).not.toMatch(
      /(?:authorization|cookie|password|private.?key|token)["'=:\s]+(?!\[REDACTED\])/iu,
    );
  });
});

describe("Memory ChatGateway", () => {
  it("records calls and consumes scripted failures once", async () => {
    const memory = createMemoryChatGateway();
    memory.controller.failNext(
      "loadConversation",
      memory.fixtures.authenticationError,
    );

    await expect(
      memory.gateway.loadConversation({
        conversationId: memory.fixtures.conversation.id,
        deadlineAt: requestDeadlineAt(),
      }),
    ).resolves.toEqual({
      ok: false,
      error: memory.fixtures.authenticationError,
    });
    await expect(
      memory.gateway.loadConversation({
        conversationId: memory.fixtures.conversation.id,
        deadlineAt: requestDeadlineAt(),
      }),
    ).resolves.toEqual({
      ok: true,
      value: memory.fixtures.initialSnapshot,
    });
    expect(memory.controller.calls.map(({ operation }) => operation)).toEqual([
      "loadConversation",
      "loadConversation",
    ]);
  });

  it("retains immutable normalized call inputs", async () => {
    const memory = createMemoryChatGateway();
    const deadlineAt = requestDeadlineAt();
    const input = {
      conversationId: memory.fixtures.conversation.id,
      text: "Original command",
      clientMessageId: "client-recorded",
      deadlineAt,
    };

    await memory.gateway.sendText(input);
    input.text = "Mutated after dispatch";

    const call = memory.controller.calls.at(-1);
    expect(call).toEqual({
      operation: "sendText",
      input: {
        conversationId: memory.fixtures.conversation.id,
        text: "Original command",
        clientMessageId: "client-recorded",
        deadlineAt,
      },
    });
    expect(call?.input).not.toBe(input);
    expect(Object.isFrozen(call?.input)).toBe(true);
  });

  it("isolates instances and synchronously silences disposed subscriptions", async () => {
    const first = createMemoryChatGateway();
    const second = createMemoryChatGateway();
    const firstNext = vi.fn();
    const secondNext = vi.fn();
    const firstSubscription = await first.gateway.subscribe(
      {
        conversationId: first.fixtures.conversation.id,
        deadlineAt: requestDeadlineAt(),
      },
      { next: firstNext },
    );
    const secondSubscription = await second.gateway.subscribe(
      {
        conversationId: second.fixtures.conversation.id,
        deadlineAt: requestDeadlineAt(),
      },
      { next: secondNext },
    );
    expect(firstSubscription.ok && secondSubscription.ok).toBe(true);
    if (!firstSubscription.ok || !secondSubscription.ok) return;

    first.controller.emitUpdate(first.fixtures.realtimeMessageUpdate);
    expect(firstNext).toHaveBeenCalledOnce();
    expect(secondNext).not.toHaveBeenCalled();

    await firstSubscription.value.dispose({ deadlineAt: requestDeadlineAt() });
    first.controller.emitUpdate(first.fixtures.unknownEventUpdate);
    expect(firstNext).toHaveBeenCalledOnce();
    await secondSubscription.value.dispose({ deadlineAt: requestDeadlineAt() });
  });

  it("sanitizes injected error details at the Protocol boundary", async () => {
    const memory = createMemoryChatGateway();
    memory.controller.failNext("sendText", {
      code: "authentication",
      message: "Rejected request",
      retryable: false,
      details: { Authorization: "Bearer example-credential-value" },
    });
    const result = await memory.gateway.sendText({
      conversationId: memory.fixtures.conversation.id,
      text: "Hello",
      deadlineAt: requestDeadlineAt(),
    });

    expect(result).toEqual({
      ok: false,
      error: {
        code: "authentication",
        message: "Rejected request",
        retryable: false,
        details: { Authorization: "[REDACTED]" },
      },
    });
  });

  it("rejects operations after disposal and stays disconnected from observers", async () => {
    const memory = createMemoryChatGateway();
    const next = vi.fn();
    const subscribed = await memory.gateway.subscribe(
      {
        conversationId: memory.fixtures.conversation.id,
        deadlineAt: requestDeadlineAt(),
      },
      { next },
    );
    expect(subscribed.ok).toBe(true);

    await memory.gateway.dispose({ deadlineAt: requestDeadlineAt() });
    expect(memory.controller.disposed).toBe(true);
    expect(
      memory.controller.emitUpdate(memory.fixtures.realtimeMessageUpdate),
    ).toBe(0);
    expect(next).not.toHaveBeenCalled();
    await expect(
      memory.gateway.listConversations({ deadlineAt: requestDeadlineAt() }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "conflict" },
    });
  });

  it("rejects stale interrupt targets while allowing the active or omitted runId", async () => {
    const memory = createMemoryChatGateway();
    const baseInput = {
      conversationId: memory.fixtures.conversation.id,
      deadlineAt: requestDeadlineAt(),
    };

    await expect(
      memory.gateway.interrupt({ ...baseInput, runId: "run-stale" }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "conflict", conversationId: baseInput.conversationId },
    });
    await expect(
      memory.gateway.interrupt({
        ...baseInput,
        runId: memory.fixtures.initialSnapshot.run?.id,
      }),
    ).resolves.toEqual({
      ok: true,
      value: memory.fixtures.interruptSuccess,
    });
    await expect(memory.gateway.interrupt(baseInput)).resolves.toEqual({
      ok: true,
      value: memory.fixtures.interruptSuccess,
    });
  });
});

describe("framework-neutral Gateway contract", () => {
  const cases = createGatewayContractCases((fixtures) => {
    const memory = createMemoryChatGateway({ fixtures });
    return { gateway: memory.gateway, controller: memory.controller };
  });

  expect(new Set(cases.map(({ name }) => name)).size).toBe(cases.length);
  for (const contractCase of cases) {
    it(contractCase.name, () => contractCase.run());
  }
});

describe("Gateway contract mutation strength", () => {
  it("rejects Gateways that reuse one shared instance", async () => {
    let shared: ReturnType<typeof createMemoryChatGateway> | undefined;
    const contractCase = createGatewayContractCases((fixtures) => {
      shared ??= createMemoryChatGateway({ fixtures });
      return { gateway: shared.gateway, controller: shared.controller };
    }).find(({ name }) => name === "isolates concurrent Gateway instances");

    expect(contractCase).toBeDefined();
    await expect(contractCase!.run()).rejects.toBeInstanceOf(
      ChatContractViolation,
    );
  });

  it("uses the harness clock for ordinary request deadlines", async () => {
    const contractCase = createGatewayContractCases((fixtures) => {
      const memory = createMemoryChatGateway({
        fixtures,
        now: () => Date.now() + 120_000,
      });
      return { gateway: memory.gateway, controller: memory.controller };
    }).find(
      ({ name }) => name === "loads normalized conversations and snapshots",
    );

    expect(contractCase).toBeDefined();
    await expect(contractCase!.run()).resolves.toBeUndefined();
  });

  it("rejects Gateways that drop preserved special raw keys", async () => {
    const contractCase = createGatewayContractCases((fixtures) => {
      const memory = createMemoryChatGateway({ fixtures });
      return {
        controller: memory.controller,
        gateway: withUpdateMutation(memory.gateway, (update) =>
          update.kind === "timeline.upsert" &&
          update.item.kind === "unknown-event"
            ? {
                ...update,
                item: {
                  ...update.item,
                  raw: { safeField: "safe-value" },
                },
              }
            : update,
        ),
      };
    }).find(
      ({ name }) =>
        name === "delivers duplicate, out-of-order, and unknown updates safely",
    );

    expect(contractCase).toBeDefined();
    await expect(contractCase!.run()).rejects.toBeInstanceOf(
      ChatContractViolation,
    );
  });

  it("rejects Gateways that mutate command payloads", async () => {
    const contractCase = createGatewayContractCases((fixtures) => {
      const memory = createMemoryChatGateway({ fixtures });
      return {
        controller: memory.controller,
        gateway: withGatewayCommands(memory.gateway, {
          sendText: (input) =>
            memory.gateway.sendText({ ...input, text: "Mutated command" }),
        }),
      };
    }).find(({ name }) => name === "executes send and interrupt commands");

    expect(contractCase).toBeDefined();
    await expect(contractCase!.run()).rejects.toBeInstanceOf(
      ChatContractViolation,
    );
  });

  it("cleans the harness when Gateway disposal fails", async () => {
    const harnessDispose = vi.fn();
    const contractCase = createGatewayContractCases((fixtures) => {
      const memory = createMemoryChatGateway({ fixtures });
      return {
        controller: memory.controller,
        dispose: harnessDispose,
        gateway: withGatewayDispose(memory.gateway, () => {
          throw new Error("Gateway cleanup failed");
        }),
      };
    }).find(
      ({ name }) => name === "loads normalized conversations and snapshots",
    );

    expect(contractCase).toBeDefined();
    await expect(contractCase!.run()).rejects.toThrow("Gateway cleanup failed");
    expect(harnessDispose).toHaveBeenCalledOnce();
  });
});

describe("framework-neutral Runtime contract", () => {
  const cases = createRuntimeContractCases(
    (gateway) => new ReferenceRuntimeAdapter(gateway),
  );

  expect(new Set(cases.map(({ name }) => name)).size).toBe(cases.length);
  for (const contractCase of cases) {
    it(contractCase.name, () => contractCase.run());
  }
});

describe("Runtime contract mutation strength", () => {
  it("rejects Runtime adapters that leak disposed listeners across instances", async () => {
    const zombieListeners = new Set<(snapshot: ChatSnapshot) => void>();
    const contractCase = createRuntimeContractCases(
      (gateway) => new ZombieListenerRuntimeAdapter(gateway, zombieListeners),
    ).find(({ name }) => name === "isolates concurrent Runtime instances");

    expect(contractCase).toBeDefined();
    await expect(contractCase!.run()).rejects.toBeInstanceOf(
      ChatContractViolation,
    );
  });

  it("rejects Runtime factories that reuse one shared adapter", async () => {
    let shared: ReferenceRuntimeAdapter | undefined;
    const contractCase = createRuntimeContractCases((gateway) => {
      shared ??= new ReferenceRuntimeAdapter(gateway);
      return shared;
    }).find(({ name }) => name === "isolates concurrent Runtime instances");

    expect(contractCase).toBeDefined();
    await expect(contractCase!.run()).rejects.toThrow(
      "Conversation was not found",
    );
  });

  it("rejects adapters that return mutable snapshot clones", async () => {
    const contractCase = createRuntimeContractCases(
      (gateway) =>
        new MutableCloneRuntimeAdapter(new ReferenceRuntimeAdapter(gateway)),
    ).find(({ name }) => name === "loads the initial immutable snapshot");

    expect(contractCase).toBeDefined();
    await expect(contractCase!.run()).rejects.toBeInstanceOf(
      ChatContractViolation,
    );
  });

  it("rejects first-write-wins timeline implementations", async () => {
    const contractCase = createRuntimeContractCases(
      (gateway) =>
        new ReferenceRuntimeAdapter(withFirstWriteWinsTimeline(gateway)),
    ).find(
      ({ name }) =>
        name === "deduplicates and stably orders normalized updates",
    );

    expect(contractCase).toBeDefined();
    await expect(contractCase!.run()).rejects.toBeInstanceOf(
      ChatContractViolation,
    );
  });

  it("rejects implementations that append exact duplicate messages", async () => {
    const contractCase = createRuntimeContractCases(
      (gateway) =>
        new ReferenceRuntimeAdapter(withDuplicateMessageAppend(gateway)),
    ).find(
      ({ name }) =>
        name === "deduplicates and stably orders normalized updates",
    );

    expect(contractCase).toBeDefined();
    await expect(contractCase!.run()).rejects.toBeInstanceOf(
      ChatContractViolation,
    );
  });

  it("rejects implementations that append duplicate transition IDs", async () => {
    const contractCase = createRuntimeContractCases(
      (gateway) =>
        new ReferenceRuntimeAdapter(withDuplicateTransitionAppend(gateway)),
    ).find(
      ({ name }) =>
        name === "deduplicates and stably orders normalized updates",
    );

    expect(contractCase).toBeDefined();
    await expect(contractCase!.run()).rejects.toBeInstanceOf(
      ChatContractViolation,
    );
  });

  it("rejects adapters that retain their injected Gateway after disposal", async () => {
    const contractCase = createRuntimeContractCases(
      (gateway) =>
        new ReferenceRuntimeAdapter(
          withGatewayDispose(gateway, () => undefined),
        ),
    ).find(({ name }) => name === "stops notifying after disposal");

    expect(contractCase).toBeDefined();
    await expect(contractCase!.run()).rejects.toBeInstanceOf(
      ChatContractViolation,
    );
  });

  it.each([
    [
      "mutate text",
      (gateway: ChatGateway) =>
        withGatewayCommands(gateway, {
          sendText: (input) =>
            gateway.sendText({ ...input, text: "Mutated command" }),
        }),
    ],
    [
      "drop clientMessageId",
      (gateway: ChatGateway) =>
        withGatewayCommands(gateway, {
          sendText: (input) =>
            gateway.sendText({
              conversationId: input.conversationId,
              text: input.text,
              deadlineAt: input.deadlineAt,
            }),
        }),
    ],
    [
      "drop runId",
      (gateway: ChatGateway) =>
        withGatewayCommands(gateway, {
          interrupt: (input) =>
            gateway.interrupt({
              conversationId: input.conversationId,
              deadlineAt: input.deadlineAt,
            }),
        }),
    ],
  ])("rejects adapters that %s", async (_label, mutateGateway) => {
    const contractCase = createRuntimeContractCases(
      (gateway) => new ReferenceRuntimeAdapter(mutateGateway(gateway)),
    ).find(
      ({ name }) =>
        name === "routes text and interrupt commands through its Gateway",
    );

    expect(contractCase).toBeDefined();
    await expect(contractCase!.run()).rejects.toBeInstanceOf(
      ChatContractViolation,
    );
  });

  it("rejects adapters that return command success without dispatching", async () => {
    const contractCase = createRuntimeContractCases(
      (gateway, fixtures) =>
        new ReferenceRuntimeAdapter(
          withGatewayCommands(gateway, {
            sendText: () =>
              Promise.resolve({ ok: true, value: fixtures.sendTextSuccess }),
          }),
        ),
    ).find(
      ({ name }) =>
        name === "routes text and interrupt commands through its Gateway",
    );

    expect(contractCase).toBeDefined();
    await expect(contractCase!.run()).rejects.toBeInstanceOf(
      ChatContractViolation,
    );
  });
});
