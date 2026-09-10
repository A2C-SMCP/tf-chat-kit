import type {
  ChatError,
  ChatSnapshot,
  Conversation,
  ConversationPage,
  GatewayResult,
} from "@turingfocus/chat-protocol";

import type { ChatClient } from "./chat-client.js";
import { cloneImmutable, deepEqual } from "./immutable.js";

export type ConversationWorkspaceListStatus =
  "error" | "idle" | "loading" | "loading-more" | "ready";

export type ConversationWorkspaceSelectionStatus =
  "empty" | "error" | "idle" | "loading" | "ready";

export interface ConversationWorkspaceSnapshot {
  readonly conversations: readonly Conversation[];
  readonly creating: boolean;
  readonly creationError?: ChatError | undefined;
  readonly deletingConversationIds: readonly string[];
  readonly renamingConversationIds: readonly string[];
  readonly conversationMutationError?: ChatError | undefined;
  readonly listError?: ChatError | undefined;
  readonly listStatus: ConversationWorkspaceListStatus;
  readonly nextCursor?: string | undefined;
  readonly pendingConversationId?: string | undefined;
  readonly selectedConversationId?: string | undefined;
  readonly selectionError?: ChatError | undefined;
  readonly selectionStatus: ConversationWorkspaceSelectionStatus;
}

export interface ConversationWorkspaceSubscription {
  readonly closed: boolean;
  dispose(): void;
}

export interface ConversationWorkspaceControllerOptions {
  readonly client: ChatClient;
  /** Supplies a fresh absolute Unix-epoch deadline for every command. */
  readonly getDeadlineAt: () => number;
  /** Defaults to selecting the first conversation after the initial list load. */
  readonly initialSelection?: "first" | "none" | undefined;
  readonly onUnhandledError?: ((error: unknown) => void) | undefined;
  /** Optional host policy applied after page merging. Gateway order is the default. */
  readonly orderConversations?:
    | ((conversations: readonly Conversation[]) => readonly Conversation[])
    | undefined;
  readonly pageSize?: number | undefined;
}

export interface CreateWorkspaceConversationInput {
  /** Defaults to true. A later user selection always wins over auto-selection. */
  readonly select?: boolean | undefined;
  readonly title: string;
}

export interface RenameWorkspaceConversationInput {
  readonly conversationId: string;
  readonly title: string;
}

interface ListenerRegistration {
  active: boolean;
  readonly listener: (snapshot: ConversationWorkspaceSnapshot) => void;
}

interface AppliedConversationPage {
  readonly applied: boolean;
  readonly revision: number;
  readonly result: GatewayResult<ConversationPage>;
}

const INITIAL_SNAPSHOT: ConversationWorkspaceSnapshot = cloneImmutable({
  conversations: [],
  creating: false,
  deletingConversationIds: [],
  listStatus: "idle",
  renamingConversationIds: [],
  selectionStatus: "idle",
});

const controllerFailure = (
  message: string,
  conversationId?: string,
): GatewayResult<never> => ({
  ok: false,
  error: cloneImmutable({
    code: "conflict",
    message,
    retryable: false,
    ...(conversationId === undefined ? {} : { conversationId }),
  }),
});

const callbackFailure = (
  message: string,
  conversationId?: string,
): GatewayResult<never> => ({
  ok: false,
  error: cloneImmutable({
    code: "unknown",
    message,
    retryable: false,
    ...(conversationId === undefined ? {} : { conversationId }),
  }),
});

const deduplicateConversations = (
  conversations: readonly Conversation[],
): readonly Conversation[] => {
  const seen = new Set<string>();
  return conversations.filter((conversation) => {
    if (seen.has(conversation.id)) return false;
    seen.add(conversation.id);
    return true;
  });
};

export const orderConversationsByUpdatedAt = (
  conversations: readonly Conversation[],
): readonly Conversation[] =>
  conversations
    .map((conversation, index) => ({ conversation, index }))
    .sort((left, right) => {
      const leftUpdatedAt = left.conversation.updatedAt;
      const rightUpdatedAt = right.conversation.updatedAt;
      if (leftUpdatedAt === undefined && rightUpdatedAt === undefined) {
        return left.index - right.index;
      }
      if (leftUpdatedAt === undefined) return 1;
      if (rightUpdatedAt === undefined) return -1;
      return rightUpdatedAt - leftUpdatedAt || left.index - right.index;
    })
    .map(({ conversation }) => conversation);

/**
 * Headless, instance-scoped owner of conversation-list and selection workflow.
 * It never owns or disposes the injected ChatClient.
 */
export class ConversationWorkspaceController {
  #automaticSelectionRevision: number | undefined;
  readonly #client: ChatClient;
  readonly #clientSubscription: ConversationWorkspaceSubscription;
  #createInFlight = 0;
  #createRevision = 0;
  readonly #deletingConversationIds = new Set<string>();
  #disposed = false;
  readonly #getDeadlineAt: () => number;
  readonly #initialSelection: "first" | "none";
  #listRevision = 0;
  readonly #listeners = new Set<ListenerRegistration>();
  readonly #onUnhandledError: ((error: unknown) => void) | undefined;
  readonly #orderConversations:
    | ((conversations: readonly Conversation[]) => readonly Conversation[])
    | undefined;
  readonly #pageSize: number | undefined;
  readonly #renamingConversationIds = new Set<string>();
  #selectionIntentRevision = 0;
  #selectionRevision = 0;
  #snapshot: ConversationWorkspaceSnapshot = INITIAL_SNAPSHOT;

  constructor(options: ConversationWorkspaceControllerOptions) {
    this.#client = options.client;
    this.#getDeadlineAt = options.getDeadlineAt;
    this.#initialSelection = options.initialSelection ?? "first";
    this.#onUnhandledError = options.onUnhandledError;
    this.#orderConversations = options.orderConversations;
    this.#pageSize = options.pageSize;
    this.#clientSubscription = this.#client.subscribeState((snapshot) => {
      if (snapshot === null) this.#handleClientSnapshotCleared();
      else this.#handleClientSnapshot(snapshot);
    });
  }

  get disposed(): boolean {
    return this.#disposed;
  }

  getSnapshot(): ConversationWorkspaceSnapshot {
    return this.#snapshot;
  }

  subscribe(
    listener: (snapshot: ConversationWorkspaceSnapshot) => void,
  ): ConversationWorkspaceSubscription {
    const registration: ListenerRegistration = {
      active: !this.#disposed,
      listener,
    };
    if (registration.active) {
      this.#listeners.add(registration);
      this.#callListener(registration);
    }
    return Object.freeze({
      get closed() {
        return !registration.active;
      },
      dispose: () => {
        if (!registration.active) return;
        registration.active = false;
        this.#listeners.delete(registration);
      },
    });
  }

  async start(): Promise<void> {
    await this.refresh();
  }

  async refresh(): Promise<GatewayResult<ConversationPage>> {
    const selectionIntentRevision = this.#selectionIntentRevision;
    const refreshed = await this.#refreshPage();
    if (
      !refreshed.applied ||
      !refreshed.result.ok ||
      !this.#isCurrentList(refreshed.revision) ||
      selectionIntentRevision !== this.#selectionIntentRevision
    ) {
      return refreshed.result;
    }
    const first = this.#snapshot.conversations[0];
    if (
      first === undefined &&
      this.#snapshot.selectedConversationId === undefined &&
      this.#snapshot.pendingConversationId === undefined
    ) {
      this.#commit({ ...this.#snapshot, selectionStatus: "empty" });
    } else if (
      first !== undefined &&
      this.#initialSelection === "first" &&
      this.#snapshot.selectedConversationId === undefined &&
      this.#snapshot.pendingConversationId === undefined
    ) {
      await this.#selectInitialConversation(first.id);
    } else if (
      this.#snapshot.selectedConversationId === undefined &&
      this.#snapshot.pendingConversationId === undefined
    ) {
      this.#commit({ ...this.#snapshot, selectionStatus: "empty" });
    }
    return refreshed.result;
  }

  async loadMore(): Promise<GatewayResult<ConversationPage> | undefined> {
    if (this.#disposed) {
      return controllerFailure(
        "Conversation workspace has already been disposed",
      );
    }
    const cursor = this.#snapshot.nextCursor;
    if (cursor === undefined) return undefined;
    const revision = ++this.#listRevision;
    this.#commit({
      ...this.#snapshot,
      listError: undefined,
      listStatus: "loading-more",
    });
    if (!this.#isCurrentList(revision)) {
      return controllerFailure("Conversation pagination was superseded");
    }
    const requestOptions = this.#requestOptions();
    if (!this.#isCurrentList(revision)) {
      return controllerFailure("Conversation pagination was superseded");
    }
    if (!requestOptions.ok) {
      this.#applyListFailure(requestOptions.error, revision);
      return requestOptions;
    }
    const result = await this.#client.listConversations({
      cursor,
      deadlineAt: requestOptions.value,
      ...(this.#pageSize === undefined ? {} : { limit: this.#pageSize }),
    });
    if (!this.#isCurrentList(revision)) return result;
    if (!result.ok) {
      this.#applyListFailure(result.error, revision);
      return result;
    }
    this.#commit({
      ...this.#snapshot,
      conversations: this.#ordered([
        ...this.#snapshot.conversations,
        ...result.value.conversations,
      ]),
      listError: undefined,
      listStatus: "ready",
      nextCursor: result.value.nextCursor,
    });
    return result;
  }

  async createConversation(
    input: CreateWorkspaceConversationInput,
  ): Promise<GatewayResult<Conversation>> {
    if (this.#disposed) {
      return controllerFailure(
        "Conversation workspace has already been disposed",
      );
    }
    const createRevision = ++this.#createRevision;
    const selectionIntentRevision = this.#selectionIntentRevision;
    this.#createInFlight += 1;
    this.#commit({
      ...this.#snapshot,
      creating: true,
      creationError: undefined,
    });
    if (this.#disposed) {
      this.#createInFlight -= 1;
      return controllerFailure("Conversation creation was superseded");
    }
    const requestOptions = this.#requestOptions();
    if (this.#disposed) {
      this.#createInFlight -= 1;
      return controllerFailure("Conversation creation was superseded");
    }
    const result = requestOptions.ok
      ? await this.#client.createConversation({
          deadlineAt: requestOptions.value,
          title: input.title,
        })
      : requestOptions;
    this.#createInFlight -= 1;
    if (this.#disposed) return result;
    const isLatestCreate = createRevision === this.#createRevision;
    if (!result.ok) {
      this.#commit({
        ...this.#snapshot,
        creating: this.#createInFlight > 0,
        ...(isLatestCreate ? { creationError: result.error } : {}),
      });
      return result;
    }

    this.#listRevision += 1;
    this.#commit({
      ...this.#snapshot,
      conversations: this.#ordered([
        result.value,
        ...this.#snapshot.conversations,
      ]),
      creating: this.#createInFlight > 0,
      ...(isLatestCreate ? { creationError: undefined } : {}),
      listError: undefined,
      listStatus: "ready",
    });
    if (
      input.select !== false &&
      !this.#disposed &&
      createRevision === this.#createRevision &&
      selectionIntentRevision === this.#selectionIntentRevision
    ) {
      this.#automaticSelectionRevision = undefined;
      await this.#selectConversation(
        result.value.id,
        ++this.#selectionRevision,
      );
    }
    return result;
  }

  async renameConversation(
    input: RenameWorkspaceConversationInput,
  ): Promise<GatewayResult<Conversation>> {
    if (this.#disposed) {
      return controllerFailure(
        "Conversation workspace has already been disposed",
        input.conversationId,
      );
    }
    if (
      this.#renamingConversationIds.has(input.conversationId) ||
      this.#deletingConversationIds.has(input.conversationId)
    ) {
      return controllerFailure(
        "Conversation mutation is already in progress",
        input.conversationId,
      );
    }
    this.#renamingConversationIds.add(input.conversationId);
    this.#commitMutationState(undefined);
    const requestOptions = this.#requestOptions(input.conversationId);
    const result = requestOptions.ok
      ? await this.#client.renameConversation({
          conversationId: input.conversationId,
          deadlineAt: requestOptions.value,
          title: input.title,
        })
      : requestOptions;
    this.#renamingConversationIds.delete(input.conversationId);
    if (this.#disposed) return result;
    if (!result.ok) {
      this.#commitMutationState(result.error);
      return result;
    }
    this.#listRevision += 1;
    this.#commit({
      ...this.#snapshot,
      conversations: this.#upsertConversation(result.value),
      conversationMutationError: undefined,
      listError: undefined,
      listStatus: "ready",
      renamingConversationIds: [...this.#renamingConversationIds],
    });
    return result;
  }

  async deleteConversation(
    conversationId: string,
  ): Promise<GatewayResult<{ readonly deletedConversationId: string }>> {
    if (this.#disposed) {
      return controllerFailure(
        "Conversation workspace has already been disposed",
        conversationId,
      );
    }
    if (
      this.#deletingConversationIds.has(conversationId) ||
      this.#renamingConversationIds.has(conversationId)
    ) {
      return controllerFailure(
        "Conversation mutation is already in progress",
        conversationId,
      );
    }
    this.#deletingConversationIds.add(conversationId);
    this.#commitMutationState(undefined);
    const requestOptions = this.#requestOptions(conversationId);
    const result = requestOptions.ok
      ? await this.#client.deleteConversation({
          conversationId,
          deadlineAt: requestOptions.value,
        })
      : requestOptions;
    this.#deletingConversationIds.delete(conversationId);
    if (this.#disposed) return result;
    if (!result.ok) {
      this.#commitMutationState(result.error);
      return result;
    }

    this.#listRevision += 1;
    const conversations = this.#snapshot.conversations.filter(
      (conversation) => conversation.id !== conversationId,
    );
    const deletesSelected =
      this.#snapshot.selectedConversationId === conversationId;
    const deletesPending =
      this.#snapshot.pendingConversationId === conversationId;
    if (deletesSelected || deletesPending) {
      this.#selectionIntentRevision += 1;
      this.#selectionRevision += 1;
      this.#automaticSelectionRevision = undefined;
      this.#client.cancelPendingConversationLoad();
    }
    this.#commit({
      ...this.#snapshot,
      conversations,
      conversationMutationError: undefined,
      deletingConversationIds: [...this.#deletingConversationIds],
      listError: undefined,
      listStatus: "ready",
      ...(deletesSelected
        ? {
            pendingConversationId: undefined,
            selectedConversationId: undefined,
            selectionError: undefined,
            selectionStatus:
              conversations.length === 0
                ? ("empty" as const)
                : ("idle" as const),
          }
        : deletesPending
          ? {
              pendingConversationId: undefined,
              selectionError: undefined,
              selectionStatus:
                this.#snapshot.selectedConversationId === undefined
                  ? conversations.length === 0
                    ? ("empty" as const)
                    : ("idle" as const)
                  : ("ready" as const),
            }
          : {}),
    });
    return result;
  }

  async selectConversation(
    conversationId: string,
  ): Promise<GatewayResult<ChatSnapshot>> {
    this.#automaticSelectionRevision = undefined;
    this.#selectionIntentRevision += 1;
    return this.#selectConversation(conversationId, ++this.#selectionRevision);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#listRevision += 1;
    this.#selectionIntentRevision += 1;
    this.#selectionRevision += 1;
    this.#createRevision += 1;
    if (this.#snapshot.pendingConversationId !== undefined) {
      this.#client.cancelPendingConversationLoad();
    }
    this.#clientSubscription.dispose();
    for (const registration of this.#listeners) registration.active = false;
    this.#listeners.clear();
  }

  async #refreshPage(): Promise<AppliedConversationPage> {
    if (this.#disposed) {
      return {
        applied: false,
        revision: this.#listRevision,
        result: controllerFailure(
          "Conversation workspace has already been disposed",
        ),
      };
    }
    const revision = ++this.#listRevision;
    const cancelledAutomaticSelection = this.#cancelAutomaticSelection();
    this.#commit({
      ...this.#snapshot,
      listError: undefined,
      listStatus: "loading",
      ...(cancelledAutomaticSelection
        ? {
            pendingConversationId: undefined,
            selectionError: undefined,
            selectionStatus:
              this.#snapshot.selectedConversationId === undefined
                ? ("idle" as const)
                : ("ready" as const),
          }
        : {}),
    });
    if (!this.#isCurrentList(revision)) {
      return {
        applied: false,
        revision,
        result: controllerFailure("Conversation refresh was superseded"),
      };
    }
    const requestOptions = this.#requestOptions();
    if (!this.#isCurrentList(revision)) {
      return {
        applied: false,
        revision,
        result: controllerFailure("Conversation refresh was superseded"),
      };
    }
    if (!requestOptions.ok) {
      this.#applyListFailure(requestOptions.error, revision);
      return { applied: true, revision, result: requestOptions };
    }
    const result = await this.#client.listConversations({
      deadlineAt: requestOptions.value,
      ...(this.#pageSize === undefined ? {} : { limit: this.#pageSize }),
    });
    if (!this.#isCurrentList(revision)) {
      return { applied: false, revision, result };
    }
    if (!result.ok) {
      this.#applyListFailure(result.error, revision);
      return { applied: true, revision, result };
    }

    const conversations = this.#ordered(result.value.conversations);
    this.#commit({
      ...this.#snapshot,
      conversations,
      listError: undefined,
      listStatus: "ready",
      nextCursor: result.value.nextCursor,
      ...(conversations.length === 0 &&
      this.#snapshot.selectedConversationId === undefined &&
      this.#snapshot.pendingConversationId === undefined
        ? { selectionStatus: "empty" as const }
        : {}),
    });
    return { applied: true, revision, result };
  }

  async #selectInitialConversation(conversationId: string): Promise<void> {
    const revision = ++this.#selectionRevision;
    this.#automaticSelectionRevision = revision;
    try {
      await this.#selectConversation(conversationId, revision);
    } finally {
      if (this.#automaticSelectionRevision === revision) {
        this.#automaticSelectionRevision = undefined;
      }
    }
  }

  async #selectConversation(
    conversationId: string,
    revision: number,
  ): Promise<GatewayResult<ChatSnapshot>> {
    if (this.#disposed) {
      return controllerFailure(
        "Conversation workspace has already been disposed",
        conversationId,
      );
    }
    if (revision !== this.#selectionRevision) {
      return controllerFailure(
        "Conversation selection was superseded",
        conversationId,
      );
    }
    this.#client.cancelPendingConversationLoad();
    this.#commit({
      ...this.#snapshot,
      pendingConversationId: conversationId,
      selectionError: undefined,
      selectionStatus: "loading",
    });
    if (!this.#isCurrentSelection(revision)) {
      return controllerFailure(
        "Conversation selection was superseded",
        conversationId,
      );
    }
    const requestOptions = this.#requestOptions(conversationId);
    if (!this.#isCurrentSelection(revision)) {
      return controllerFailure(
        "Conversation selection was superseded",
        conversationId,
      );
    }
    if (!requestOptions.ok) {
      this.#applySelectionFailure(requestOptions.error, revision);
      return requestOptions;
    }
    const result = await this.#client.loadConversation({
      conversationId,
      deadlineAt: requestOptions.value,
    });
    if (!this.#isCurrentSelection(revision)) return result;
    if (!result.ok) {
      this.#applySelectionFailure(result.error, revision);
      return result;
    }
    this.#commit({
      ...this.#snapshot,
      conversations: this.#upsertConversation(result.value.conversation),
      pendingConversationId: undefined,
      selectedConversationId: result.value.conversation.id,
      selectionError: undefined,
      selectionStatus: "ready",
    });
    return result;
  }

  #requestOptions(conversationId?: string): GatewayResult<number> {
    try {
      return { ok: true, value: this.#getDeadlineAt() };
    } catch (error) {
      this.#reportUnhandledError(error);
      return callbackFailure(
        "Conversation workspace deadline provider failed",
        conversationId,
      );
    }
  }

  #commitMutationState(error: ChatError | undefined): void {
    this.#commit({
      ...this.#snapshot,
      conversationMutationError: error,
      deletingConversationIds: [...this.#deletingConversationIds],
      renamingConversationIds: [...this.#renamingConversationIds],
    });
  }

  #cancelAutomaticSelection(): boolean {
    if (
      this.#automaticSelectionRevision === undefined ||
      this.#automaticSelectionRevision !== this.#selectionRevision
    ) {
      return false;
    }
    if (this.#snapshot.pendingConversationId === undefined) {
      this.#automaticSelectionRevision = undefined;
      return false;
    }
    this.#automaticSelectionRevision = undefined;
    this.#selectionRevision += 1;
    this.#client.cancelPendingConversationLoad();
    return true;
  }

  #applyListFailure(error: ChatError, revision: number): void {
    if (!this.#isCurrentList(revision)) return;
    this.#commit({
      ...this.#snapshot,
      listError: error,
      listStatus: "error",
    });
  }

  #applySelectionFailure(error: ChatError, revision: number): void {
    if (!this.#isCurrentSelection(revision)) return;
    this.#commit({
      ...this.#snapshot,
      pendingConversationId: undefined,
      selectionError: error,
      selectionStatus:
        this.#client.getCacheState().source !== "none" &&
        this.#client.getSnapshot()?.conversation.id ===
          this.#snapshot.selectedConversationId
          ? "ready"
          : "error",
    });
  }

  #upsertConversation(conversation: Conversation): readonly Conversation[] {
    const existingIndex = this.#snapshot.conversations.findIndex(
      ({ id }) => id === conversation.id,
    );
    if (existingIndex === -1) {
      return this.#ordered([conversation, ...this.#snapshot.conversations]);
    }
    return this.#ordered(
      this.#snapshot.conversations.map((item, index) =>
        index === existingIndex ? conversation : item,
      ),
    );
  }

  #ordered(conversations: readonly Conversation[]): readonly Conversation[] {
    const deduplicated = deduplicateConversations(conversations);
    if (this.#orderConversations === undefined) {
      return cloneImmutable(deduplicated);
    }
    try {
      return cloneImmutable(
        deduplicateConversations(
          this.#orderConversations(cloneImmutable(deduplicated)),
        ),
      );
    } catch (error) {
      this.#reportUnhandledError(error);
      return cloneImmutable(deduplicated);
    }
  }

  #handleClientSnapshot(snapshot: ChatSnapshot): void {
    if (
      this.#disposed ||
      (snapshot.conversation.id !== this.#snapshot.selectedConversationId &&
        snapshot.conversation.id !== this.#snapshot.pendingConversationId)
    ) {
      return;
    }
    if (snapshot.conversation.id === this.#snapshot.pendingConversationId) {
      this.#commit({
        ...this.#snapshot,
        conversations: this.#upsertConversation(snapshot.conversation),
        pendingConversationId: undefined,
        selectedConversationId: snapshot.conversation.id,
        selectionError: undefined,
        selectionStatus: "ready",
      });
      return;
    }
    this.#commit({
      ...this.#snapshot,
      conversations: this.#upsertConversation(snapshot.conversation),
    });
  }

  #handleClientSnapshotCleared(): void {
    if (this.#disposed) return;
    const conversationId =
      this.#snapshot.selectedConversationId ??
      this.#snapshot.pendingConversationId;
    if (conversationId === undefined) return;
    const conversations = this.#snapshot.conversations.filter(
      (conversation) => conversation.id !== conversationId,
    );
    this.#listRevision += 1;
    this.#selectionIntentRevision += 1;
    this.#selectionRevision += 1;
    this.#automaticSelectionRevision = undefined;
    this.#commit({
      ...this.#snapshot,
      conversations,
      listError: undefined,
      listStatus: "ready",
      pendingConversationId: undefined,
      selectedConversationId: undefined,
      selectionError: undefined,
      selectionStatus:
        conversations.length === 0 ? ("empty" as const) : ("idle" as const),
    });
  }

  #isCurrentList(revision: number): boolean {
    return !this.#disposed && revision === this.#listRevision;
  }

  #isCurrentSelection(revision: number): boolean {
    return !this.#disposed && revision === this.#selectionRevision;
  }

  #commit(snapshot: ConversationWorkspaceSnapshot): void {
    if (this.#disposed || deepEqual(snapshot, this.#snapshot)) return;
    this.#snapshot = cloneImmutable(snapshot);
    for (const registration of [...this.#listeners]) {
      this.#callListener(registration);
    }
  }

  #callListener(registration: ListenerRegistration): void {
    if (!registration.active) return;
    try {
      registration.listener(this.#snapshot);
    } catch (error) {
      this.#reportUnhandledError(error);
    }
  }

  #reportUnhandledError(error: unknown): void {
    try {
      this.#onUnhandledError?.(error);
    } catch {
      // Diagnostic callbacks must not break healthy workspace subscribers.
    }
  }
}

export const createConversationWorkspaceController = (
  options: ConversationWorkspaceControllerOptions,
): ConversationWorkspaceController =>
  new ConversationWorkspaceController(options);
