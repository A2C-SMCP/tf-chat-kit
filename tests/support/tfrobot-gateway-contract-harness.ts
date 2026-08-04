import { vi } from "vitest";

import {
  createTFRobotChatGateway,
  type TFRobotSocket,
  type TFRobotSocketAnyListener,
  type TFRobotSocketFactoryInput,
  type TFRobotSocketListener,
} from "../../packages/chat-gateway-tfrobot/src/index.js";
import type {
  ChatError,
  ChatGateway,
  ChatUpdate,
  GatewayRequestOptions,
  GatewayResult,
  GatewaySubscription,
  InterruptRunInput,
  ListConversationsInput,
  LoadConversationInput,
  SendTextInput,
  SubscribeConversationInput,
} from "../../packages/chat-protocol/src/index.js";
import type {
  ChatContractFixtures,
  GatewayContractCall,
  GatewayContractController,
  GatewayContractHarness,
  GatewayContractHold,
  GatewayContractHoldPoint,
  GatewayContractOperation,
} from "../../packages/chat-testing/src/index.js";

interface Deferred {
  readonly promise: Promise<void>;
  resolve(): void;
}

const deferred = (): Deferred => {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
};

class ContractHold implements GatewayContractHold {
  readonly #completed = deferred();
  readonly #released = deferred();
  readonly #started = deferred();
  #completedMarked = false;
  #disposed = 0;
  #releasedMarked = false;
  readonly #releaseListeners = new Set<() => void>();
  #startedMarked = false;

  get completed(): Promise<void> {
    return this.#completed.promise;
  }

  get released(): Promise<void> {
    return this.#released.promise;
  }

  get resourceDisposeCount(): number {
    return this.#disposed;
  }

  get isReleased(): boolean {
    return this.#releasedMarked;
  }

  get started(): Promise<void> {
    return this.#started.promise;
  }

  markCompleted(): void {
    if (this.#completedMarked) return;
    this.#completedMarked = true;
    this.#completed.resolve();
  }

  markDisposed(): void {
    this.#disposed += 1;
  }

  markStarted(): void {
    if (this.#startedMarked) return;
    this.#startedMarked = true;
    this.#started.resolve();
  }

  onRelease(listener: () => void): void {
    if (this.#releasedMarked) {
      listener();
      return;
    }
    this.#releaseListeners.add(listener);
  }

  release(): void {
    if (this.#releasedMarked) return;
    this.#releasedMarked = true;
    for (const listener of this.#releaseListeners) listener();
    this.#releaseListeners.clear();
    this.#released.resolve();
  }
}

const envelope = (data: unknown): Response =>
  new Response(JSON.stringify({ code: 200, message: "Success", data }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

const messageDto = (
  update: Extract<ChatUpdate, { kind: "timeline.upsert" }>,
): Record<string, unknown> => {
  if (update.item.kind !== "message") {
    throw new TypeError("Expected a normalized message update");
  }
  const content =
    update.item.content.kind === "text"
      ? update.item.content.text
      : update.item.content.summary;
  return {
    msgId: update.item.id,
    content,
    additionalKwargs: {},
    attachments: null,
    createTimestamp: update.item.createdAt,
    conversationId: update.conversationId,
    role: update.item.role,
    msgType:
      update.item.content.kind === "media"
        ? update.item.content.mediaType
        : update.item.content.kind,
    ...(update.item.reasoning === undefined
      ? {}
      : { reasoningContent: update.item.reasoning }),
    ...(update.item.sequence === undefined
      ? {}
      : { sequence: update.item.sequence }),
    ...(update.item.author === undefined
      ? {}
      : {
          creator: {
            ...(update.item.author.id === undefined
              ? {}
              : { uid: update.item.author.id }),
            ...(update.item.author.displayName === undefined
              ? {}
              : { name: update.item.author.displayName }),
            ...(update.item.author.avatarUrl === undefined
              ? {}
              : { avatar: update.item.author.avatarUrl }),
          },
        }),
  };
};

const eventDto = (
  update: Extract<ChatUpdate, { kind: "event.transition.upsert" }>,
): Record<string, unknown> => {
  const transition = update.event.transition;
  return {
    eventId: update.event.id,
    transitionId: transition.id,
    transitionSequence: transition.sequence,
    status: transition.status,
    eventScene: update.event.eventType,
    conversationId: update.conversationId,
    createTimestamp: transition.occurredAt,
    ...(update.event.createdAt === undefined
      ? {}
      : { eventCreateTimestamp: update.event.createdAt }),
    sequence: update.event.sequence,
    exception: transition.error?.message ?? null,
    content: transition.summary ?? "",
  };
};

const unknownPayload = (
  update: Extract<ChatUpdate, { kind: "timeline.upsert" }>,
): Record<string, unknown> => {
  if (update.item.kind !== "unknown-event") {
    throw new TypeError("Expected an unknown event update");
  }
  const payload: Record<string, unknown> = {
    id: update.item.id,
    createTimestamp: update.item.createdAt,
    summary: update.item.summary,
    sequence: update.item.sequence,
  };
  if (
    update.item.raw !== undefined &&
    !Array.isArray(update.item.raw) &&
    update.item.raw !== null &&
    typeof update.item.raw === "object"
  ) {
    const raw = update.item.raw as {
      readonly [key: string]: unknown;
    };
    for (const key of Object.keys(raw)) {
      Object.defineProperty(payload, key, {
        configurable: true,
        enumerable: true,
        value: raw[key],
        writable: true,
      });
    }
  }
  return payload;
};

class ContractState {
  readonly calls: GatewayContractCall[] = [];
  currentConversationId: string | undefined;
  disconnectedError: ChatError | undefined;
  disposingPoint: "gateway.dispose" | "subscription.dispose" | undefined;
  readonly fixtures: ChatContractFixtures;
  nowValue = Date.now();
  readonly sockets = new Set<ContractSocket>();
  readonly #failures = new Map<GatewayContractOperation, ChatError>();
  readonly #holds = new Map<GatewayContractHoldPoint, ContractHold>();

  constructor(fixtures: ChatContractFixtures) {
    this.fixtures = fixtures;
  }

  failNext(operation: GatewayContractOperation, error: ChatError): void {
    this.#failures.set(operation, error);
  }

  holdNext(point: GatewayContractHoldPoint): ContractHold {
    const hold = new ContractHold();
    this.#holds.set(point, hold);
    return hold;
  }

  takeFailure(operation: GatewayContractOperation): ChatError | undefined {
    const error = this.#failures.get(operation);
    this.#failures.delete(operation);
    return error;
  }

  takeHold(point: GatewayContractHoldPoint): ContractHold | undefined {
    const hold = this.#holds.get(point);
    this.#holds.delete(point);
    return hold;
  }

  async awaitOperation(
    operation: GatewayContractOperation,
    signal: AbortSignal | null | undefined,
  ): Promise<void> {
    const hold = this.takeHold(operation);
    if (hold === undefined) return;
    hold.markStarted();
    const aborted = deferred();
    const abort = (): void => aborted.resolve();
    signal?.addEventListener("abort", abort, { once: true });
    try {
      const outcome = await Promise.race([
        hold.released.then(() => "released" as const),
        aborted.promise.then(() => "aborted" as const),
      ]);
      if (outcome === "aborted") {
        void hold.released.then(() => hold.markCompleted());
        throw new DOMException("The operation was aborted", "AbortError");
      }
      hold.markCompleted();
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  }
}

class ContractSocket implements TFRobotSocket {
  connected = false;
  readonly #anyListeners = new Set<TFRobotSocketAnyListener>();
  #connectHold: ContractHold | undefined;
  #disposeOnCreate = false;
  #disposed = false;
  readonly #input: TFRobotSocketFactoryInput;
  readonly #listeners = new Map<string, Set<TFRobotSocketListener>>();
  readonly #state: ContractState;
  readonly conversationId: string;

  constructor(
    state: ContractState,
    input: TFRobotSocketFactoryInput,
    conversationId: string,
  ) {
    this.#state = state;
    this.#input = input;
    this.conversationId = conversationId;
    state.sockets.add(this);
  }

  connect(): void {
    void this.#connect();
  }

  disconnect(): void {
    const cleanupHold = this.#state.takeHold(
      this.#state.disposingPoint ?? "subscription.dispose",
    );
    cleanupHold?.markStarted();
    cleanupHold?.markCompleted();
    if (this.#connectHold !== undefined && !this.#connectHold.isReleased) {
      this.#disposeOnCreate = true;
      this.connected = false;
      return;
    }
    if (!this.#disposed) {
      this.#disposed = true;
      this.#connectHold?.markDisposed();
    }
    this.connected = false;
  }

  emit(...arguments_: [eventName: string, payload?: unknown]): void {
    void arguments_;
    // The harness only observes server-to-client behavior.
  }

  off(eventName: string, listener: TFRobotSocketListener): void {
    this.#listeners.get(eventName)?.delete(listener);
  }

  offAny(listener: TFRobotSocketAnyListener): void {
    this.#anyListeners.delete(listener);
  }

  on(eventName: string, listener: TFRobotSocketListener): void {
    const listeners =
      this.#listeners.get(eventName) ?? new Set<TFRobotSocketListener>();
    listeners.add(listener);
    this.#listeners.set(eventName, listeners);
  }

  onAny(listener: TFRobotSocketAnyListener): void {
    this.#anyListeners.add(listener);
  }

  transportDisconnect(error: ChatError): void {
    if (!this.connected) return;
    this.connected = false;
    this.#trigger("disconnect", error);
  }

  transportReconnect(): void {
    if (this.#disposed) return;
    this.connected = true;
    this.#trigger("connect");
  }

  deliver(update: ChatUpdate): boolean {
    if (!this.connected || this.#disposed) return false;
    const conversationId =
      update.kind === "snapshot.replace"
        ? update.snapshot.conversation.id
        : update.kind === "conversation.upsert"
          ? update.conversation.id
          : update.conversationId;
    if (
      conversationId !== undefined &&
      conversationId !== this.conversationId
    ) {
      return false;
    }
    if (update.kind === "timeline.upsert") {
      if (update.item.kind === "message") {
        this.#trigger("chat_message", messageDto(update));
      } else if (update.item.kind === "unknown-event") {
        this.#triggerAny(update.item.originalType, unknownPayload(update));
      }
      return true;
    }
    if (update.kind === "event.transition.upsert") {
      this.#trigger("chat_event", eventDto(update));
      return true;
    }
    return false;
  }

  async #connect(): Promise<void> {
    this.#connectHold = this.#state.takeHold("subscribe");
    this.#connectHold?.markStarted();
    if (this.#connectHold !== undefined) {
      this.#connectHold.onRelease(() => {
        if (!this.#disposeOnCreate || this.#disposed) return;
        void Promise.resolve().then(() => {
          if (this.#disposed) return;
          this.#disposed = true;
          this.#connectHold?.markDisposed();
          this.#connectHold?.markCompleted();
        });
      });
      await this.#connectHold.released;
    }
    try {
      await this.#input.getAuth();
    } catch (reason) {
      if (!this.#disposeOnCreate) this.#trigger("connect_error", reason);
      this.#connectHold?.markCompleted();
      return;
    }
    if (this.#disposeOnCreate) return;
    const failure = this.#state.takeFailure("subscribe");
    if (failure !== undefined) {
      this.#trigger("connect_error", failure);
      this.#connectHold?.markCompleted();
      return;
    }
    if (this.conversationId !== this.#state.fixtures.conversation.id) {
      this.#trigger("connect_error", {
        code: "not-found",
        message: "Conversation not found",
        retryable: false,
        conversationId: this.conversationId,
      } satisfies ChatError);
      this.#connectHold?.markCompleted();
      return;
    }
    this.connected = true;
    this.#trigger("connect");
    this.#connectHold?.markCompleted();
  }

  #trigger(eventName: string, value?: unknown): void {
    for (const listener of this.#listeners.get(eventName) ?? []) {
      listener(value);
    }
  }

  #triggerAny(eventName: string, value?: unknown): void {
    for (const listener of this.#anyListeners) listener(eventName, value);
  }
}

const operationOf = (request: Request): GatewayContractOperation => {
  const path = new URL(request.url).pathname;
  if (request.method === "POST" && path.endsWith("/interrupt")) {
    return "interrupt";
  }
  if (request.method === "POST" && path.endsWith("/messages")) {
    return "sendText";
  }
  if (path.endsWith("/messages") || path.endsWith("/status")) {
    return "loadConversation";
  }
  return "listConversations";
};

const createFetch =
  (state: ContractState): typeof globalThis.fetch =>
  async (input, init) => {
    const request = new Request(input, init);
    const operation = operationOf(request);
    await state.awaitOperation(operation, request.signal);
    const injected = state.takeFailure(operation);
    if (injected !== undefined) throw injected;
    if (state.disconnectedError !== undefined) {
      throw state.disconnectedError;
    }
    const url = new URL(request.url);
    if (operation === "listConversations") {
      return envelope({
        conversations: [
          {
            conversationId: state.fixtures.conversation.id,
            title: state.fixtures.conversation.title,
            ...(state.fixtures.conversation.description === undefined
              ? {}
              : { description: state.fixtures.conversation.description }),
            ...(state.fixtures.conversation.updatedAt === undefined
              ? {}
              : {
                  updateTimestamp: state.fixtures.conversation.updatedAt,
                }),
          },
        ],
        cursor: null,
      });
    }
    if (url.pathname.endsWith("/messages") && request.method === "GET") {
      const messages = state.fixtures.initialSnapshot.timeline
        .filter(
          (
            item,
          ): item is Extract<
            (typeof state.fixtures.initialSnapshot.timeline)[number],
            { kind: "message" }
          > => item.kind === "message",
        )
        .map((item) =>
          messageDto({
            kind: "timeline.upsert",
            conversationId: item.conversationId,
            item,
          }),
        );
      return envelope({
        messages,
        events: [],
        cursor: state.fixtures.initialSnapshot.pageInfo.previousCursor ?? null,
      });
    }
    if (url.pathname.endsWith("/status")) {
      const run = state.fixtures.initialSnapshot.run;
      return envelope({
        working: run?.status === "running",
        taskId: run?.id ?? null,
        ...(run?.startedAt === undefined ? {} : { startedAt: run.startedAt }),
      });
    }
    if (operation === "sendText") {
      return envelope({ taskId: state.fixtures.sendTextSuccess.runId });
    }
    const body =
      typeof init?.body === "string"
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : {};
    if (
      body["taskId"] !== undefined &&
      body["taskId"] !== state.fixtures.initialSnapshot.run?.id
    ) {
      throw {
        code: "conflict",
        message: "Run is stale",
        retryable: false,
        conversationId: state.fixtures.conversation.id,
      } satisfies ChatError;
    }
    return envelope({
      taskId: state.fixtures.interruptSuccess.cancellationId,
    });
  };

const withContractRecording = (
  state: ContractState,
  delegate: ChatGateway,
): ChatGateway => ({
  async listConversations(input: ListConversationsInput) {
    state.calls.push({ operation: "listConversations", input });
    return delegate.listConversations(input);
  },
  async loadConversation(input: LoadConversationInput) {
    state.calls.push({ operation: "loadConversation", input });
    return delegate.loadConversation(input);
  },
  async subscribe(
    input: SubscribeConversationInput,
    observer,
  ): Promise<GatewayResult<GatewaySubscription>> {
    state.calls.push({ operation: "subscribe", input });
    const result = await delegate.subscribe(input, observer);
    if (!result.ok) return result;
    return {
      ok: true,
      value: {
        async dispose(options: GatewayRequestOptions) {
          state.disposingPoint = "subscription.dispose";
          try {
            await result.value.dispose(options);
          } finally {
            state.disposingPoint = undefined;
          }
        },
      },
    };
  },
  async sendText(input: SendTextInput) {
    state.calls.push({ operation: "sendText", input });
    return delegate.sendText(input);
  },
  async interrupt(input: InterruptRunInput) {
    state.calls.push({ operation: "interrupt", input });
    return delegate.interrupt(input);
  },
  async dispose(options: GatewayRequestOptions) {
    state.disposingPoint = "gateway.dispose";
    const hold = state.takeHold("gateway.dispose");
    hold?.markStarted();
    try {
      await delegate.dispose(options);
      hold?.markCompleted();
    } finally {
      state.disposingPoint = undefined;
    }
  },
});

export const createTFRobotGatewayContractHarness = (
  fixtures: ChatContractFixtures,
): GatewayContractHarness => {
  const state = new ContractState(fixtures);
  const delegate = createTFRobotChatGateway({
    baseUrl: "https://contract.robot.example/",
    fetch: createFetch(state),
    messageCreatorProvider: () => ({
      uid: "contract-user",
      name: "Contract user",
    }),
    now: () => state.nowValue,
    sessionProvider: {
      getSession(request) {
        state.currentConversationId = request.conversationId;
        return { kind: "bearer", token: "contract-token" };
      },
    },
    socketFactory(input) {
      const socket = new ContractSocket(
        state,
        input,
        state.currentConversationId ?? "",
      );
      return socket;
    },
  });
  const gateway = withContractRecording(state, delegate);
  const controller: GatewayContractController = {
    get calls() {
      return state.calls;
    },
    async advanceTimeTo(timestamp) {
      const delta = Math.max(0, timestamp - state.nowValue);
      state.nowValue = timestamp;
      await vi.advanceTimersByTimeAsync(delta);
    },
    disconnect(error) {
      state.disconnectedError = error;
      let count = 0;
      for (const socket of state.sockets) {
        if (socket.connected) count += 1;
        socket.transportDisconnect(error);
      }
      return count;
    },
    emitUpdate(update) {
      let count = 0;
      for (const socket of state.sockets) {
        if (socket.deliver(update)) count += 1;
      }
      return count;
    },
    failNext(operation, error) {
      state.failNext(operation, error);
    },
    holdNext(point) {
      return state.holdNext(point);
    },
    now() {
      return state.nowValue;
    },
    reconnect() {
      state.disconnectedError = undefined;
      for (const socket of state.sockets) socket.transportReconnect();
    },
  };
  return { controller, gateway };
};
