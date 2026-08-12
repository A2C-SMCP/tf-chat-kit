import { z } from "zod/v4";

import {
  askUserInteractionAnswerParser,
  chatErrorParser,
  chatSnapshotParser,
  conversationParser,
} from "./internal-schemas.js";
import { ASK_USER_MAX_REQUEST_ID_CHARACTERS } from "./ask-user.js";
import { createRuntimeSchema } from "./internal-runtime-schema.js";
import type {
  AskUserInteractionAnswer,
  Capabilities,
  ChatError,
  ChatLifecycle,
  ChatSnapshot,
  ChatUpdate,
  Conversation,
  ConversationId,
  Run,
  RunId,
} from "./models.js";

/** Whether transport readiness permits conversation commands. */
export const isChatLifecycleOperable = (
  lifecycle: ChatLifecycle | undefined,
): boolean => {
  if (lifecycle === undefined) return true;
  if (lifecycle.status === "degraded") {
    return (
      lifecycle.recovery?.complete === false &&
      lifecycle.recovery.assurance === "best-effort" &&
      lifecycle.recovery.source === "rest-rebase"
    );
  }
  return (
    lifecycle.status === "active" &&
    lifecycle.recovery?.complete !== false &&
    ((lifecycle.reconnectAttempt ?? 0) === 0 ||
      lifecycle.recovery?.complete === true)
  );
};

export type MaybePromise<T> = PromiseLike<T> | T;

export interface GatewayRequestOptions {
  /**
   * Unix epoch milliseconds by which the operation must settle. Adapters must
   * return createGatewayDeadlineExceededError after the deadline, settle only
   * once, and discard a late result. For subscribe this governs establishment;
   * a late subscription must be disposed without notifying its observer.
   */
  readonly deadlineAt: number;
}

export const isGatewayDeadlineExceeded = (
  options: GatewayRequestOptions,
  now: number = Date.now(),
): boolean => now >= options.deadlineAt;

export const createGatewayDeadlineExceededError = (
  conversationId?: ConversationId,
): ChatError => {
  const error = {
    code: "timeout",
    message: "Gateway operation exceeded its deadline",
    retryable: true,
  } as const;
  return conversationId === undefined ? error : { ...error, conversationId };
};

export interface ListConversationsInput extends GatewayRequestOptions {
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
}

export interface ConversationPage {
  readonly conversations: readonly Conversation[];
  readonly nextCursor?: string | undefined;
}

export interface CreateConversationInput extends GatewayRequestOptions {
  readonly title: string;
}

export interface RenameConversationInput extends GatewayRequestOptions {
  readonly conversationId: ConversationId;
  readonly title: string;
}

export interface DeleteConversationInput extends GatewayRequestOptions {
  readonly conversationId: ConversationId;
}

export interface DeleteConversationSuccess {
  readonly deletedConversationId: ConversationId;
}

export type GatewayResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ChatError };

export type GatewayOperation =
  | "answerInteraction"
  | "interrupt"
  | "listConversations"
  | "loadHistory"
  | "sendText"
  | "subscribe";

/**
 * Maps normalized capabilities to executable Gateway operations. Adapters use
 * this before dispatch and return a structured `unsupported` GatewayResult
 * when it returns false. Initial snapshot loading is always allowed; only a
 * request carrying `previousCursor` is a `loadHistory` operation.
 */
export const isGatewayOperationSupported = (
  capabilities: Capabilities,
  operation: GatewayOperation,
  run?: Run | null,
): boolean => {
  switch (operation) {
    case "answerInteraction":
      return capabilities.answerInteraction === true;
    case "interrupt":
      return (
        capabilities.interrupt &&
        run?.canInterrupt === true &&
        run.status === "running"
      );
    case "listConversations":
      return capabilities.listConversations;
    case "loadHistory":
      return capabilities.loadHistory;
    case "sendText":
      return capabilities.sendText;
    case "subscribe":
      return capabilities.liveUpdates;
  }
};

export interface LoadConversationInput extends GatewayRequestOptions {
  readonly conversationId: ConversationId;
  readonly previousCursor?: string | undefined;
  readonly limit?: number | undefined;
}

export interface SubscribeConversationInput extends GatewayRequestOptions {
  readonly conversationId: ConversationId;
}

export interface SendTextInput extends GatewayRequestOptions {
  readonly conversationId: ConversationId;
  readonly text: string;
  /** Optional stable ID supplied by a Runtime or host for idempotent mapping. */
  readonly clientMessageId?: string | undefined;
}

export interface SendTextSuccess {
  /** ID of the run started by the accepted message. */
  readonly runId: RunId;
}

export interface InterruptRunInput extends GatewayRequestOptions {
  readonly conversationId: ConversationId;
  /** Protects against interrupting a newer run when the caller has a known ID. */
  readonly runId?: RunId | undefined;
}

export interface InterruptRunSuccess {
  /** ID of the cancellation operation, which is not the interrupted run ID. */
  readonly cancellationId: string;
  readonly interruptedRunId?: RunId | undefined;
}

export interface AnswerInteractionInput extends GatewayRequestOptions {
  readonly conversationId: ConversationId;
  readonly answer: AskUserInteractionAnswer;
}

export interface AnswerInteractionSuccess {
  readonly requestId: string;
  readonly revision: string;
}

export interface GatewayObserver {
  next(update: ChatUpdate): void;
  error?(error: ChatError): void;
}

export interface GatewaySubscription {
  /**
   * Becomes silent synchronously and settles cleanup no later than deadlineAt.
   * Implementations must resolve at the deadline and abandon late transport
   * cleanup rather than blocking a conversation switch.
   */
  dispose(options: GatewayRequestOptions): MaybePromise<void>;
}

/**
 * Host- and transport-agnostic port consumed by Chat Runtime instances.
 * Implementations own their connection and must become silent after dispose.
 */
export interface ChatGateway {
  /**
   * Optional for backward compatibility. Runtime returns a structured
   * `unsupported` result when an adapter does not implement conversation
   * creation.
   */
  createConversation?(
    input: CreateConversationInput,
  ): Promise<GatewayResult<Conversation>>;
  /** Optional for backward compatibility with adapters lacking management APIs. */
  renameConversation?(
    input: RenameConversationInput,
  ): Promise<GatewayResult<Conversation>>;
  /** Optional for backward compatibility with adapters lacking management APIs. */
  deleteConversation?(
    input: DeleteConversationInput,
  ): Promise<GatewayResult<DeleteConversationSuccess>>;
  /**
   * Optional during migration. Runtime dispatches only when both the normalized
   * capability and this method are present.
   */
  answerInteraction?(
    input: AnswerInteractionInput,
  ): Promise<GatewayResult<AnswerInteractionSuccess>>;
  listConversations(
    input: ListConversationsInput,
  ): Promise<GatewayResult<ConversationPage>>;
  loadConversation(
    input: LoadConversationInput,
  ): Promise<GatewayResult<ChatSnapshot>>;
  subscribe(
    input: SubscribeConversationInput,
    observer: GatewayObserver,
  ): MaybePromise<GatewayResult<GatewaySubscription>>;
  sendText(input: SendTextInput): Promise<GatewayResult<SendTextSuccess>>;
  interrupt(
    input: InterruptRunInput,
  ): Promise<GatewayResult<InterruptRunSuccess>>;
  /**
   * Becomes silent synchronously, is idempotent, and settles no later than the
   * supplied deadline even if transport cleanup never completes.
   */
  dispose(options: GatewayRequestOptions): MaybePromise<void>;
}

export type SessionPurpose = "connect" | "reconnect" | "request";
export type SessionOperation = "read" | "send" | "subscribe";

export interface SessionRequest {
  readonly purpose: SessionPurpose;
  readonly operation: SessionOperation;
  readonly conversationId?: ConversationId | undefined;
}

export type SessionInvalidationReason =
  "expired" | "forbidden" | "rejected" | "unknown";

export interface SessionInvalidation {
  readonly reason: SessionInvalidationReason;
  readonly error: ChatError;
}

/**
 * The session value is opaque to Protocol. A concrete Gateway defines its
 * short-lived material while the host remains responsible for refresh/login.
 */
export interface SessionProvider<TSession> {
  getSession(request: SessionRequest): MaybePromise<TSession>;
  onSessionInvalid?(invalidation: SessionInvalidation): MaybePromise<void>;
}

const positiveLimitParser = z.number().int().positive();
const deadlineParser = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);

const gatewayRequestOptionsParser: z.ZodType<GatewayRequestOptions> = z.object({
  deadlineAt: deadlineParser,
});

const listConversationsInputParser: z.ZodType<ListConversationsInput> =
  z.object({
    cursor: z.string().optional(),
    limit: positiveLimitParser.optional(),
    deadlineAt: deadlineParser,
  });

const conversationPageParser: z.ZodType<ConversationPage> = z.object({
  conversations: z.array(conversationParser),
  nextCursor: z.string().optional(),
});

const createConversationInputParser: z.ZodType<CreateConversationInput> =
  z.object({
    title: z.string().trim().min(1),
    deadlineAt: deadlineParser,
  });

const renameConversationInputParser: z.ZodType<RenameConversationInput> =
  z.object({
    conversationId: z.string().min(1),
    title: z.string().trim().min(1),
    deadlineAt: deadlineParser,
  });

const deleteConversationInputParser: z.ZodType<DeleteConversationInput> =
  z.object({
    conversationId: z.string().min(1),
    deadlineAt: deadlineParser,
  });

const deleteConversationSuccessParser: z.ZodType<DeleteConversationSuccess> =
  z.object({
    deletedConversationId: z.string().min(1),
  });

const loadConversationInputParser: z.ZodType<LoadConversationInput> = z.object({
  conversationId: z.string().min(1),
  previousCursor: z.string().optional(),
  limit: positiveLimitParser.optional(),
  deadlineAt: deadlineParser,
});

const subscribeConversationInputParser: z.ZodType<SubscribeConversationInput> =
  z.object({
    conversationId: z.string().min(1),
    deadlineAt: deadlineParser,
  });

const sendTextInputParser: z.ZodType<SendTextInput> = z.object({
  conversationId: z.string().min(1),
  text: z.string().min(1),
  clientMessageId: z.string().min(1).optional(),
  deadlineAt: deadlineParser,
});

const sendTextSuccessParser: z.ZodType<SendTextSuccess> = z.object({
  runId: z.string().min(1),
});

const interruptRunInputParser: z.ZodType<InterruptRunInput> = z.object({
  conversationId: z.string().min(1),
  runId: z.string().min(1).optional(),
  deadlineAt: deadlineParser,
});

const interruptRunSuccessParser: z.ZodType<InterruptRunSuccess> = z.object({
  cancellationId: z.string().min(1),
  interruptedRunId: z.string().min(1).optional(),
});

const answerInteractionInputParser: z.ZodType<AnswerInteractionInput> =
  z.object({
    conversationId: z.string().min(1),
    answer: askUserInteractionAnswerParser,
    deadlineAt: deadlineParser,
  });

const answerInteractionSuccessParser: z.ZodType<AnswerInteractionSuccess> =
  z.object({
    requestId: z.string().min(1).max(ASK_USER_MAX_REQUEST_ID_CHARACTERS),
    revision: z.string().min(1).max(ASK_USER_MAX_REQUEST_ID_CHARACTERS),
  });

const gatewayResultParser = <T>(
  valueParser: z.ZodType<T>,
): z.ZodType<GatewayResult<T>> =>
  z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), value: valueParser }),
    z.object({ ok: z.literal(false), error: chatErrorParser }),
  ]);

const sessionRequestParser: z.ZodType<SessionRequest> = z.object({
  purpose: z.enum(["connect", "reconnect", "request"]),
  operation: z.enum(["read", "send", "subscribe"]),
  conversationId: z.string().min(1).optional(),
});

const sessionInvalidationParser: z.ZodType<SessionInvalidation> = z.object({
  reason: z.enum(["expired", "forbidden", "rejected", "unknown"]),
  error: chatErrorParser,
});

export const listConversationsInputSchema = createRuntimeSchema(
  listConversationsInputParser,
);
export const gatewayRequestOptionsSchema = createRuntimeSchema(
  gatewayRequestOptionsParser,
);
export const conversationPageSchema = createRuntimeSchema(
  conversationPageParser,
);
export const conversationPageResultSchema = createRuntimeSchema(
  gatewayResultParser(conversationPageParser),
);
export const createConversationInputSchema = createRuntimeSchema(
  createConversationInputParser,
);
export const createConversationResultSchema = createRuntimeSchema(
  gatewayResultParser(conversationParser),
);
export const renameConversationInputSchema = createRuntimeSchema(
  renameConversationInputParser,
);
export const renameConversationResultSchema = createRuntimeSchema(
  gatewayResultParser(conversationParser),
);
export const deleteConversationInputSchema = createRuntimeSchema(
  deleteConversationInputParser,
);
export const deleteConversationResultSchema = createRuntimeSchema(
  gatewayResultParser(deleteConversationSuccessParser),
);
export const loadConversationInputSchema = createRuntimeSchema(
  loadConversationInputParser,
);
export const loadConversationResultSchema = createRuntimeSchema(
  gatewayResultParser(chatSnapshotParser),
);
export const subscribeConversationInputSchema = createRuntimeSchema(
  subscribeConversationInputParser,
);
export const sendTextInputSchema = createRuntimeSchema(sendTextInputParser);
export const sendTextResultSchema = createRuntimeSchema(
  gatewayResultParser(sendTextSuccessParser),
);
export const interruptRunInputSchema = createRuntimeSchema(
  interruptRunInputParser,
);
export const interruptRunResultSchema = createRuntimeSchema(
  gatewayResultParser(interruptRunSuccessParser),
);
export const answerInteractionInputSchema = createRuntimeSchema(
  answerInteractionInputParser,
);
export const answerInteractionResultSchema = createRuntimeSchema(
  gatewayResultParser(answerInteractionSuccessParser),
);
export const sessionRequestSchema = createRuntimeSchema(sessionRequestParser);
export const sessionInvalidationSchema = createRuntimeSchema(
  sessionInvalidationParser,
);
