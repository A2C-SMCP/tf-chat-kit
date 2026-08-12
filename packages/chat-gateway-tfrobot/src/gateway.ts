import {
  chatErrorSchema,
  compareTimelineItems,
  createGatewayDeadlineExceededError,
  isGatewayDeadlineExceeded,
  type ChatGateway,
  type ChatUpdate,
  type Conversation,
  type ConversationPage,
  type CreateConversationInput,
  type DeleteConversationInput,
  type DeleteConversationSuccess,
  type GatewayObserver,
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
  type SubscribeConversationInput,
} from "@turingfocus/chat-protocol";

import { awaitBounded } from "./bounded.js";
import {
  conversationDtoSchema,
  conversationPageDtoSchema,
  deleteConversationDtoSchema,
  getTransportTaskId,
  historyDtoSchema,
  interruptDtoSchema,
  outboundMessageCreatorSchema,
  sendTextDtoSchema,
  statusDtoSchema,
} from "./dto.js";
import { TFRobotHttpClient } from "./http.js";
import {
  mapConversation,
  mapEventUpdate,
  mapMessageUpdate,
  mapRun,
  mapSnapshot,
  syntheticRunId,
  TFROBOT_CAPABILITIES,
} from "./mapper.js";
import {
  recoveryIdentityOfUpdate,
  TFRobotSocketClient,
  type CurrentServerRestInput,
  type CurrentServerRestSnapshot,
} from "./socket.js";
import type { TFRobotGatewayOptions, TFRobotMessageCreator } from "./types.js";

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;
const RECONNECT_STATUS_TIMEOUT_MS = 10_000;

const limitOf = (limit: number | undefined): number =>
  Math.min(limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);

const conversationPath = (conversationId: string, suffix: string): string =>
  `v1/chat/conversations/${encodeURIComponent(conversationId)}${suffix.length === 0 ? "" : `/${suffix}`}`;

type ConversationMutation =
  | {
      readonly conversation: Conversation;
      readonly kind: "rename";
      readonly revision: number;
      readonly transportConversationId: number | string;
    }
  | {
      readonly kind: "delete";
      readonly revision: number;
    };

export class TFRobotChatGateway implements ChatGateway {
  readonly #conversations = new Map<string, Conversation>();
  readonly #conversationMutations = new Map<string, ConversationMutation>();
  #disposed = false;
  readonly #http: TFRobotHttpClient;
  readonly #lifecycle = new AbortController();
  readonly #now: () => number;
  readonly #options: TFRobotGatewayOptions;
  readonly #socket: TFRobotSocketClient;
  readonly #transportConversationIds = new Map<string, number | string>();
  #mutationRevision = 0;

  constructor(options: TFRobotGatewayOptions) {
    for (const endpoint of [options.baseUrl, options.socketNamespaceUrl]) {
      if (endpoint === undefined) continue;
      const url = new URL(endpoint);
      if (url.username.length > 0 || url.password.length > 0) {
        throw new TypeError(
          "TFRobot Gateway endpoints must not contain URL credentials",
        );
      }
    }
    this.#options = options;
    this.#http = new TFRobotHttpClient(options);
    this.#now = options.now ?? Date.now;
    this.#socket = new TFRobotSocketClient(
      options,
      (conversationId) =>
        this.#http.request({
          method: "GET",
          path: conversationPath(conversationId, "status"),
          operation: "read",
          options: {
            deadlineAt: this.#now() + RECONNECT_STATUS_TIMEOUT_MS,
          },
          conversationId,
          schema: statusDtoSchema,
        }),
      (input) => this.#loadCurrentServerRestSnapshot(input),
    );
  }

  async listConversations(
    input: ListConversationsInput,
  ): Promise<GatewayResult<ConversationPage>> {
    const disposed = this.#disposedResult<ConversationPage>();
    if (disposed !== undefined) return disposed;
    const readRevision = this.#mutationRevision;
    const result = await this.#http.request({
      method: "GET",
      path: "v1/chat/conversations",
      operation: "read",
      options: input,
      query: {
        count: limitOf(input.limit),
        cursor: input.cursor,
        platformId: this.#options.platformId,
      },
      schema: conversationPageDtoSchema,
    });
    const requestDeadline = this.#deadlineResult<ConversationPage>(input);
    if (requestDeadline !== undefined) return requestDeadline;
    if (!result.ok) return result;
    let conversations: Conversation[];
    const transportConversations = result.value.conversations ?? [];
    try {
      conversations = transportConversations.map(mapConversation);
    } catch {
      return this.#mappingError(
        "TFRobot conversation data could not be normalized",
      );
    }
    const mappingDeadline = this.#deadlineResult<ConversationPage>(input);
    if (mappingDeadline !== undefined) return mappingDeadline;
    const visibleConversations: Conversation[] = [];
    for (const [index, conversation] of conversations.entries()) {
      const resolved = this.#resolveConversationRead(
        conversation,
        transportConversations[index]!.conversationId,
        readRevision,
      );
      if (resolved === undefined) continue;
      visibleConversations.push(resolved.conversation);
      this.#conversations.set(resolved.conversation.id, resolved.conversation);
      this.#transportConversationIds.set(
        resolved.conversation.id,
        resolved.transportConversationId,
      );
    }
    return {
      ok: true,
      value: {
        conversations: visibleConversations,
        ...(result.value.cursor == null || result.value.cursor.length === 0
          ? {}
          : { nextCursor: result.value.cursor }),
      },
    };
  }

  async createConversation(
    input: CreateConversationInput,
  ): Promise<GatewayResult<Conversation>> {
    const disposed = this.#disposedResult<Conversation>();
    if (disposed !== undefined) return disposed;
    const result = await this.#http.request({
      method: "POST",
      path: "v1/chat/conversations",
      operation: "send",
      options: input,
      query: {
        title: input.title,
        platformId: this.#options.platformId,
      },
      schema: conversationDtoSchema,
    });
    const requestDisposed = this.#disposedResult<Conversation>();
    if (requestDisposed !== undefined) return requestDisposed;
    const requestDeadline = this.#deadlineResult<Conversation>(input);
    if (requestDeadline !== undefined) return requestDeadline;
    if (!result.ok) return result;
    let conversation: Conversation;
    try {
      conversation = mapConversation(result.value);
    } catch {
      return this.#mappingError(
        "TFRobot created conversation could not be normalized",
      );
    }
    const mappingDeadline = this.#deadlineResult<Conversation>(input);
    if (mappingDeadline !== undefined) return mappingDeadline;
    this.#conversations.set(conversation.id, conversation);
    this.#transportConversationIds.set(
      conversation.id,
      result.value.conversationId,
    );
    this.#conversationMutations.set(conversation.id, {
      conversation,
      kind: "rename",
      revision: ++this.#mutationRevision,
      transportConversationId: result.value.conversationId,
    });
    return { ok: true, value: conversation };
  }

  async renameConversation(
    input: RenameConversationInput,
  ): Promise<GatewayResult<Conversation>> {
    const disposed = this.#disposedResult<Conversation>();
    if (disposed !== undefined) return disposed;
    const transportConversationId =
      this.#transportConversationIds.get(input.conversationId) ??
      input.conversationId;
    const result = await this.#http.request({
      method: "PATCH",
      path: conversationPath(String(transportConversationId), ""),
      operation: "send",
      options: input,
      conversationId: input.conversationId,
      query: { title: input.title },
      body: { title: input.title },
      schema: conversationDtoSchema,
    });
    const requestDisposed = this.#disposedResult<Conversation>();
    if (requestDisposed !== undefined) return requestDisposed;
    const requestDeadline = this.#deadlineResult<Conversation>(input);
    if (requestDeadline !== undefined) return requestDeadline;
    if (!result.ok) return result;
    let conversation: Conversation;
    try {
      conversation = mapConversation(result.value);
    } catch {
      return this.#mappingError(
        "TFRobot renamed conversation could not be normalized",
        input.conversationId,
      );
    }
    if (conversation.id !== input.conversationId) {
      return this.#mappingError(
        "TFRobot rename response identified another conversation",
        input.conversationId,
      );
    }
    this.#conversations.set(conversation.id, conversation);
    this.#transportConversationIds.set(
      conversation.id,
      result.value.conversationId,
    );
    this.#conversationMutations.set(conversation.id, {
      conversation,
      kind: "rename",
      revision: ++this.#mutationRevision,
      transportConversationId: result.value.conversationId,
    });
    return { ok: true, value: conversation };
  }

  async deleteConversation(
    input: DeleteConversationInput,
  ): Promise<GatewayResult<DeleteConversationSuccess>> {
    const disposed = this.#disposedResult<DeleteConversationSuccess>();
    if (disposed !== undefined) return disposed;
    const transportConversationId =
      this.#transportConversationIds.get(input.conversationId) ??
      input.conversationId;
    const result = await this.#http.request({
      method: "DELETE",
      path: conversationPath(String(transportConversationId), ""),
      operation: "send",
      options: input,
      conversationId: input.conversationId,
      schema: deleteConversationDtoSchema,
    });
    const requestDisposed = this.#disposedResult<DeleteConversationSuccess>();
    if (requestDisposed !== undefined) return requestDisposed;
    const requestDeadline =
      this.#deadlineResult<DeleteConversationSuccess>(input);
    if (requestDeadline !== undefined) return requestDeadline;
    if (!result.ok) return result;
    if (String(result.value.conversationId) !== input.conversationId) {
      return this.#mappingError(
        "TFRobot delete response identified another conversation",
        input.conversationId,
      );
    }
    this.#conversations.delete(input.conversationId);
    this.#transportConversationIds.delete(input.conversationId);
    this.#conversationMutations.set(input.conversationId, {
      kind: "delete",
      revision: ++this.#mutationRevision,
    });
    this.#socket.forgetConversation(input.conversationId);
    return {
      ok: true,
      value: { deletedConversationId: input.conversationId },
    };
  }

  async loadConversation(
    input: LoadConversationInput,
  ): Promise<GatewayResult<ReturnType<typeof mapSnapshot>>> {
    const disposed = this.#disposedResult<ReturnType<typeof mapSnapshot>>();
    if (disposed !== undefined) return disposed;
    const readRevision = this.#mutationRevision;
    if (!this.#conversations.has(input.conversationId)) {
      await this.listConversations({
        deadlineAt: input.deadlineAt,
        limit: MAX_PAGE_SIZE,
      });
    }
    const [history, status] = await Promise.all([
      this.#http.request({
        method: "GET",
        path: conversationPath(input.conversationId, "messages"),
        operation: "read",
        options: input,
        conversationId: input.conversationId,
        query: {
          count: -limitOf(input.limit),
          cursor: input.previousCursor,
        },
        schema: historyDtoSchema,
      }),
      this.#http.request({
        method: "GET",
        path: conversationPath(input.conversationId, "status"),
        operation: "read",
        options: input,
        conversationId: input.conversationId,
        schema: statusDtoSchema,
      }),
    ]);
    if (!history.ok && history.error.code === "timeout") return history;
    if (!status.ok && status.error.code === "timeout") return status;
    const requestDeadline =
      this.#deadlineResult<ReturnType<typeof mapSnapshot>>(input);
    if (requestDeadline !== undefined) return requestDeadline;
    if (!history.ok) return history;
    if (!status.ok) return status;
    const mutation = this.#conversationMutations.get(input.conversationId);
    if (
      mutation?.revision !== undefined &&
      mutation.revision > readRevision &&
      mutation.kind === "delete"
    ) {
      return this.#mutationConflict(
        "Conversation was deleted while its snapshot was loading",
        input.conversationId,
      );
    }
    let snapshot: ReturnType<typeof mapSnapshot>;
    try {
      const conversation =
        mutation !== undefined &&
        mutation.revision > readRevision &&
        mutation.kind === "rename"
          ? mutation.conversation
          : (this.#conversations.get(input.conversationId) ??
            mapConversation({
              conversationId: input.conversationId,
              title: input.conversationId,
            }));
      snapshot = mapSnapshot(conversation, history.value, status.value);
      this.#socket.rememberSnapshot(snapshot);
    } catch {
      return this.#mappingError(
        "TFRobot conversation snapshot could not be normalized",
      );
    }
    const mappingDeadline =
      this.#deadlineResult<ReturnType<typeof mapSnapshot>>(input);
    if (mappingDeadline !== undefined) return mappingDeadline;
    return {
      ok: true,
      value:
        input.previousCursor === undefined
          ? snapshot
          : {
              ...snapshot,
              timeline: [...snapshot.timeline].sort(compareTimelineItems),
            },
    };
  }

  subscribe(
    input: SubscribeConversationInput,
    observer: GatewayObserver,
  ): Promise<GatewayResult<GatewaySubscription>> {
    const disposed = this.#disposedResult<GatewaySubscription>();
    return disposed === undefined
      ? this.#socket.subscribe(input.conversationId, input, observer)
      : Promise.resolve(disposed);
  }

  async sendText(
    input: SendTextInput,
  ): Promise<GatewayResult<SendTextSuccess>> {
    const disposed = this.#disposedResult<SendTextSuccess>();
    if (disposed !== undefined) return disposed;
    const creator = await this.#resolveMessageCreator(input);
    const creatorDeadline = this.#deadlineResult<SendTextSuccess>(input);
    if (creatorDeadline !== undefined) return creatorDeadline;
    if (!creator.ok) return creator;
    const result = await this.#http.request({
      method: "POST",
      path: conversationPath(input.conversationId, "messages"),
      operation: "send",
      options: input,
      conversationId: input.conversationId,
      body: {
        msgId: input.clientMessageId ?? null,
        content: input.text,
        additionalKwargs: {},
        attachments: null,
        createTimestamp: 0,
        creator: creator.value,
        conversationId:
          this.#transportConversationIds.get(input.conversationId) ??
          input.conversationId,
        role: "user",
        msgType: "text",
      },
      schema: sendTextDtoSchema,
    });
    const requestDeadline = this.#deadlineResult<SendTextSuccess>(input);
    if (requestDeadline !== undefined) return requestDeadline;
    return result.ok
      ? {
          ok: true,
          value: {
            runId:
              getTransportTaskId(result.value) ??
              syntheticRunId(input.conversationId),
          },
        }
      : result;
  }

  async interrupt(
    input: InterruptRunInput,
  ): Promise<GatewayResult<InterruptRunSuccess>> {
    const disposed = this.#disposedResult<InterruptRunSuccess>();
    if (disposed !== undefined) return disposed;
    if (
      input.runId === undefined ||
      input.runId === syntheticRunId(input.conversationId)
    ) {
      return {
        ok: false,
        error: chatErrorSchema.parse({
          code: "conflict",
          message: "Interrupt requires a real active TFRobot taskId",
          retryable: false,
        }),
      };
    }
    const result = await this.#http.request({
      method: "POST",
      path: conversationPath(input.conversationId, "interrupt"),
      operation: "send",
      options: input,
      conversationId: input.conversationId,
      body: { taskId: input.runId },
      schema: interruptDtoSchema,
    });
    const requestDeadline = this.#deadlineResult<InterruptRunSuccess>(input);
    if (requestDeadline !== undefined) return requestDeadline;
    return result.ok
      ? {
          ok: true,
          value: {
            cancellationId: getTransportTaskId(result.value)!,
            interruptedRunId: input.runId,
          },
        }
      : result;
  }

  dispose(options: GatewayRequestOptions): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#lifecycle.abort();
    this.#socket.dispose();
    this.#http.dispose();
    this.#conversations.clear();
    this.#conversationMutations.clear();
    this.#transportConversationIds.clear();
    if (isGatewayDeadlineExceeded(options, this.#now())) return;
  }

  #deadlineResult<T>(
    options: GatewayRequestOptions,
  ): GatewayResult<T> | undefined {
    return isGatewayDeadlineExceeded(options, this.#now())
      ? {
          ok: false,
          error: createGatewayDeadlineExceededError(),
        }
      : undefined;
  }

  #disposedResult<T>(): GatewayResult<T> | undefined {
    if (!this.#disposed) return undefined;
    return {
      ok: false,
      error: chatErrorSchema.parse({
        code: "conflict",
        message: "TFRobot Gateway is disposed",
        retryable: false,
      }),
    };
  }

  #mappingError<T>(message: string, conversationId?: string): GatewayResult<T> {
    return {
      ok: false,
      error: chatErrorSchema.parse({
        code: "validation",
        message,
        retryable: false,
        ...(conversationId === undefined ? {} : { conversationId }),
      }),
    };
  }

  #mutationConflict<T>(
    message: string,
    conversationId: string,
  ): GatewayResult<T> {
    return {
      ok: false,
      error: chatErrorSchema.parse({
        code: "conflict",
        conversationId,
        message,
        retryable: false,
      }),
    };
  }

  #resolveConversationRead(
    conversation: Conversation,
    transportConversationId: number | string,
    readRevision: number,
  ):
    | {
        readonly conversation: Conversation;
        readonly transportConversationId: number | string;
      }
    | undefined {
    const mutation = this.#conversationMutations.get(conversation.id);
    if (mutation === undefined || mutation.revision <= readRevision) {
      return { conversation, transportConversationId };
    }
    return mutation.kind === "delete"
      ? undefined
      : {
          conversation: mutation.conversation,
          transportConversationId: mutation.transportConversationId,
        };
  }

  async #loadCurrentServerRestSnapshot(
    input: CurrentServerRestInput,
  ): Promise<GatewayResult<CurrentServerRestSnapshot>> {
    const status = await this.#http.request({
      method: "GET",
      path: conversationPath(input.conversationId, "status"),
      operation: "read",
      options: input,
      conversationId: input.conversationId,
      schema: statusDtoSchema,
      session: input.session,
      signal: input.signal,
    });
    if (!status.ok) return status;

    const updates: ChatUpdate[] = [];
    const seenRecoveryIdentities = new Set<string>();
    const seenCursors = new Set<string>();
    let boundedBy: CurrentServerRestSnapshot["boundedBy"];
    let checkpointReached = false;
    let cursor: string | undefined;
    let exhausted = false;
    let itemCount = 0;

    for (let page = 0; page < input.limits.maxPages; page += 1) {
      const history = await this.#http.request({
        method: "GET",
        path: conversationPath(input.conversationId, "messages"),
        operation: "read",
        options: input,
        conversationId: input.conversationId,
        query: {
          count: -Math.min(
            input.limits.pageSize,
            input.limits.maxItems - itemCount,
          ),
          cursor,
        },
        schema: historyDtoSchema,
        session: input.session,
        signal: input.signal,
      });
      if (!history.ok) return history;

      let pageUpdates: ChatUpdate[];
      try {
        pageUpdates = [
          ...(history.value.messages ?? []).map(mapMessageUpdate),
          ...(history.value.events ?? []).map(mapEventUpdate),
        ];
        if (
          pageUpdates.some(
            (update) =>
              (update.kind !== "timeline.upsert" &&
                update.kind !== "event.transition.upsert") ||
              update.conversationId !== input.conversationId,
          )
        ) {
          return this.#mappingError(
            "TFRobot recovery history contained data for another conversation",
          );
        }
        pageUpdates.sort((left, right) => {
          const timestampOf = (update: ChatUpdate): number =>
            update.kind === "timeline.upsert"
              ? (update.item.updatedAt ?? update.item.createdAt)
              : update.kind === "event.transition.upsert"
                ? update.event.transition.occurredAt
                : 0;
          return timestampOf(right) - timestampOf(left);
        });
      } catch {
        return this.#mappingError(
          "TFRobot recovery history could not be normalized",
        );
      }

      for (const update of pageUpdates) {
        const identity = recoveryIdentityOfUpdate(update);
        if (identity !== undefined && input.checkpoint.has(identity)) {
          checkpointReached = true;
          break;
        }
        if (identity !== undefined && seenRecoveryIdentities.has(identity)) {
          continue;
        }
        if (itemCount >= input.limits.maxItems) {
          boundedBy = "max-items";
          break;
        }
        updates.push(update);
        itemCount += 1;
        if (identity !== undefined) seenRecoveryIdentities.add(identity);
      }
      if (boundedBy === "max-items") break;
      if (checkpointReached) break;

      const nextCursor = history.value.cursor ?? undefined;
      if (nextCursor === undefined || nextCursor.length === 0) {
        exhausted = true;
        break;
      }
      if (itemCount >= input.limits.maxItems) {
        boundedBy = "max-items";
        break;
      }
      if (seenCursors.has(nextCursor)) {
        boundedBy = "cursor-cycle";
        break;
      }
      seenCursors.add(nextCursor);
      cursor = nextCursor;
      if (page + 1 === input.limits.maxPages) boundedBy = "max-pages";
    }

    let run: CurrentServerRestSnapshot["run"];
    try {
      run = mapRun(input.conversationId, status.value);
    } catch {
      return this.#mappingError(
        "TFRobot recovery status could not be normalized",
      );
    }
    return {
      ok: true,
      value: {
        ...(boundedBy === undefined ? {} : { boundedBy }),
        checkpointReached,
        exhausted,
        run,
        updates,
      },
    };
  }

  async #resolveMessageCreator(
    input: SendTextInput,
  ): Promise<GatewayResult<TFRobotMessageCreator>> {
    if (isGatewayDeadlineExceeded(input, this.#now())) {
      return {
        ok: false,
        error: createGatewayDeadlineExceededError(),
      };
    }
    const outcome = await awaitBounded(
      () =>
        this.#options.messageCreatorProvider({
          conversationId: input.conversationId,
        }),
      {
        deadlineAt: input.deadlineAt,
        now: this.#now,
        signal: this.#lifecycle.signal,
      },
    );
    switch (outcome.kind) {
      case "aborted": {
        return (
          this.#disposedResult<TFRobotMessageCreator>() ?? {
            ok: false,
            error: createGatewayDeadlineExceededError(),
          }
        );
      }
      case "deadline": {
        return {
          ok: false,
          error: createGatewayDeadlineExceededError(),
        };
      }
      case "error": {
        return {
          ok: false,
          error: chatErrorSchema.parse({
            code: "validation",
            message: "Unable to obtain the current TFRobot message creator",
            retryable: false,
          }),
        };
      }
      case "value": {
        const parsed = outboundMessageCreatorSchema.safeParse(outcome.value);
        if (!parsed.success) {
          return {
            ok: false,
            error: chatErrorSchema.parse({
              code: "validation",
              message: "messageCreatorProvider returned an invalid creator",
              retryable: false,
            }),
          };
        }
        const disposed = this.#disposedResult<TFRobotMessageCreator>();
        return (
          disposed ??
          this.#deadlineResult<TFRobotMessageCreator>(input) ?? {
            ok: true,
            value: parsed.data,
          }
        );
      }
    }
  }
}

export const createTFRobotChatGateway = (
  options: TFRobotGatewayOptions,
): ChatGateway => new TFRobotChatGateway(options);

export { TFROBOT_CAPABILITIES };
