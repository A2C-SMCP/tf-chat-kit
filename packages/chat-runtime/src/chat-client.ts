import {
  isGatewayOperationSupported,
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
} from "@turingfocus/chat-protocol";

import {
  createGatewayNotificationQueue,
  type GatewayNotification,
  type GatewayNotificationQueue,
} from "./gateway-notification-queue.js";
import { cloneImmutable, deepEqual } from "./immutable.js";
import {
  applySnapshotError,
  applySnapshotUpdate,
  createSnapshotState,
  rebaseSnapshotState,
  type SnapshotState,
  updateConversationId,
  updateSnapshotState,
} from "./snapshot-state.js";
import {
  SnapshotStore,
  type SnapshotListener,
  type SnapshotSubscription,
} from "./snapshot-store.js";
import { mergeHistoryTimeline } from "./timeline.js";

export interface ChatClientOptions {
  /** The instance-owned transport port. ChatClient disposes it on shutdown. */
  readonly gateway: ChatGateway;
  /** Receives isolated listener and best-effort subscription cleanup failures. */
  readonly onUnhandledError?:
    ((failure: ChatClientUnhandledError) => void) | undefined;
}

export type ChatClientUnhandledErrorSource =
  "listener" | "subscription-cleanup";

export interface ChatClientUnhandledError {
  readonly cause: unknown;
  readonly conversationId?: string | undefined;
  readonly source: ChatClientUnhandledErrorSource;
}

export type ChatSnapshotListener = SnapshotListener;
export type ChatClientSubscription = SnapshotSubscription;

interface PendingHandoff {
  readonly baseline: SnapshotState;
  readonly conversationId: string;
  readonly enqueue: GatewayNotificationQueue["enqueue"];
  readonly requestId: number;
  readonly sourceGeneration: number;
}

const runtimeFailure = <T>(
  code: ChatError["code"],
  message: string,
  conversationId?: string,
): GatewayResult<T> => ({
  ok: false,
  error: cloneImmutable({
    code,
    message,
    retryable: false,
    ...(conversationId === undefined ? {} : { conversationId }),
  }),
});

const runCleanup = async (
  cleanup: () => unknown,
  onError: (error: unknown) => void,
): Promise<void> => {
  try {
    await cleanup();
  } catch (error) {
    onError(error);
  }
};

/**
 * Headless, instance-scoped owner of normalized chat state and commands.
 * Each instance owns exactly one injected Gateway and its subscriptions.
 */
export class ChatClient {
  readonly #gateway: ChatGateway;
  readonly #onUnhandledError:
    ((failure: ChatClientUnhandledError) => void) | undefined;
  readonly #snapshotStore: SnapshotStore;
  #disposed = false;
  #disposePromise: Promise<void> | undefined;
  #generation = 0;
  #gatewaySubscription: GatewaySubscription | undefined;
  #historyRequestId = 0;
  #loadRequestId = 0;
  #pendingHandoff: PendingHandoff | undefined;

  constructor(options: ChatClientOptions) {
    this.#gateway = options.gateway;
    this.#onUnhandledError = options.onUnhandledError;
    this.#snapshotStore = new SnapshotStore({
      onListenerError: (cause) => {
        this.#reportUnhandledError({ cause, source: "listener" });
      },
    });
  }

  get disposed(): boolean {
    return this.#disposed;
  }

  getSnapshot(): ChatSnapshot | null {
    return this.#snapshotStore.getSnapshot();
  }

  subscribe(listener: ChatSnapshotListener): ChatClientSubscription {
    return this.#snapshotStore.subscribe(listener);
  }

  async loadConversation(
    input: LoadConversationInput,
  ): Promise<GatewayResult<ChatSnapshot>> {
    if (this.#disposed) {
      return runtimeFailure(
        "conflict",
        "ChatClient has already been disposed",
        input.conversationId,
      );
    }
    if (input.previousCursor !== undefined) return this.#loadHistory(input);

    const requestId = ++this.#loadRequestId;
    if (this.#disposed) {
      return runtimeFailure(
        "conflict",
        "Conversation load was superseded",
        input.conversationId,
      );
    }

    const notificationQueue = createGatewayNotificationQueue(
      (notification, generation) => {
        if (notification.kind === "update") {
          this.#applyGatewayUpdate(notification.update, generation);
        } else {
          this.#applyGatewayError(notification.error, generation);
        }
      },
    );
    const baseline = this.#snapshotStore.state;
    if (baseline?.snapshot.conversation.id === input.conversationId) {
      this.#pendingHandoff = {
        baseline,
        conversationId: input.conversationId,
        enqueue: notificationQueue.enqueue,
        requestId,
        sourceGeneration: this.#generation,
      };
    }
    // Register the observer before loading the snapshot so notifications that
    // occur at the snapshot boundary are buffered instead of being lost.
    const subscribed = await this.#subscribeGateway(input, notificationQueue);
    if (this.#disposed || requestId !== this.#loadRequestId) {
      this.#clearPendingHandoff(requestId);
      await this.#discardGatewaySubscription(subscribed, input);
      return runtimeFailure(
        "conflict",
        "Conversation load was superseded",
        input.conversationId,
      );
    }

    const loaded = await this.#gateway.loadConversation(input);
    if (!loaded.ok) {
      this.#clearPendingHandoff(requestId);
      await this.#discardGatewaySubscription(subscribed, input);
      if (this.#disposed || requestId !== this.#loadRequestId) {
        return runtimeFailure(
          "conflict",
          "Conversation load was superseded",
          input.conversationId,
        );
      }
      return loaded;
    }
    if (this.#disposed || requestId !== this.#loadRequestId) {
      this.#clearPendingHandoff(requestId);
      if (loaded.value.capabilities.liveUpdates) {
        await this.#discardGatewaySubscription(subscribed, input);
      }
      return runtimeFailure(
        "conflict",
        "Conversation load was superseded",
        input.conversationId,
      );
    }
    if (loaded.value.conversation.id !== input.conversationId) {
      this.#clearPendingHandoff(requestId);
      await this.#discardGatewaySubscription(subscribed, input);
      return runtimeFailure(
        "validation",
        "Gateway returned a snapshot for a different conversation",
        input.conversationId,
      );
    }
    if (loaded.value.capabilities.liveUpdates && !subscribed.ok) {
      this.#clearPendingHandoff(requestId);
      if (this.#disposed || requestId !== this.#loadRequestId) {
        return runtimeFailure(
          "conflict",
          "Conversation load was superseded",
          input.conversationId,
        );
      }
      return subscribed;
    }
    if (!loaded.value.capabilities.liveUpdates) {
      await this.#discardGatewaySubscription(subscribed, input);
    }
    if (this.#disposed || requestId !== this.#loadRequestId) {
      this.#clearPendingHandoff(requestId);
      await this.#discardGatewaySubscription(subscribed, input);
      return runtimeFailure(
        "conflict",
        "Conversation load was superseded",
        input.conversationId,
      );
    }

    const previousSubscription = this.#gatewaySubscription;
    const generation = ++this.#generation;
    this.#historyRequestId += 1;
    this.#gatewaySubscription =
      loaded.value.capabilities.liveUpdates && subscribed.ok
        ? subscribed.value
        : undefined;
    const loadedState = createSnapshotState(loaded.value);
    const currentState = this.#snapshotStore.state;
    const handoff = this.#pendingHandoff;
    const nextState =
      handoff?.requestId === requestId && currentState !== null
        ? rebaseSnapshotState(handoff.baseline, loadedState, currentState)
        : loadedState;
    this.#snapshotStore.commit(nextState);
    if (!this.#disposed) notificationQueue.activate(generation);
    this.#clearPendingHandoff(requestId);
    await this.#runSubscriptionCleanup(
      () => previousSubscription?.dispose(input),
      input.conversationId,
    );

    if (
      this.#disposed ||
      requestId !== this.#loadRequestId ||
      generation !== this.#generation ||
      this.#snapshotStore.state?.snapshot.conversation.id !==
        input.conversationId
    ) {
      return runtimeFailure(
        "conflict",
        "Conversation load was superseded",
        input.conversationId,
      );
    }
    return { ok: true, value: this.#snapshotStore.state!.snapshot };
  }

  async sendText(
    input: SendTextInput,
  ): Promise<GatewayResult<SendTextSuccess>> {
    const state = this.#activeState(input.conversationId);
    if (!state.ok) return state;
    if (!isGatewayOperationSupported(state.value.capabilities, "sendText")) {
      return runtimeFailure(
        "unsupported",
        "Text sending is unavailable",
        input.conversationId,
      );
    }

    const generation = this.#generation;
    const result = await this.#gateway.sendText(input);
    if (!result.ok) this.#reportError(result.error, generation);
    return result;
  }

  async interrupt(
    input: InterruptRunInput,
  ): Promise<GatewayResult<InterruptRunSuccess>> {
    const state = this.#activeState(input.conversationId);
    if (!state.ok) return state;
    const run = state.value.run;
    if (input.runId !== undefined && input.runId !== run?.id) {
      return runtimeFailure(
        "conflict",
        "Interrupt target is no longer the active run",
        input.conversationId,
      );
    }
    if (
      !isGatewayOperationSupported(state.value.capabilities, "interrupt", run)
    ) {
      return runtimeFailure(
        "unsupported",
        "The active run cannot be interrupted",
        input.conversationId,
      );
    }

    const generation = this.#generation;
    const runId = run!.id;
    // Bind "interrupt the current run" to the run observed above. Otherwise a
    // Gateway that resolves the omitted runId after an async boundary could
    // accidentally interrupt a replacement run.
    const result = await this.#gateway.interrupt(
      input.runId === undefined ? { ...input, runId } : input,
    );
    if (
      !result.ok &&
      this.#snapshotStore.state?.snapshot.run?.id === runId &&
      this.#snapshotStore.state.snapshot.conversation.id ===
        input.conversationId
    ) {
      this.#reportError(result.error, generation);
    }
    return result;
  }

  dispose(options: GatewayRequestOptions): Promise<void> {
    if (this.#disposePromise !== undefined) return this.#disposePromise;

    this.#disposed = true;
    this.#generation += 1;
    this.#historyRequestId += 1;
    this.#loadRequestId += 1;
    this.#pendingHandoff = undefined;
    this.#snapshotStore.close();
    const subscription = this.#gatewaySubscription;
    this.#gatewaySubscription = undefined;

    this.#disposePromise = Promise.allSettled([
      Promise.resolve().then(() => subscription?.dispose(options)),
      Promise.resolve().then(() => this.#gateway.dispose(options)),
    ]).then((results) => {
      const failures = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) {
        throw new AggregateError(
          failures,
          "ChatClient failed to dispose all owned resources",
        );
      }
    });
    return this.#disposePromise;
  }

  async #loadHistory(
    input: LoadConversationInput,
  ): Promise<GatewayResult<ChatSnapshot>> {
    const active = this.#activeState(input.conversationId);
    if (!active.ok) return active;
    if (
      !isGatewayOperationSupported(active.value.capabilities, "loadHistory")
    ) {
      return runtimeFailure(
        "unsupported",
        "History loading is unavailable",
        input.conversationId,
      );
    }

    if (active.value.pageInfo.previousCursor !== input.previousCursor) {
      return runtimeFailure(
        "conflict",
        "History cursor is no longer current",
        input.conversationId,
      );
    }

    const generation = this.#generation;
    const requestId = ++this.#historyRequestId;
    const baselineCursor = active.value.pageInfo.previousCursor;
    const loaded = await this.#gateway.loadConversation(input);
    if (!loaded.ok) {
      if (
        this.#disposed ||
        generation !== this.#generation ||
        requestId !== this.#historyRequestId ||
        this.#snapshotStore.state?.snapshot.pageInfo.previousCursor !==
          baselineCursor
      ) {
        return runtimeFailure(
          "conflict",
          "History load was superseded",
          input.conversationId,
        );
      }
      this.#reportError(loaded.error, generation);
      return loaded;
    }
    if (
      this.#disposed ||
      generation !== this.#generation ||
      requestId !== this.#historyRequestId ||
      this.#snapshotStore.state?.snapshot.pageInfo.previousCursor !==
        baselineCursor ||
      this.#snapshotStore.state?.snapshot.conversation.id !==
        input.conversationId
    ) {
      return runtimeFailure(
        "conflict",
        "History load was superseded",
        input.conversationId,
      );
    }
    if (loaded.value.conversation.id !== input.conversationId) {
      return runtimeFailure(
        "validation",
        "Gateway returned history for a different conversation",
        input.conversationId,
      );
    }

    const state = this.#snapshotStore.state!;
    const timeline = mergeHistoryTimeline(
      state.timeline,
      loaded.value.timeline,
    );
    const pageInfo = cloneImmutable(loaded.value.pageInfo);
    if (
      timeline !== state.timeline ||
      !deepEqual(pageInfo, state.snapshot.pageInfo)
    ) {
      this.#snapshotStore.commit(
        updateSnapshotState(state, { timeline, pageInfo }),
      );
    }
    const committed = this.#snapshotStore.state;
    if (
      this.#disposed ||
      generation !== this.#generation ||
      requestId !== this.#historyRequestId ||
      committed === null ||
      committed.snapshot.conversation.id !== input.conversationId
    ) {
      return runtimeFailure(
        "conflict",
        "History load was superseded",
        input.conversationId,
      );
    }
    return { ok: true, value: committed.snapshot };
  }

  #activeState(conversationId: string): GatewayResult<ChatSnapshot> {
    if (this.#disposed) {
      return runtimeFailure(
        "conflict",
        "ChatClient has already been disposed",
        conversationId,
      );
    }
    if (
      this.#snapshotStore.state?.snapshot.conversation.id !== conversationId
    ) {
      return runtimeFailure(
        "conflict",
        "Conversation is not active in this ChatClient",
        conversationId,
      );
    }
    return { ok: true, value: this.#snapshotStore.state.snapshot };
  }

  #subscribeGateway(
    input: LoadConversationInput,
    notificationQueue: GatewayNotificationQueue,
  ): Promise<GatewayResult<GatewaySubscription>> {
    return Promise.resolve(
      this.#gateway.subscribe(
        {
          conversationId: input.conversationId,
          deadlineAt: input.deadlineAt,
        },
        {
          next: (update) =>
            notificationQueue.enqueue({ kind: "update", update }),
          error: (error) => notificationQueue.enqueue({ kind: "error", error }),
        },
      ),
    );
  }

  async #discardGatewaySubscription(
    subscribed: GatewayResult<GatewaySubscription>,
    input: LoadConversationInput,
  ): Promise<void> {
    if (!subscribed.ok) return;
    await this.#runSubscriptionCleanup(
      () => subscribed.value.dispose(input),
      input.conversationId,
    );
  }

  #clearPendingHandoff(requestId: number): void {
    if (this.#pendingHandoff?.requestId === requestId) {
      this.#pendingHandoff = undefined;
    }
  }

  #captureHandoff(notification: GatewayNotification, generation: number): void {
    const handoff = this.#pendingHandoff;
    if (
      handoff === undefined ||
      handoff.sourceGeneration !== generation ||
      this.#snapshotStore.state?.snapshot.conversation.id !==
        handoff.conversationId
    ) {
      return;
    }
    if (notification.kind === "update") {
      const targetConversationId = updateConversationId(notification.update);
      if (
        targetConversationId !== undefined &&
        targetConversationId !== handoff.conversationId
      ) {
        return;
      }
    }
    if (
      notification.kind === "error" &&
      notification.error.conversationId !== undefined &&
      notification.error.conversationId !== handoff.conversationId
    ) {
      return;
    }
    handoff.enqueue(notification);
  }

  #applyGatewayUpdate(update: ChatUpdate, generation: number): void {
    this.#captureHandoff({ kind: "update", update }, generation);
    if (
      this.#disposed ||
      generation !== this.#generation ||
      this.#snapshotStore.state === null
    ) {
      return;
    }
    const state = this.#snapshotStore.latestState()!;
    this.#snapshotStore.commit(applySnapshotUpdate(state, update));
  }

  #applyGatewayError(error: ChatError, generation: number): void {
    this.#captureHandoff({ kind: "error", error }, generation);
    this.#reportError(error, generation);
  }

  #reportError(error: ChatError, generation: number): void {
    if (
      this.#disposed ||
      generation !== this.#generation ||
      this.#snapshotStore.state === null ||
      (error.conversationId !== undefined &&
        error.conversationId !==
          this.#snapshotStore.state.snapshot.conversation.id)
    ) {
      return;
    }
    const state = this.#snapshotStore.latestState()!;
    this.#snapshotStore.commit(applySnapshotError(state, error));
  }

  #reportUnhandledError(failure: ChatClientUnhandledError): void {
    try {
      this.#onUnhandledError?.(Object.freeze(failure));
    } catch {
      // A diagnostic hook must not interfere with Runtime state transitions.
    }
  }

  #runSubscriptionCleanup(
    cleanup: () => unknown,
    conversationId: string,
  ): Promise<void> {
    return runCleanup(cleanup, (cause) => {
      this.#reportUnhandledError({
        cause,
        conversationId,
        source: "subscription-cleanup",
      });
    });
  }
}

export const createChatClient = (options: ChatClientOptions): ChatClient =>
  new ChatClient(options);
