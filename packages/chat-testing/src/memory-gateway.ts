import {
  answerInteractionInputSchema,
  answerInteractionResultSchema,
  chatErrorSchema,
  chatSnapshotSchema,
  chatUpdateSchema,
  conversationPageSchema,
  createConversationInputSchema,
  createConversationResultSchema,
  createGatewayDeadlineExceededError,
  interruptRunInputSchema,
  interruptRunResultSchema,
  isGatewayDeadlineExceeded,
  isGatewayOperationSupported,
  listConversationsInputSchema,
  loadConversationInputSchema,
  sendTextInputSchema,
  sendTextResultSchema,
  subscribeConversationInputSchema,
  type ChatError,
  type AnswerInteractionInput,
  type AnswerInteractionSuccess,
  type ChatGateway,
  type ChatSnapshot,
  type ChatUpdate,
  type Conversation,
  type ConversationPage,
  type CreateConversationInput,
  type GatewayObserver,
  type GatewayRequestOptions,
  type GatewayResult,
  type GatewaySubscription,
  type InterruptRunInput,
  type InterruptRunSuccess,
  type ListConversationsInput,
  type LoadConversationInput,
  type SendTextInput,
  type SendTextSuccess,
  type SubscribeConversationInput,
} from "@turingfocus/chat-protocol";

import {
  createChatContractFixtures,
  type ChatContractFixtures,
} from "./fixtures.js";

import {
  FakeTransportSubscription,
  PendingHold,
  type MemoryGatewayHold,
  type MemoryGatewayHoldPoint,
  type MemoryGatewayOperation,
} from "./memory-gateway-holds.js";
import { MemoryGatewayClock } from "./memory-gateway-clock.js";

export type {
  MemoryGatewayHold,
  MemoryGatewayHoldPoint,
  MemoryGatewayOperation,
} from "./memory-gateway-holds.js";

export type MemoryGatewayCall =
  | {
      readonly operation: "answerInteraction";
      readonly input: AnswerInteractionInput;
    }
  | {
      readonly operation: "createConversation";
      readonly input: CreateConversationInput;
    }
  | { readonly operation: "interrupt"; readonly input: InterruptRunInput }
  | {
      readonly operation: "listConversations";
      readonly input: ListConversationsInput;
    }
  | {
      readonly operation: "loadConversation";
      readonly input: LoadConversationInput;
    }
  | { readonly operation: "sendText"; readonly input: SendTextInput }
  | {
      readonly operation: "subscribe";
      readonly input: SubscribeConversationInput;
    };

export interface MemoryChatGatewayOptions {
  readonly connected?: boolean | undefined;
  readonly fixtures?: ChatContractFixtures | undefined;
  readonly now?: (() => number) | undefined;
}

export interface MemoryGatewayController {
  readonly calls: readonly MemoryGatewayCall[];
  readonly connected: boolean;
  readonly disposed: boolean;
  disconnect(error?: ChatError): number;
  emitError(error: ChatError): number;
  emitUpdate(update: ChatUpdate): number;
  emitUpdateToAll(update: ChatUpdate): number;
  failNext(operation: MemoryGatewayOperation, error: ChatError): void;
  holdNext(point: MemoryGatewayHoldPoint): MemoryGatewayHold;
  now(): number;
  advanceTimeTo(timestamp: number): void;
  reconnect(): void;
  /** Scripts the exact page returned by every subsequent list request. */
  setConversationPage(page: ConversationPage): void;
  setAnswerInteractionResult(
    result: GatewayResult<AnswerInteractionSuccess>,
  ): void;
  setInterruptResult(result: GatewayResult<InterruptRunSuccess>): void;
  setSendTextResult(result: GatewayResult<SendTextSuccess>): void;
  /** Upserts one snapshot and makes its capabilities the creation defaults. */
  setSnapshot(snapshot: ChatSnapshot): void;
}

export interface MemoryGatewayHarness {
  readonly controller: MemoryGatewayController;
  readonly fixtures: ChatContractFixtures;
  readonly gateway: MemoryChatGatewayPort;
}

export type MemoryChatGatewayPort = ChatGateway &
  Required<Pick<ChatGateway, "createConversation">>;

interface ObserverRegistration {
  active: boolean;
  readonly conversationId: string;
  readonly observer: GatewayObserver;
  readonly transportSubscription?: FakeTransportSubscription | undefined;
}

interface HeldOperationOutcome {
  readonly failure?: GatewayResult<never> | undefined;
  readonly transportSubscription?: FakeTransportSubscription | undefined;
}

const unsupported = (message: string): GatewayResult<never> => ({
  ok: false,
  error: chatErrorSchema.parse({
    code: "unsupported",
    message,
    retryable: false,
  }),
});

const notFound = (conversationId: string): GatewayResult<never> => ({
  ok: false,
  error: chatErrorSchema.parse({
    code: "not-found",
    message: "Conversation was not found",
    retryable: false,
    conversationId,
  }),
});

const disposedError = (): GatewayResult<never> => ({
  ok: false,
  error: chatErrorSchema.parse({
    code: "conflict",
    message: "Gateway has been disposed",
    retryable: false,
  }),
});

const staleInterrupt = (
  conversationId: string,
  requestedRunId: string,
): GatewayResult<never> => ({
  ok: false,
  error: chatErrorSchema.parse({
    code: "conflict",
    message: "The requested run is no longer active",
    retryable: false,
    conversationId,
    details: { requestedRunId },
  }),
});

const updateConversationId = (update: ChatUpdate): string | undefined => {
  switch (update.kind) {
    case "snapshot.replace":
      return update.snapshot.conversation.id;
    case "conversation.upsert":
      return update.conversation.id;
    case "error.reported":
      return update.conversationId;
    default:
      return update.conversationId;
  }
};

class MemoryChatGateway implements ChatGateway {
  readonly #calls: MemoryGatewayCall[] = [];
  readonly #clock: MemoryGatewayClock;
  readonly #failures = new Map<MemoryGatewayOperation, ChatError[]>();
  readonly #holds = new Map<MemoryGatewayHoldPoint, PendingHold[]>();
  readonly #observers = new Set<ObserverRegistration>();
  readonly #snapshots = new Map<string, ChatSnapshot>();
  #connected: boolean;
  #answerInteractionResult: GatewayResult<AnswerInteractionSuccess>;
  readonly #conversations = new Map<string, Conversation>();
  #conversationIds: string[] = [];
  #conversationSequence = 0;
  #defaultCapabilities: ChatSnapshot["capabilities"];
  #disposed = false;
  #disposePromise: Promise<void> | undefined;
  #interruptResult: GatewayResult<InterruptRunSuccess>;
  #scriptedConversationPage: ConversationPage | undefined;
  #sendTextResult: GatewayResult<SendTextSuccess>;

  constructor(
    options: MemoryChatGatewayOptions,
    fixtures: ChatContractFixtures,
  ) {
    this.#connected = options.connected ?? true;
    this.#clock = new MemoryGatewayClock(options.now?.() ?? Date.now());
    this.#defaultCapabilities = fixtures.initialSnapshot.capabilities;
    this.#setSnapshot(fixtures.initialSnapshot, "append");
    this.#answerInteractionResult = answerInteractionResultSchema.parse({
      ok: true,
      value: fixtures.answerInteractionSuccess,
    });
    this.#sendTextResult = sendTextResultSchema.parse({
      ok: true,
      value: fixtures.sendTextSuccess,
    });
    this.#interruptResult = interruptRunResultSchema.parse({
      ok: true,
      value: fixtures.interruptSuccess,
    });
  }

  get calls(): readonly MemoryGatewayCall[] {
    return Object.freeze([...this.#calls]);
  }

  get connected(): boolean {
    return this.#connected;
  }

  get disposed(): boolean {
    return this.#disposed;
  }

  #record(call: MemoryGatewayCall): void {
    this.#calls.push(Object.freeze(call));
  }

  #setSnapshot(
    snapshot: ChatSnapshot,
    position: "append" | "front",
  ): ChatSnapshot {
    const parsed = chatSnapshotSchema.parse(snapshot);
    const conversationId = parsed.conversation.id;
    this.#snapshots.set(conversationId, parsed);
    this.#conversations.set(conversationId, parsed.conversation);
    if (!this.#conversationIds.includes(conversationId)) {
      if (position === "front") this.#conversationIds.unshift(conversationId);
      else this.#conversationIds.push(conversationId);
    }
    return parsed;
  }

  #snapshotFor(conversationId: string): ChatSnapshot | undefined {
    return this.#snapshots.get(conversationId);
  }

  #nextConversationId(): string {
    const isReserved = (conversationId: string): boolean =>
      this.#snapshots.has(conversationId) ||
      this.#conversations.has(conversationId) ||
      (this.#scriptedConversationPage?.conversations.some(
        (conversation) => conversation.id === conversationId,
      ) ??
        false);
    do {
      this.#conversationSequence += 1;
    } while (isReserved(`memory-conversation-${this.#conversationSequence}`));
    return `memory-conversation-${this.#conversationSequence}`;
  }

  #cursorOffset(cursor: string | undefined): number | undefined {
    if (cursor === undefined) return 0;
    if (!cursor.startsWith("memory:")) return undefined;
    try {
      const conversationId = decodeURIComponent(cursor.slice("memory:".length));
      const anchorIndex = this.#conversationIds.indexOf(conversationId);
      return anchorIndex === -1 ? undefined : anchorIndex + 1;
    } catch {
      return undefined;
    }
  }

  #conversationPageFor(
    input: ListConversationsInput,
  ): GatewayResult<ConversationPage> {
    if (this.#scriptedConversationPage !== undefined) {
      return { ok: true, value: this.#scriptedConversationPage };
    }
    const offset = this.#cursorOffset(input.cursor);
    if (offset === undefined) {
      return {
        ok: false,
        error: chatErrorSchema.parse({
          code: "validation",
          message: "Memory Gateway conversation cursor is invalid",
          retryable: false,
        }),
      };
    }
    const end = Math.min(
      this.#conversationIds.length,
      offset + (input.limit ?? this.#conversationIds.length),
    );
    const conversations = this.#conversationIds
      .slice(offset, end)
      .map((conversationId) => this.#conversations.get(conversationId)!);
    const nextCursor =
      end < this.#conversationIds.length
        ? `memory:${encodeURIComponent(this.#conversationIds[end - 1]!)}`
        : undefined;
    return {
      ok: true,
      value: conversationPageSchema.parse({
        conversations,
        ...(nextCursor === undefined ? {} : { nextCursor }),
      }),
    };
  }

  #takeHold(point: MemoryGatewayHoldPoint): PendingHold | undefined {
    return this.#holds.get(point)?.shift();
  }

  async #waitForOperation(
    operation: MemoryGatewayOperation,
    input: GatewayRequestOptions,
  ): Promise<HeldOperationOutcome | undefined> {
    const hold = this.#takeHold(operation);
    if (hold === undefined) return undefined;
    const transportCompletion = hold.start();
    const deadline = this.#clock.signal(input.deadlineAt);
    const outcome = await Promise.race([
      transportCompletion.then(() => "transport" as const),
      deadline.promise.then(() => "deadline" as const),
    ]);
    if (outcome === "transport") {
      deadline.cancel();
      const completion = await transportCompletion;
      if (this.#disposed) {
        completion.subscription?.dispose();
        return { failure: disposedError() };
      }
      return { transportSubscription: completion.subscription };
    }

    if (operation === "subscribe") {
      void transportCompletion.then((completion) => {
        completion.subscription?.dispose();
      });
    }
    return {
      failure: {
        ok: false,
        error: createGatewayDeadlineExceededError(
          "conversationId" in input && typeof input.conversationId === "string"
            ? input.conversationId
            : undefined,
        ),
      },
    };
  }

  async #waitForCleanup(
    point: "gateway.dispose" | "subscription.dispose",
    options: GatewayRequestOptions,
  ): Promise<void> {
    const hold = this.#takeHold(point);
    if (hold === undefined) return;
    const transportCompletion = hold.start();
    const deadline = this.#clock.signal(options.deadlineAt);
    const outcome = await Promise.race([
      transportCompletion.then(() => "transport" as const),
      deadline.promise.then(() => "deadline" as const),
    ]);
    if (outcome === "transport") deadline.cancel();
  }

  #deadlineOrDisposedGuard<T>(
    input: GatewayRequestOptions,
  ): GatewayResult<T> | undefined {
    if (isGatewayDeadlineExceeded(input, this.#clock.now())) {
      return {
        ok: false,
        error: createGatewayDeadlineExceededError(
          "conversationId" in input && typeof input.conversationId === "string"
            ? input.conversationId
            : undefined,
        ),
      };
    }
    if (this.#disposed) return disposedError();
    return undefined;
  }

  #disconnectedGuard<T>(
    input: GatewayRequestOptions,
  ): GatewayResult<T> | undefined {
    if (this.#connected) return undefined;
    return {
      ok: false,
      error: chatErrorSchema.parse({
        code: "network",
        message: "Memory Gateway is disconnected",
        retryable: true,
        ...("conversationId" in input &&
        typeof input.conversationId === "string"
          ? { conversationId: input.conversationId }
          : {}),
      }),
    };
  }

  #guard<T>(
    operation: MemoryGatewayOperation,
    input: GatewayRequestOptions,
  ): GatewayResult<T> | undefined {
    const unavailable = this.#deadlineOrDisposedGuard<T>(input);
    if (unavailable !== undefined) return unavailable;

    const failures = this.#failures.get(operation);
    const failure = failures?.shift();
    if (failure !== undefined) return { ok: false, error: failure };

    return this.#disconnectedGuard<T>(input);
  }

  #settledGuard<T>(input: GatewayRequestOptions): GatewayResult<T> | undefined {
    return (
      this.#deadlineOrDisposedGuard<T>(input) ??
      this.#disconnectedGuard<T>(input)
    );
  }

  async listConversations(
    input: ListConversationsInput,
  ): Promise<GatewayResult<ConversationPage>> {
    const parsedInput = listConversationsInputSchema.parse(input);
    this.#record({ operation: "listConversations", input: parsedInput });
    const guarded = this.#guard<ConversationPage>(
      "listConversations",
      parsedInput,
    );
    if (guarded !== undefined) return guarded;
    const held = await this.#waitForOperation("listConversations", parsedInput);
    if (held?.failure !== undefined) return held.failure;
    const settled = this.#settledGuard<ConversationPage>(parsedInput);
    if (settled !== undefined) return settled;
    if (
      !isGatewayOperationSupported(
        this.#defaultCapabilities,
        "listConversations",
      )
    ) {
      return unsupported("Conversation listing is unavailable");
    }
    return this.#conversationPageFor(parsedInput);
  }

  async createConversation(
    input: CreateConversationInput,
  ): Promise<GatewayResult<Conversation>> {
    const parsedInput = createConversationInputSchema.parse(input);
    this.#record({ operation: "createConversation", input: parsedInput });
    const guarded = this.#guard<Conversation>(
      "createConversation",
      parsedInput,
    );
    if (guarded !== undefined) return guarded;
    const held = await this.#waitForOperation(
      "createConversation",
      parsedInput,
    );
    if (held?.failure !== undefined) return held.failure;
    const settled = this.#settledGuard<Conversation>(parsedInput);
    if (settled !== undefined) return settled;

    const conversation: Conversation = {
      id: this.#nextConversationId(),
      title: parsedInput.title,
      updatedAt: this.#clock.now(),
    };
    this.#setSnapshot(
      {
        conversation,
        timeline: [],
        run: null,
        capabilities: this.#defaultCapabilities,
        pageInfo: { hasPreviousPage: false },
      },
      "front",
    );
    return createConversationResultSchema.parse({
      ok: true,
      value: conversation,
    });
  }

  async answerInteraction(
    input: AnswerInteractionInput,
  ): Promise<GatewayResult<AnswerInteractionSuccess>> {
    const parsed = answerInteractionInputSchema.safeParse(input);
    if (!parsed.success) {
      return {
        ok: false,
        error: chatErrorSchema.parse({
          code: "validation",
          message: "Interaction answer input is invalid",
          retryable: false,
          ...(typeof input.conversationId === "string"
            ? { conversationId: input.conversationId }
            : {}),
        }),
      };
    }
    const parsedInput = parsed.data;
    this.#record({ operation: "answerInteraction", input: parsedInput });
    const guarded = this.#guard<AnswerInteractionSuccess>(
      "answerInteraction",
      parsedInput,
    );
    if (guarded !== undefined) return guarded;
    const held = await this.#waitForOperation("answerInteraction", parsedInput);
    if (held?.failure !== undefined) return held.failure;
    const settled = this.#settledGuard<AnswerInteractionSuccess>(parsedInput);
    if (settled !== undefined) return settled;
    const snapshot = this.#snapshotFor(parsedInput.conversationId);
    if (snapshot === undefined) return notFound(parsedInput.conversationId);
    if (
      !isGatewayOperationSupported(snapshot.capabilities, "answerInteraction")
    ) {
      return unsupported("Interaction answers are unavailable");
    }
    if (
      snapshot.pendingInteraction?.requestId !== parsedInput.answer.requestId ||
      snapshot.pendingInteraction.revision !== parsedInput.answer.revision
    ) {
      return {
        ok: false,
        error: chatErrorSchema.parse({
          code: "conflict",
          message: "The interaction request is no longer pending",
          retryable: false,
          conversationId: parsedInput.conversationId,
        }),
      };
    }
    return this.#answerInteractionResult;
  }

  async loadConversation(
    input: LoadConversationInput,
  ): Promise<GatewayResult<ChatSnapshot>> {
    const parsedInput = loadConversationInputSchema.parse(input);
    this.#record({ operation: "loadConversation", input: parsedInput });
    const guarded = this.#guard<ChatSnapshot>("loadConversation", parsedInput);
    if (guarded !== undefined) return guarded;
    const held = await this.#waitForOperation("loadConversation", parsedInput);
    if (held?.failure !== undefined) return held.failure;
    const settled = this.#settledGuard<ChatSnapshot>(parsedInput);
    if (settled !== undefined) return settled;
    const snapshot = this.#snapshotFor(parsedInput.conversationId);
    if (snapshot === undefined) return notFound(parsedInput.conversationId);
    if (
      parsedInput.previousCursor !== undefined &&
      !isGatewayOperationSupported(snapshot.capabilities, "loadHistory")
    ) {
      return unsupported("History loading is unavailable");
    }
    return { ok: true, value: snapshot };
  }

  async subscribe(
    input: SubscribeConversationInput,
    observer: GatewayObserver,
  ): Promise<GatewayResult<GatewaySubscription>> {
    const parsedInput = subscribeConversationInputSchema.parse(input);
    this.#record({ operation: "subscribe", input: parsedInput });
    const guarded = this.#guard<GatewaySubscription>("subscribe", parsedInput);
    if (guarded !== undefined) return guarded;
    const held = await this.#waitForOperation("subscribe", parsedInput);
    if (held?.failure !== undefined) return held.failure;
    const settled = this.#settledGuard<GatewaySubscription>(parsedInput);
    if (settled !== undefined) {
      held?.transportSubscription?.dispose();
      return settled;
    }
    const snapshot = this.#snapshotFor(parsedInput.conversationId);
    if (snapshot === undefined) {
      held?.transportSubscription?.dispose();
      return notFound(parsedInput.conversationId);
    }
    if (!isGatewayOperationSupported(snapshot.capabilities, "subscribe")) {
      held?.transportSubscription?.dispose();
      return unsupported("Live updates are unavailable");
    }

    const registration: ObserverRegistration = {
      active: true,
      conversationId: parsedInput.conversationId,
      observer,
      ...(held?.transportSubscription === undefined
        ? {}
        : { transportSubscription: held.transportSubscription }),
    };
    this.#observers.add(registration);
    return {
      ok: true,
      value: Object.freeze({
        dispose: async (options: GatewayRequestOptions) => {
          registration.active = false;
          this.#observers.delete(registration);
          registration.transportSubscription?.dispose();
          await this.#waitForCleanup("subscription.dispose", options);
        },
      }),
    };
  }

  async sendText(
    input: SendTextInput,
  ): Promise<GatewayResult<SendTextSuccess>> {
    const parsedInput = sendTextInputSchema.parse(input);
    this.#record({ operation: "sendText", input: parsedInput });
    const guarded = this.#guard<SendTextSuccess>("sendText", parsedInput);
    if (guarded !== undefined) return guarded;
    const held = await this.#waitForOperation("sendText", parsedInput);
    if (held?.failure !== undefined) return held.failure;
    const settled = this.#settledGuard<SendTextSuccess>(parsedInput);
    if (settled !== undefined) return settled;
    const snapshot = this.#snapshotFor(parsedInput.conversationId);
    if (snapshot === undefined) return notFound(parsedInput.conversationId);
    if (!isGatewayOperationSupported(snapshot.capabilities, "sendText")) {
      return unsupported("Text sending is unavailable");
    }
    return this.#sendTextResult;
  }

  async interrupt(
    input: InterruptRunInput,
  ): Promise<GatewayResult<InterruptRunSuccess>> {
    const parsedInput = interruptRunInputSchema.parse(input);
    this.#record({ operation: "interrupt", input: parsedInput });
    const guarded = this.#guard<InterruptRunSuccess>("interrupt", parsedInput);
    if (guarded !== undefined) return guarded;
    const held = await this.#waitForOperation("interrupt", parsedInput);
    if (held?.failure !== undefined) return held.failure;
    const settled = this.#settledGuard<InterruptRunSuccess>(parsedInput);
    if (settled !== undefined) return settled;
    const snapshot = this.#snapshotFor(parsedInput.conversationId);
    if (snapshot === undefined) return notFound(parsedInput.conversationId);
    if (
      parsedInput.runId !== undefined &&
      parsedInput.runId !== snapshot.run?.id
    ) {
      return staleInterrupt(parsedInput.conversationId, parsedInput.runId);
    }
    if (
      !isGatewayOperationSupported(
        snapshot.capabilities,
        "interrupt",
        snapshot.run,
      )
    ) {
      return unsupported("Run interruption is unavailable");
    }
    return this.#interruptResult;
  }

  dispose(options: GatewayRequestOptions): Promise<void> | undefined {
    if (this.#disposed) return this.#disposePromise;
    this.#disposed = true;
    for (const registration of this.#observers) {
      registration.active = false;
      registration.transportSubscription?.dispose();
    }
    this.#observers.clear();
    this.#disposePromise = this.#waitForCleanup("gateway.dispose", options);
    return this.#disposePromise;
  }

  emitUpdate(update: ChatUpdate): number {
    return this.#deliverUpdate(update, true);
  }

  emitUpdateToAll(update: ChatUpdate): number {
    return this.#deliverUpdate(update, false);
  }

  #deliverUpdate(update: ChatUpdate, filterConversation: boolean): number {
    if (this.#disposed || !this.#connected) return 0;
    const parsed = chatUpdateSchema.parse(update);
    const conversationId = updateConversationId(parsed);
    let delivered = 0;
    for (const registration of this.#observers) {
      if (
        registration.active &&
        (!filterConversation ||
          conversationId === undefined ||
          conversationId === registration.conversationId)
      ) {
        registration.observer.next(parsed);
        delivered += 1;
      }
    }
    return delivered;
  }

  emitError(error: ChatError): number {
    if (this.#disposed) return 0;
    const parsed = chatErrorSchema.parse(error);
    let delivered = 0;
    for (const registration of this.#observers) {
      if (
        registration.active &&
        (parsed.conversationId === undefined ||
          parsed.conversationId === registration.conversationId)
      ) {
        registration.observer.error?.(parsed);
        delivered += 1;
      }
    }
    return delivered;
  }

  disconnect(error: ChatError): number {
    if (this.#disposed || !this.#connected) return 0;
    this.#connected = false;
    return this.emitError(error);
  }

  reconnect(): void {
    if (this.#disposed) {
      throw new Error("Cannot reconnect a disposed Memory Gateway");
    }
    this.#connected = true;
  }

  failNext(operation: MemoryGatewayOperation, error: ChatError): void {
    const failures = this.#failures.get(operation) ?? [];
    failures.push(chatErrorSchema.parse(error));
    this.#failures.set(operation, failures);
  }

  holdNext(point: MemoryGatewayHoldPoint): MemoryGatewayHold {
    const hold = new PendingHold(point);
    const holds = this.#holds.get(point) ?? [];
    holds.push(hold);
    this.#holds.set(point, holds);
    return hold;
  }

  now(): number {
    return this.#clock.now();
  }

  advanceTimeTo(timestamp: number): void {
    this.#clock.advanceTo(timestamp);
  }

  setConversationPage(page: ConversationPage): void {
    this.#scriptedConversationPage = conversationPageSchema.parse(page);
  }

  setAnswerInteractionResult(
    result: GatewayResult<AnswerInteractionSuccess>,
  ): void {
    this.#answerInteractionResult = answerInteractionResultSchema.parse(result);
  }

  setInterruptResult(result: GatewayResult<InterruptRunSuccess>): void {
    this.#interruptResult = interruptRunResultSchema.parse(result);
  }

  setSendTextResult(result: GatewayResult<SendTextSuccess>): void {
    this.#sendTextResult = sendTextResultSchema.parse(result);
  }

  setSnapshot(snapshot: ChatSnapshot): void {
    this.#defaultCapabilities = this.#setSnapshot(
      snapshot,
      "append",
    ).capabilities;
  }
}

/** Creates one isolated, scriptable, network-free ChatGateway test harness. */
export const createMemoryChatGateway = (
  options: MemoryChatGatewayOptions = {},
): MemoryGatewayHarness => {
  const fixtures = options.fixtures ?? createChatContractFixtures();
  const implementation = new MemoryChatGateway(options, fixtures);
  const controller: MemoryGatewayController = {
    get calls() {
      return implementation.calls;
    },
    get connected() {
      return implementation.connected;
    },
    get disposed() {
      return implementation.disposed;
    },
    disconnect: (error = fixtures.disconnectError) =>
      implementation.disconnect(error),
    emitError: (error) => implementation.emitError(error),
    emitUpdate: (update) => implementation.emitUpdate(update),
    emitUpdateToAll: (update) => implementation.emitUpdateToAll(update),
    failNext: (operation, error) => implementation.failNext(operation, error),
    holdNext: (point) => implementation.holdNext(point),
    now: () => implementation.now(),
    advanceTimeTo: (timestamp) => implementation.advanceTimeTo(timestamp),
    reconnect: () => implementation.reconnect(),
    setConversationPage: (page) => implementation.setConversationPage(page),
    setAnswerInteractionResult: (result) =>
      implementation.setAnswerInteractionResult(result),
    setInterruptResult: (result) => implementation.setInterruptResult(result),
    setSendTextResult: (result) => implementation.setSendTextResult(result),
    setSnapshot: (snapshot) => implementation.setSnapshot(snapshot),
  };

  return Object.freeze({
    controller: Object.freeze(controller),
    fixtures,
    gateway: implementation,
  });
};
