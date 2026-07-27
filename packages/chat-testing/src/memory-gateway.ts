import {
  chatErrorSchema,
  chatSnapshotSchema,
  chatUpdateSchema,
  conversationPageSchema,
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
  type ChatGateway,
  type ChatSnapshot,
  type ChatUpdate,
  type ConversationPage,
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
  setConversationPage(page: ConversationPage): void;
  setInterruptResult(result: GatewayResult<InterruptRunSuccess>): void;
  setSendTextResult(result: GatewayResult<SendTextSuccess>): void;
  setSnapshot(snapshot: ChatSnapshot): void;
}

export interface MemoryGatewayHarness {
  readonly controller: MemoryGatewayController;
  readonly fixtures: ChatContractFixtures;
  readonly gateway: ChatGateway;
}

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
  #connected: boolean;
  #conversationPage: ConversationPage;
  #disposed = false;
  #disposePromise: Promise<void> | undefined;
  #interruptResult: GatewayResult<InterruptRunSuccess>;
  #sendTextResult: GatewayResult<SendTextSuccess>;
  #snapshot: ChatSnapshot;

  constructor(
    options: MemoryChatGatewayOptions,
    fixtures: ChatContractFixtures,
  ) {
    this.#connected = options.connected ?? true;
    this.#clock = new MemoryGatewayClock(options.now?.() ?? Date.now());
    this.#conversationPage = conversationPageSchema.parse({
      conversations: [fixtures.conversation],
    });
    this.#snapshot = fixtures.initialSnapshot;
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

  #guard<T>(
    operation: MemoryGatewayOperation,
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

    const failures = this.#failures.get(operation);
    const failure = failures?.shift();
    if (failure !== undefined) return { ok: false, error: failure };

    if (!this.#connected) {
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
    return undefined;
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
    if (
      !isGatewayOperationSupported(
        this.#snapshot.capabilities,
        "listConversations",
      )
    ) {
      return unsupported("Conversation listing is unavailable");
    }
    return { ok: true, value: this.#conversationPage };
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
    if (parsedInput.conversationId !== this.#snapshot.conversation.id) {
      return notFound(parsedInput.conversationId);
    }
    if (
      parsedInput.previousCursor !== undefined &&
      !isGatewayOperationSupported(this.#snapshot.capabilities, "loadHistory")
    ) {
      return unsupported("History loading is unavailable");
    }
    return { ok: true, value: this.#snapshot };
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
    if (parsedInput.conversationId !== this.#snapshot.conversation.id) {
      held?.transportSubscription?.dispose();
      return notFound(parsedInput.conversationId);
    }
    if (
      !isGatewayOperationSupported(this.#snapshot.capabilities, "subscribe")
    ) {
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
    if (parsedInput.conversationId !== this.#snapshot.conversation.id) {
      return notFound(parsedInput.conversationId);
    }
    if (!isGatewayOperationSupported(this.#snapshot.capabilities, "sendText")) {
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
    if (parsedInput.conversationId !== this.#snapshot.conversation.id) {
      return notFound(parsedInput.conversationId);
    }
    if (
      parsedInput.runId !== undefined &&
      parsedInput.runId !== this.#snapshot.run?.id
    ) {
      return staleInterrupt(parsedInput.conversationId, parsedInput.runId);
    }
    if (
      !isGatewayOperationSupported(
        this.#snapshot.capabilities,
        "interrupt",
        this.#snapshot.run,
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
    this.#conversationPage = conversationPageSchema.parse(page);
  }

  setInterruptResult(result: GatewayResult<InterruptRunSuccess>): void {
    this.#interruptResult = interruptRunResultSchema.parse(result);
  }

  setSendTextResult(result: GatewayResult<SendTextSuccess>): void {
    this.#sendTextResult = sendTextResultSchema.parse(result);
  }

  setSnapshot(snapshot: ChatSnapshot): void {
    this.#snapshot = chatSnapshotSchema.parse(snapshot);
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
