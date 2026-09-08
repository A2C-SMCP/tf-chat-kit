import {
  answerInteractionInputSchema,
  createConversationInputSchema,
  createGatewayDeadlineExceededError,
  deleteConversationInputSchema,
  getAskUserInteractionAnswerValidationError,
  isGatewayDeadlineExceeded,
  isChatLifecycleOperable,
  isGatewayOperationSupported,
  listConversationsInputSchema,
  renameConversationInputSchema,
  sendMessageInputSchema,
  type AnswerInteractionInput,
  type AnswerInteractionSuccess,
  type ChatError,
  type ChatErrorSource,
  type ChatGateway,
  type ChatSnapshot,
  type ChatUpdate,
  type Conversation,
  type ConversationPage,
  type CreateConversationInput,
  type DeleteConversationInput,
  type DeleteConversationSuccess,
  type GatewayRequestOptions,
  type GatewayResult,
  type GatewaySubscription,
  type InterruptRunInput,
  type InterruptRunSuccess,
  type ListConversationsInput,
  type LoadConversationInput,
  type RenameConversationInput,
  type SendTextInput,
  type SendTextSuccess,
  type SendMessageInput,
  type SendMessageSuccess,
} from "@turingfocus/chat-protocol";

import {
  createGatewayNotificationQueue,
  type GatewayNotification,
  type GatewayNotificationQueue,
} from "./gateway-notification-queue.js";
import { cloneImmutable, deepEqual } from "./immutable.js";
import {
  applySnapshotUpdate,
  applyRuntimeSnapshotError,
  createSnapshotState,
  rebaseSnapshotState,
  type SnapshotState,
  updateConversationId,
  updateSnapshotState,
} from "./snapshot-state.js";
import {
  SnapshotStore,
  type SnapshotListener,
  type SnapshotStateListener,
  type SnapshotSubscription,
} from "./snapshot-store.js";
import { mergeHistoryTimeline } from "./timeline.js";
import {
  areComposerLongTextsValid,
  emptyComposerDraft,
  rebaseComposerLongTexts,
  resolveComposerDraftText,
  type ComposerDraft,
  type ComposerDraftListener,
  type SetComposerDraftInput,
} from "./composer-draft.js";

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
export type ChatSnapshotStateListener = SnapshotStateListener;
export type ChatClientSubscription = SnapshotSubscription;

interface PendingHandoff {
  readonly baseline: SnapshotState;
  readonly conversationId: string;
  readonly enqueue: GatewayNotificationQueue["enqueue"];
  readonly requestId: number;
  readonly sourceGeneration: number;
}

interface StructuredGatewayErrorMarker {
  readonly error: ChatError;
  readonly generation: number;
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

interface InteractionIdentity {
  readonly requestId: string;
  readonly revision: string;
}

const MAX_RETIRED_INTERACTION_IDENTITIES = 256;

const interactionIdentityKey = ({
  requestId,
  revision,
}: InteractionIdentity): string =>
  `${requestId.length}:${requestId}:${revision.length}:${revision}`;

const interactionAnswerInFlightKey = (
  conversationEpoch: number,
  conversationId: string,
  identity: InteractionIdentity,
): string =>
  `${conversationEpoch}:${conversationId.length}:${conversationId}:${interactionIdentityKey(identity)}`;

const hasSameInteractionIdentity = (
  left: InteractionIdentity | undefined,
  right: InteractionIdentity | undefined,
): boolean => {
  if (left === undefined || right === undefined) return left === right;
  return left.requestId === right.requestId && left.revision === right.revision;
};

const retiredInteractionError = (conversationId: string): ChatError =>
  cloneImmutable({
    code: "conflict",
    conversationId,
    message: "A retired interaction revision cannot become pending again",
    retryable: false,
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
  #errorSequence = 0;
  #conversationEpoch = 0;
  #generation = 0;
  #gatewaySubscription: GatewaySubscription | undefined;
  readonly #interactionAnswersInFlight = new Set<string>();
  readonly #composerDrafts = new Map<string, ComposerDraft>();
  readonly #composerListeners = new Set<ComposerDraftListener>();
  readonly #composerSendsInFlight = new Map<
    string,
    Promise<GatewayResult<SendMessageSuccess>>
  >();
  readonly #messageSendsInFlight = new Map<
    string,
    Promise<GatewayResult<SendMessageSuccess>>
  >();
  readonly #retiredInteractionIdentities = new Set<string>();
  readonly #supersededInteractionAnswers = new Set<string>();
  #historyRequestId = 0;
  #loadRequestId = 0;
  #structuredGatewayErrorMarker: StructuredGatewayErrorMarker | undefined;
  #pendingLoadConversationId: string | undefined;
  #pendingLoadConversationOverride: Conversation | undefined;
  #pendingLoadRequestId: number | undefined;
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

  /** Subscribes to active snapshot state, including `null` after deletion. */
  subscribeState(listener: ChatSnapshotStateListener): ChatClientSubscription {
    return this.#snapshotStore.subscribeState(listener);
  }

  getComposerDraft(conversationId: string): ComposerDraft {
    const existing = this.#composerDrafts.get(conversationId);
    if (existing !== undefined) return existing;
    const empty = emptyComposerDraft(conversationId);
    if (!this.#disposed) this.#composerDrafts.set(conversationId, empty);
    return empty;
  }

  setComposerDraft(input: SetComposerDraftInput): ComposerDraft {
    if (this.#disposed) return this.getComposerDraft(input.conversationId);
    const current = this.getComposerDraft(input.conversationId);
    const nextText = input.text ?? current.text;
    const nextLongTexts =
      input.longTexts ??
      rebaseComposerLongTexts(current.text, nextText, current.longTexts);
    if (!areComposerLongTextsValid(nextText, nextLongTexts)) {
      throw new TypeError("Composer long-text anchors are invalid");
    }
    const next = cloneImmutable({
      conversationId: input.conversationId,
      text: nextText,
      attachments: input.attachments ?? current.attachments,
      longTexts: nextLongTexts,
      revision: current.revision + 1,
    });
    this.#composerDrafts.set(input.conversationId, next);
    for (const listener of this.#composerListeners) {
      try {
        listener(next);
      } catch (cause) {
        this.#reportUnhandledError({ cause, source: "listener" });
      }
    }
    return next;
  }

  subscribeComposerDraft(
    listener: ComposerDraftListener,
  ): ChatClientSubscription {
    if (this.#disposed) return { closed: true, dispose: () => undefined };
    this.#composerListeners.add(listener);
    let active = true;
    return {
      get closed() {
        return !active;
      },
      dispose: () => {
        if (!active) return;
        active = false;
        this.#composerListeners.delete(listener);
      },
    };
  }

  async sendComposerDraft(
    input: GatewayRequestOptions & {
      readonly conversationId: string;
      readonly clientMessageId?: string | undefined;
    },
  ): Promise<GatewayResult<SendMessageSuccess>> {
    const inFlightKey =
      input.clientMessageId === undefined
        ? undefined
        : `${input.conversationId.length}:${input.conversationId}:${input.clientMessageId}`;
    if (inFlightKey !== undefined) {
      const existing = this.#composerSendsInFlight.get(inFlightKey);
      if (existing !== undefined) return existing;
    }
    const draft = this.getComposerDraft(input.conversationId);
    const operation = (async (): Promise<GatewayResult<SendMessageSuccess>> => {
      const result = await this.sendMessage({
        conversationId: input.conversationId,
        deadlineAt: input.deadlineAt,
        text: resolveComposerDraftText(draft),
        attachments: draft.attachments,
        ...(input.clientMessageId === undefined
          ? {}
          : { clientMessageId: input.clientMessageId }),
      });
      if (result.ok && this.getComposerDraft(input.conversationId) === draft) {
        this.setComposerDraft({
          conversationId: input.conversationId,
          text: "",
          attachments: [],
          longTexts: [],
        });
      }
      return result;
    })();
    if (inFlightKey !== undefined) {
      this.#composerSendsInFlight.set(inFlightKey, operation);
      const clearInFlight = (): void => {
        if (this.#composerSendsInFlight.get(inFlightKey) === operation) {
          this.#composerSendsInFlight.delete(inFlightKey);
        }
      };
      void operation.then(clearInFlight, clearInFlight);
    }
    return operation;
  }

  /**
   * Retires the current top-level conversation load without changing an
   * already committed snapshot. Once a snapshot commits, this is a no-op and
   * that load completes successfully while transport cleanup settles.
   */
  cancelPendingConversationLoad(): void {
    if (this.#disposed || this.#pendingLoadRequestId === undefined) return;
    this.#loadRequestId += 1;
    this.#pendingLoadConversationId = undefined;
    this.#pendingLoadConversationOverride = undefined;
    this.#pendingLoadRequestId = undefined;
    this.#pendingHandoff = undefined;
  }

  async listConversations(
    input: ListConversationsInput,
  ): Promise<GatewayResult<ConversationPage>> {
    const parsed = listConversationsInputSchema.safeParse(input);
    if (!parsed.success) {
      return runtimeFailure("validation", "Conversation list input is invalid");
    }
    if (this.#disposed) {
      return runtimeFailure("conflict", "ChatClient has already been disposed");
    }
    if (isGatewayDeadlineExceeded(parsed.data)) {
      return { ok: false, error: createGatewayDeadlineExceededError() };
    }

    const result = await this.#gateway.listConversations(parsed.data);
    return this.#disposed
      ? runtimeFailure("conflict", "Conversation listing was superseded")
      : result;
  }

  async createConversation(
    input: CreateConversationInput,
  ): Promise<GatewayResult<Conversation>> {
    const parsed = createConversationInputSchema.safeParse(input);
    if (!parsed.success) {
      return runtimeFailure(
        "validation",
        "Conversation creation input is invalid",
      );
    }
    if (this.#disposed) {
      return runtimeFailure("conflict", "ChatClient has already been disposed");
    }
    if (isGatewayDeadlineExceeded(parsed.data)) {
      return { ok: false, error: createGatewayDeadlineExceededError() };
    }
    if (this.#gateway.createConversation === undefined) {
      return runtimeFailure(
        "unsupported",
        "Conversation creation is unavailable",
      );
    }

    const result = await this.#gateway.createConversation(parsed.data);
    return this.#disposed
      ? runtimeFailure("conflict", "Conversation creation was superseded")
      : result;
  }

  async renameConversation(
    input: RenameConversationInput,
  ): Promise<GatewayResult<Conversation>> {
    const parsed = renameConversationInputSchema.safeParse(input);
    if (!parsed.success) {
      return runtimeFailure(
        "validation",
        "Conversation rename input is invalid",
      );
    }
    if (this.#disposed) {
      return runtimeFailure("conflict", "ChatClient has already been disposed");
    }
    if (isGatewayDeadlineExceeded(parsed.data)) {
      return {
        ok: false,
        error: createGatewayDeadlineExceededError(parsed.data.conversationId),
      };
    }
    if (this.#gateway.renameConversation === undefined) {
      return runtimeFailure(
        "unsupported",
        "Conversation rename is unavailable",
        parsed.data.conversationId,
      );
    }

    const result = await this.#gateway.renameConversation(parsed.data);
    if (this.#disposed) {
      return runtimeFailure(
        "conflict",
        "Conversation rename was superseded",
        parsed.data.conversationId,
      );
    }
    if (!result.ok) return result;
    if (result.value.id !== parsed.data.conversationId) {
      return runtimeFailure(
        "validation",
        "Gateway renamed a different conversation",
        parsed.data.conversationId,
      );
    }
    if (this.#pendingLoadConversationId === result.value.id) {
      this.#pendingLoadConversationOverride = cloneImmutable(result.value);
    }
    const current = this.#snapshotStore.latestState();
    if (current?.snapshot.conversation.id === result.value.id) {
      this.#snapshotStore.commit(
        updateSnapshotState(current, {
          conversation: cloneImmutable(result.value),
        }),
      );
    }
    return result;
  }

  async deleteConversation(
    input: DeleteConversationInput,
  ): Promise<GatewayResult<DeleteConversationSuccess>> {
    const parsed = deleteConversationInputSchema.safeParse(input);
    if (!parsed.success) {
      return runtimeFailure(
        "validation",
        "Conversation deletion input is invalid",
      );
    }
    if (this.#disposed) {
      return runtimeFailure("conflict", "ChatClient has already been disposed");
    }
    if (isGatewayDeadlineExceeded(parsed.data)) {
      return {
        ok: false,
        error: createGatewayDeadlineExceededError(parsed.data.conversationId),
      };
    }
    if (this.#gateway.deleteConversation === undefined) {
      return runtimeFailure(
        "unsupported",
        "Conversation deletion is unavailable",
        parsed.data.conversationId,
      );
    }

    const result = await this.#gateway.deleteConversation(parsed.data);
    if (this.#disposed) {
      return runtimeFailure(
        "conflict",
        "Conversation deletion was superseded",
        parsed.data.conversationId,
      );
    }
    if (
      result.ok &&
      result.value.deletedConversationId !== parsed.data.conversationId
    ) {
      return runtimeFailure(
        "validation",
        "Gateway deleted a different conversation",
        parsed.data.conversationId,
      );
    }
    if (result.ok) {
      this.#composerDrafts.delete(parsed.data.conversationId);
      const sendKeyPrefix = `${parsed.data.conversationId.length}:${parsed.data.conversationId}:`;
      for (const key of this.#composerSendsInFlight.keys()) {
        if (key.startsWith(sendKeyPrefix))
          this.#composerSendsInFlight.delete(key);
      }
      for (const key of this.#messageSendsInFlight.keys()) {
        if (key.startsWith(sendKeyPrefix))
          this.#messageSendsInFlight.delete(key);
      }
    }
    if (
      result.ok &&
      this.#pendingLoadConversationId === parsed.data.conversationId
    ) {
      this.#loadRequestId += 1;
      this.#pendingLoadConversationId = undefined;
      this.#pendingLoadConversationOverride = undefined;
      this.#pendingLoadRequestId = undefined;
      this.#pendingHandoff = undefined;
    }
    if (
      result.ok &&
      this.#snapshotStore.state?.snapshot.conversation.id ===
        parsed.data.conversationId
    ) {
      const subscription = this.#gatewaySubscription;
      this.#gatewaySubscription = undefined;
      this.#conversationEpoch += 1;
      this.#generation += 1;
      this.#historyRequestId += 1;
      this.#loadRequestId += 1;
      this.#pendingLoadConversationId = undefined;
      this.#pendingLoadConversationOverride = undefined;
      this.#pendingLoadRequestId = undefined;
      this.#pendingHandoff = undefined;
      this.#structuredGatewayErrorMarker = undefined;
      this.#interactionAnswersInFlight.clear();
      this.#retiredInteractionIdentities.clear();
      this.#supersededInteractionAnswers.clear();
      this.#snapshotStore.clear();
      await this.#runSubscriptionCleanup(
        () => subscription?.dispose(parsed.data),
        parsed.data.conversationId,
      );
    }
    return result;
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
    this.#pendingLoadConversationId = input.conversationId;
    this.#pendingLoadConversationOverride = undefined;
    this.#pendingLoadRequestId = requestId;

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
      this.#clearPendingLoad(requestId);
      await this.#discardGatewaySubscription(subscribed, input);
      return runtimeFailure(
        "conflict",
        "Conversation load was superseded",
        input.conversationId,
      );
    }

    const loaded = await this.#gateway.loadConversation(input);
    if (!loaded.ok) {
      this.#clearPendingLoad(requestId);
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
      this.#clearPendingLoad(requestId);
      await this.#discardGatewaySubscription(subscribed, input);
      return runtimeFailure(
        "conflict",
        "Conversation load was superseded",
        input.conversationId,
      );
    }
    if (loaded.value.conversation.id !== input.conversationId) {
      this.#clearPendingLoad(requestId);
      await this.#discardGatewaySubscription(subscribed, input);
      return runtimeFailure(
        "validation",
        "Gateway returned a snapshot for a different conversation",
        input.conversationId,
      );
    }
    if (loaded.value.capabilities.liveUpdates && !subscribed.ok) {
      this.#clearPendingLoad(requestId);
      if (this.#disposed || requestId !== this.#loadRequestId) {
        return runtimeFailure(
          "conflict",
          "Conversation load was superseded",
          input.conversationId,
        );
      }
      return subscribed;
    }
    let subscriptionDiscarded = false;
    if (!loaded.value.capabilities.liveUpdates) {
      await this.#discardGatewaySubscription(subscribed, input);
      subscriptionDiscarded = true;
    }
    if (this.#disposed || requestId !== this.#loadRequestId) {
      this.#clearPendingLoad(requestId);
      if (!subscriptionDiscarded) {
        await this.#discardGatewaySubscription(subscribed, input);
      }
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
    const conversationOverride =
      this.#pendingLoadRequestId === requestId &&
      this.#pendingLoadConversationId === input.conversationId
        ? this.#pendingLoadConversationOverride
        : undefined;
    const loadedState = createSnapshotState(
      conversationOverride === undefined
        ? loaded.value
        : { ...loaded.value, conversation: conversationOverride },
    );
    const currentState = this.#snapshotStore.state;
    const handoff = this.#pendingHandoff;
    let nextState =
      handoff?.requestId === requestId && currentState !== null
        ? rebaseSnapshotState(handoff.baseline, loadedState, currentState)
        : loadedState;
    if (
      currentState?.snapshot.conversation.id !==
      nextState.snapshot.conversation.id
    ) {
      this.#conversationEpoch += 1;
      this.#retiredInteractionIdentities.clear();
    } else if (currentState !== null) {
      nextState = this.#guardInteractionTransition(currentState, nextState);
    }
    this.#clearPendingLoad(requestId);
    this.#snapshotStore.commit(nextState);
    if (!this.#disposed) notificationQueue.activate(generation);
    const committedSnapshot =
      this.#snapshotStore.state?.snapshot ?? nextState.snapshot;
    await this.#runSubscriptionCleanup(
      () => previousSubscription?.dispose(input),
      input.conversationId,
    );
    return { ok: true, value: committedSnapshot };
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
    if (!result.ok) this.#reportError(result.error, generation, "command");
    return result;
  }

  async sendMessage(
    input: SendMessageInput,
  ): Promise<GatewayResult<SendMessageSuccess>> {
    const parsed = sendMessageInputSchema.safeParse(input);
    if (!parsed.success) {
      return runtimeFailure(
        "validation",
        "Message input is invalid",
        typeof input.conversationId === "string"
          ? input.conversationId
          : undefined,
      );
    }
    const command = parsed.data;
    const attachments = command.attachments ?? [];
    if (attachments.length === 0) {
      return this.sendText({
        conversationId: command.conversationId,
        deadlineAt: command.deadlineAt,
        text: command.text ?? "",
        ...(command.clientMessageId === undefined
          ? {}
          : { clientMessageId: command.clientMessageId }),
      });
    }

    const state = this.#activeState(command.conversationId);
    if (!state.ok) return state;
    if (
      !isGatewayOperationSupported(
        state.value.capabilities,
        "sendAttachments",
      ) ||
      this.#gateway.sendMessage === undefined
    ) {
      return runtimeFailure(
        "unsupported",
        "Attachment sending is unavailable",
        command.conversationId,
      );
    }

    const inFlightKey =
      command.clientMessageId === undefined
        ? undefined
        : `${command.conversationId.length}:${command.conversationId}:${command.clientMessageId}`;
    if (inFlightKey !== undefined) {
      const existing = this.#messageSendsInFlight.get(inFlightKey);
      if (existing !== undefined) return existing;
    }
    const generation = this.#generation;
    const operation = (async (): Promise<GatewayResult<SendMessageSuccess>> => {
      const result = await this.#gateway.sendMessage!(command);
      if (!result.ok && !this.#disposed)
        this.#reportError(result.error, generation, "command");
      return result;
    })();
    if (inFlightKey !== undefined) {
      this.#messageSendsInFlight.set(inFlightKey, operation);
      const clearInFlight = (): void => {
        if (this.#messageSendsInFlight.get(inFlightKey) === operation) {
          this.#messageSendsInFlight.delete(inFlightKey);
        }
      };
      void operation.then(clearInFlight, clearInFlight);
    }
    return operation;
  }

  async answerInteraction(
    input: AnswerInteractionInput,
  ): Promise<GatewayResult<AnswerInteractionSuccess>> {
    const parsed = answerInteractionInputSchema.safeParse(input);
    if (!parsed.success) {
      return runtimeFailure(
        "validation",
        "Interaction answer input is invalid",
        typeof input.conversationId === "string"
          ? input.conversationId
          : undefined,
      );
    }
    const command = parsed.data;
    const state = this.#activeState(command.conversationId);
    if (!state.ok) return state;
    const pending = state.value.pendingInteraction;
    if (
      pending === undefined ||
      pending.requestId !== command.answer.requestId ||
      pending.revision !== command.answer.revision
    ) {
      return runtimeFailure(
        "conflict",
        "Interaction request is no longer pending",
        command.conversationId,
      );
    }
    const conversationEpoch = this.#conversationEpoch;
    const inFlightKey = interactionAnswerInFlightKey(
      conversationEpoch,
      command.conversationId,
      command.answer,
    );
    if (this.#interactionAnswersInFlight.has(inFlightKey)) {
      return runtimeFailure(
        "conflict",
        "Interaction request is already being answered",
        command.conversationId,
      );
    }
    if (
      !isGatewayOperationSupported(
        state.value.capabilities,
        "answerInteraction",
      ) ||
      this.#gateway.answerInteraction === undefined
    ) {
      return runtimeFailure(
        "unsupported",
        "Interaction answers are unavailable",
        command.conversationId,
      );
    }
    if (
      getAskUserInteractionAnswerValidationError(pending, command.answer) !==
      undefined
    ) {
      return runtimeFailure(
        "validation",
        "Interaction answers do not match the pending questions",
        command.conversationId,
      );
    }
    this.#interactionAnswersInFlight.add(inFlightKey);
    try {
      const result = await this.#gateway.answerInteraction(command);
      const current = this.#snapshotStore.state?.snapshot;
      const sameActiveConversation =
        !this.#disposed &&
        conversationEpoch === this.#conversationEpoch &&
        current?.conversation.id === command.conversationId;
      if (!sameActiveConversation) {
        return runtimeFailure(
          "conflict",
          "Interaction answer was superseded",
          command.conversationId,
        );
      }
      if (this.#supersededInteractionAnswers.has(inFlightKey)) {
        return runtimeFailure(
          "conflict",
          "Interaction answer was superseded",
          command.conversationId,
        );
      }
      const currentPending = current.pendingInteraction;
      if (
        currentPending !== undefined &&
        !hasSameInteractionIdentity(currentPending, pending)
      ) {
        return runtimeFailure(
          "conflict",
          "Interaction answer was superseded",
          command.conversationId,
        );
      }
      if (!result.ok) {
        if (hasSameInteractionIdentity(currentPending, pending)) {
          this.#reportError(result.error, this.#generation, "command");
        }
        return result;
      }
      if (
        result.value.requestId !== command.answer.requestId ||
        result.value.revision !== command.answer.revision
      ) {
        return runtimeFailure(
          "validation",
          "Gateway acknowledged a different interaction request",
          command.conversationId,
        );
      }
      const latest = this.#snapshotStore.latestState();
      if (
        latest !== null &&
        hasSameInteractionIdentity(latest.snapshot.pendingInteraction, pending)
      ) {
        this.#snapshotStore.commit(
          this.#guardInteractionTransition(
            latest,
            updateSnapshotState(latest, { pendingInteraction: undefined }),
          ),
        );
      }
      return result;
    } finally {
      this.#interactionAnswersInFlight.delete(inFlightKey);
      this.#supersededInteractionAnswers.delete(inFlightKey);
    }
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
      this.#reportError(result.error, generation, "command");
    }
    return result;
  }

  dispose(options: GatewayRequestOptions): Promise<void> {
    if (this.#disposePromise !== undefined) return this.#disposePromise;

    this.#disposed = true;
    this.#conversationEpoch += 1;
    this.#generation += 1;
    this.#historyRequestId += 1;
    this.#interactionAnswersInFlight.clear();
    this.#retiredInteractionIdentities.clear();
    this.#supersededInteractionAnswers.clear();
    this.#composerSendsInFlight.clear();
    this.#messageSendsInFlight.clear();
    this.#composerDrafts.clear();
    this.#composerListeners.clear();
    this.#loadRequestId += 1;
    this.#pendingLoadConversationId = undefined;
    this.#pendingLoadConversationOverride = undefined;
    this.#pendingLoadRequestId = undefined;
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
      this.#reportError(loaded.error, generation, "command");
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
    const lifecycle = this.#snapshotStore.state.snapshot.lifecycle;
    if (lifecycle !== undefined && !isChatLifecycleOperable(lifecycle)) {
      return runtimeFailure(
        lifecycle.status === "auth-required"
          ? "authentication"
          : lifecycle.status === "subscription-failed"
            ? "network"
            : "conflict",
        `Conversation is not operable while lifecycle is ${lifecycle.status}`,
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

  #clearPendingLoad(requestId: number): void {
    if (this.#pendingLoadRequestId === requestId) {
      this.#pendingLoadConversationId = undefined;
      this.#pendingLoadConversationOverride = undefined;
      this.#pendingLoadRequestId = undefined;
    }
    if (this.#pendingHandoff?.requestId === requestId) {
      this.#pendingHandoff = undefined;
    }
  }

  #captureHandoff(notification: GatewayNotification, generation: number): void {
    const handoff = this.#pendingHandoff;
    const state = this.#snapshotStore.state;
    if (
      handoff === undefined ||
      handoff.sourceGeneration !== generation ||
      state?.snapshot.conversation.id !== handoff.conversationId
    ) {
      return;
    }
    if (notification.kind === "update") {
      if (
        notification.update.kind === "lifecycle.changed" ||
        (notification.update.kind === "error.reported" &&
          notification.update.scope?.kind === "subscription")
      ) {
        return;
      }
      if (notification.update.kind === "error.resolved") {
        const errorId = notification.update.errorId;
        const occurrence = state.snapshot.activeErrors?.find(
          ({ id }) => id === errorId,
        );
        if (occurrence?.scope.kind === "subscription") return;
      }
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
      notification.error.conversationId !== undefined
    ) {
      return;
    }
    handoff.enqueue(notification);
  }

  #applyGatewayUpdate(update: ChatUpdate, generation: number): void {
    if (
      update.kind === "error.reported" &&
      update.errorId !== undefined &&
      update.source !== undefined &&
      update.scope !== undefined &&
      update.generation !== undefined
    ) {
      const marker = { error: update.error, generation };
      this.#structuredGatewayErrorMarker = marker;
      void Promise.resolve().then(() => {
        if (this.#structuredGatewayErrorMarker === marker) {
          this.#structuredGatewayErrorMarker = undefined;
        }
      });
    } else {
      this.#structuredGatewayErrorMarker = undefined;
    }
    this.#captureHandoff({ kind: "update", update }, generation);
    if (
      this.#disposed ||
      generation !== this.#generation ||
      this.#snapshotStore.state === null
    ) {
      return;
    }
    const state = this.#snapshotStore.latestState()!;
    this.#snapshotStore.commit(
      this.#guardInteractionTransition(
        state,
        applySnapshotUpdate(state, update),
      ),
    );
  }

  #guardInteractionTransition(
    current: SnapshotState,
    candidate: SnapshotState,
  ): SnapshotState {
    const currentInteraction = current.snapshot.pendingInteraction;
    const candidateInteraction = candidate.snapshot.pendingInteraction;
    if (
      candidateInteraction !== undefined &&
      !hasSameInteractionIdentity(currentInteraction, candidateInteraction) &&
      this.#retiredInteractionIdentities.has(
        interactionIdentityKey(candidateInteraction),
      )
    ) {
      const guarded = updateSnapshotState(candidate, {
        pendingInteraction: currentInteraction,
      });
      return applyRuntimeSnapshotError(
        guarded,
        retiredInteractionError(current.snapshot.conversation.id),
        `runtime:retired-interaction:${candidateInteraction.requestId}:${candidateInteraction.revision}`,
      );
    }
    if (
      currentInteraction !== undefined &&
      !hasSameInteractionIdentity(currentInteraction, candidateInteraction)
    ) {
      if (candidateInteraction !== undefined) {
        const inFlightKey = interactionAnswerInFlightKey(
          this.#conversationEpoch,
          current.snapshot.conversation.id,
          currentInteraction,
        );
        if (this.#interactionAnswersInFlight.has(inFlightKey)) {
          this.#supersededInteractionAnswers.add(inFlightKey);
        }
      }
      this.#retireInteractionIdentity(currentInteraction);
    }
    return candidate;
  }

  #retireInteractionIdentity(identity: InteractionIdentity): void {
    const key = interactionIdentityKey(identity);
    this.#retiredInteractionIdentities.delete(key);
    this.#retiredInteractionIdentities.add(key);
    while (
      this.#retiredInteractionIdentities.size >
      MAX_RETIRED_INTERACTION_IDENTITIES
    ) {
      const oldest = this.#retiredInteractionIdentities.values().next().value;
      if (oldest === undefined) return;
      this.#retiredInteractionIdentities.delete(oldest);
    }
  }

  #applyGatewayError(error: ChatError, generation: number): void {
    const marker = this.#structuredGatewayErrorMarker;
    this.#structuredGatewayErrorMarker = undefined;
    if (marker?.generation === generation && deepEqual(marker.error, error)) {
      return;
    }
    this.#captureHandoff({ kind: "error", error }, generation);
    this.#reportError(error, generation);
  }

  #reportError(
    error: ChatError,
    generation: number,
    source: ChatErrorSource = "runtime",
  ): void {
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
    const immutableError = cloneImmutable(error);
    const errorId = `runtime:${generation}:error:${++this.#errorSequence}`;
    const existingOccurrences =
      state.snapshot.activeErrors ??
      (state.snapshot.error === undefined
        ? []
        : [
            cloneImmutable({
              id: "runtime:legacy-snapshot",
              error: state.snapshot.error,
              source: "runtime" as const,
              scope: {
                kind: "conversation" as const,
                id: state.snapshot.conversation.id,
              },
              generation: state.snapshot.lifecycle?.generation ?? 0,
            }),
          ]);
    const occurrence = cloneImmutable({
      id: errorId,
      error: immutableError,
      source,
      scope:
        source === "command"
          ? { kind: "command" as const, id: errorId }
          : immutableError.conversationId === undefined
            ? { kind: "global" as const }
            : {
                kind: "conversation" as const,
                id: immutableError.conversationId,
              },
      generation,
    });
    this.#snapshotStore.commit(
      updateSnapshotState(state, {
        activeErrors: Object.freeze([...existingOccurrences, occurrence]),
        error: occurrence.error,
      }),
    );
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
