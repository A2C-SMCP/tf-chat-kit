import {
  agentEventParser,
  askUserInteractionAnswerParser,
  askUserInteractionRequestParser,
  askUserInteractionResultParser,
  capabilitiesParser,
  chatErrorParser,
  chatSnapshotParser,
  chatUpdateParser,
  conversationParser,
  messageParser,
  runParser,
  timelineItemParser,
  unknownEventParser,
} from "./internal-schemas.js";
import { createRuntimeSchema } from "./internal-runtime-schema.js";
import type { ReadonlyJsonValue } from "./raw.js";

export type ConversationId = string;
export type TimelineItemId = string;
export type RunId = string;

export interface Conversation {
  readonly id: ConversationId;
  readonly title: string;
  readonly description?: string | undefined;
  /** Unix epoch milliseconds. */
  readonly updatedAt?: number | undefined;
  readonly raw?: ReadonlyJsonValue | undefined;
}

export type MessageRole = "assistant" | "system" | "tool" | "unknown" | "user";

export interface TextMessageContent {
  readonly kind: "text";
  readonly text: string;
}

export interface MediaMessageContent {
  readonly kind: "media";
  readonly mediaType: "audio" | "image" | "video";
  readonly summary: string;
  readonly raw?: ReadonlyJsonValue | undefined;
}

export interface FileMessageContent {
  readonly kind: "file";
  readonly summary: string;
  readonly raw?: ReadonlyJsonValue | undefined;
}

export interface ContactMessageContent {
  readonly kind: "contact";
  readonly summary: string;
  readonly raw?: ReadonlyJsonValue | undefined;
}

export interface UrlMessageContent {
  readonly kind: "url";
  readonly summary: string;
  readonly raw?: ReadonlyJsonValue | undefined;
}

export interface UnknownMessageContent {
  readonly kind: "unknown";
  readonly summary: string;
  readonly raw?: ReadonlyJsonValue | undefined;
}

/**
 * One normalized received-message variant. Multipart and attachment resource
 * contracts remain deferred; non-text variants expose only safe fallback data.
 */
export type MessageContent =
  | ContactMessageContent
  | FileMessageContent
  | MediaMessageContent
  | TextMessageContent
  | UnknownMessageContent
  | UrlMessageContent;

export interface MessageAuthor {
  readonly id?: string | undefined;
  readonly displayName?: string | undefined;
  readonly avatarUrl?: string | undefined;
}

export interface Message {
  readonly kind: "message";
  readonly id: TimelineItemId;
  readonly conversationId: ConversationId;
  readonly role: MessageRole;
  readonly content: MessageContent;
  /** Server-owned Unix epoch milliseconds used for stable ordering. */
  readonly createdAt: number;
  readonly updatedAt?: number | undefined;
  /** Optional server-defined tie breaker for items sharing createdAt. */
  readonly sequence?: number | undefined;
  readonly author?: MessageAuthor | undefined;
  readonly reasoning?: string | undefined;
  readonly raw?: ReadonlyJsonValue | undefined;
}

export type AgentEventStatus =
  "aborted" | "failed" | "running" | "success" | "timeout" | "unknown";

export interface AgentEventTransition {
  /** Gateway-normalized stable ID; duplicate delivery must reuse the same ID. */
  readonly id: string;
  readonly status: AgentEventStatus;
  /** Server-owned Unix epoch milliseconds; array order breaks equal-time ties. */
  readonly occurredAt: number;
  readonly sequence?: number | undefined;
  readonly summary?: string | undefined;
  readonly error?: ChatError | undefined;
  readonly raw?: ReadonlyJsonValue | undefined;
}

export interface ToolCall {
  readonly id?: string | undefined;
  readonly name: string;
  readonly description?: string | undefined;
  readonly arguments?: ReadonlyJsonValue | undefined;
  readonly index?: number | undefined;
}

interface ToolReturnFields {
  readonly result?: ReadonlyJsonValue | undefined;
  readonly success?: boolean | undefined;
  readonly done?: boolean | undefined;
  readonly raw?: ReadonlyJsonValue | undefined;
}

/** A normalized Tool return must preserve at least one meaningful field. */
export type ToolReturn =
  | (ToolReturnFields & { readonly result: ReadonlyJsonValue })
  | (ToolReturnFields & { readonly success: boolean })
  | (ToolReturnFields & { readonly done: boolean })
  | (ToolReturnFields & { readonly raw: ReadonlyJsonValue });

export interface AskUserInteractionOption {
  readonly label: string;
  readonly value: string;
  readonly description?: string | undefined;
}

export interface AskUserInteractionQuestion {
  readonly id: string;
  readonly prompt: string;
  readonly title?: string | undefined;
  readonly description?: string | undefined;
  readonly placeholder?: string | undefined;
  readonly required: boolean;
  readonly multiple: boolean;
  readonly defaultValue?: AskUserInteractionValue | undefined;
  readonly options: readonly AskUserInteractionOption[];
}

export type AskUserInteractionValue = string | readonly string[];

/** One conversation-scoped request for structured user input. */
export interface AskUserInteractionRequest {
  readonly kind: "ask-user";
  readonly conversationId: ConversationId;
  readonly requestId: string;
  /** Immutable Gateway-issued identity for this exact request envelope. */
  readonly revision: string;
  readonly eventId?: string | undefined;
  readonly title: string;
  readonly questions: readonly AskUserInteractionQuestion[];
  readonly timeoutSeconds?: number | undefined;
}

export interface AskUserInteractionAnswer {
  readonly requestId: string;
  readonly revision: string;
  readonly action: "cancel" | "submit";
  readonly answers: Readonly<Record<string, AskUserInteractionValue>>;
}

/** Gateway-normalized terminal Ask User data suitable for history rendering. */
export interface AskUserInteractionResult {
  readonly kind: "ask-user";
  readonly requestId: string;
  readonly revision?: string | undefined;
  readonly status:
    "answered" | "cancelled" | "chat-about-this" | "failed" | "timeout";
  readonly questions: readonly AskUserInteractionQuestion[];
  readonly answers?:
    Readonly<Record<string, AskUserInteractionValue>> | undefined;
  readonly error?: string | undefined;
}

export interface ToolEventTransition extends AgentEventTransition {
  readonly toolCall?: ToolCall | undefined;
  readonly toolReturn?: ToolReturn | undefined;
  readonly interaction?: AskUserInteractionResult | undefined;
}

interface AgentEventBase {
  readonly kind: "agent-event";
  readonly id: TimelineItemId;
  readonly conversationId: ConversationId;
  readonly eventType: string;
  /** Latest transition status; schemas require it to match transitions.at(-1). */
  readonly status: AgentEventStatus;
  readonly createdAt: number;
  readonly updatedAt?: number | undefined;
  readonly sequence?: number | undefined;
  readonly summary?: string | undefined;
  readonly raw?: ReadonlyJsonValue | undefined;
}

export interface GenericAgentEvent extends AgentEventBase {
  readonly eventCategory: "generic";
  readonly transitions: readonly AgentEventTransition[];
}

/** Structured Tool event preserving partial and terminal transition data. */
export interface ToolAgentEvent extends AgentEventBase {
  readonly eventCategory: "tool";
  readonly transitions: readonly ToolEventTransition[];
}

export type AgentEvent = GenericAgentEvent | ToolAgentEvent;

interface AgentEventTransitionPayloadBase {
  /** Immutable event identity established by the first accepted transition. */
  readonly id: TimelineItemId;
  /** Immutable for an event ID; conflicting updates must be rejected. */
  readonly eventType: string;
  /**
   * Stable event creation time when the transport exposes one. Runtime derives
   * it from the first accepted transition when this metadata is unavailable.
   */
  readonly createdAt?: number | undefined;
  /** Immutable for an event ID; conflicting updates must be rejected. */
  readonly sequence?: number | undefined;
}

export interface GenericAgentEventTransitionPayload extends AgentEventTransitionPayloadBase {
  readonly eventCategory: "generic";
  readonly transition: AgentEventTransition;
}

export interface ToolAgentEventTransitionPayload extends AgentEventTransitionPayloadBase {
  readonly eventCategory: "tool";
  readonly transition: ToolEventTransition;
}

export type AgentEventTransitionPayload =
  GenericAgentEventTransitionPayload | ToolAgentEventTransitionPayload;

/** Safe fallback for an event type the Gateway cannot normalize. */
export interface UnknownEvent {
  readonly kind: "unknown-event";
  readonly id: TimelineItemId;
  readonly conversationId: ConversationId;
  readonly originalType: string;
  readonly createdAt: number;
  readonly updatedAt?: number | undefined;
  readonly sequence?: number | undefined;
  readonly summary: string;
  readonly raw?: ReadonlyJsonValue | undefined;
}

export type TimelineItem = AgentEvent | Message | UnknownEvent;

export type RunStatus =
  "aborted" | "failed" | "running" | "succeeded" | "unknown";

export interface Run {
  readonly id: RunId;
  readonly conversationId: ConversationId;
  readonly status: RunStatus;
  readonly canInterrupt: boolean;
  readonly startedAt?: number | undefined;
  readonly finishedAt?: number | undefined;
  readonly error?: ChatError | undefined;
}

export type ChatErrorCode =
  | "authentication"
  | "authorization"
  | "conflict"
  | "network"
  | "not-found"
  | "server"
  | "timeout"
  | "unknown"
  | "unsupported"
  | "validation";

export interface ChatError {
  readonly code: ChatErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly conversationId?: ConversationId | undefined;
  readonly details?: ReadonlyJsonValue | undefined;
}

export type ChatLifecycleStatus =
  | "connecting"
  | "joining"
  | "active"
  | "degraded"
  | "reconnecting"
  | "recovering"
  | "auth-required"
  | "offline"
  | "subscription-failed";

export type ChatRecoveryAssurance = "best-effort" | "verified";
export type ChatRecoverySource = "rest-rebase" | "server-replay";

/**
 * Conversation-scoped transport readiness. A missing lifecycle means a legacy
 * Gateway whose command availability continues to be capability-driven.
 */
export interface ChatLifecycle {
  readonly status: ChatLifecycleStatus;
  readonly generation?: number | undefined;
  readonly reconnectAttempt?: number | undefined;
  readonly subscriptionId?: string | undefined;
  readonly recovery?:
    | {
        readonly assurance?: ChatRecoveryAssurance | undefined;
        readonly complete: boolean;
        readonly cursor?: string | undefined;
        readonly reason?: string | undefined;
        readonly source?: ChatRecoverySource | undefined;
      }
    | undefined;
}

export type ChatErrorSource =
  | "authentication"
  | "command"
  | "connection"
  | "domain"
  | "protocol"
  | "recovery"
  | "runtime"
  | "subscription";

export type ChatErrorScope =
  | { readonly kind: "global" }
  | { readonly kind: "conversation"; readonly id: ConversationId }
  | { readonly kind: "subscription"; readonly id: string }
  | { readonly kind: "command"; readonly id: string };

/** One independently resolvable error occurrence. */
export interface ChatErrorOccurrence {
  readonly id: string;
  readonly error: ChatError;
  readonly source: ChatErrorSource;
  readonly scope: ChatErrorScope;
  readonly generation: number;
}

export interface Capabilities {
  /** Enables ChatGateway.answerInteraction when the optional method exists. */
  readonly answerInteraction?: boolean | undefined;
  /** Enables interrupt only while the current run is running and interruptible. */
  readonly interrupt: boolean;
  /** Enables ChatGateway.listConversations. */
  readonly listConversations: boolean;
  /** Enables ChatGateway.subscribe. */
  readonly liveUpdates: boolean;
  /** Enables history requests carrying a previousCursor; initial load remains available. */
  readonly loadHistory: boolean;
  /** Enables ChatGateway.sendText. */
  readonly sendText: boolean;
}

export interface TimelinePageInfo {
  readonly previousCursor?: string | undefined;
  readonly hasPreviousPage: boolean;
}

export interface ChatSnapshot {
  readonly conversation: Conversation;
  readonly timeline: readonly TimelineItem[];
  readonly run: Run | null;
  readonly capabilities: Capabilities;
  readonly pageInfo: TimelinePageInfo;
  readonly pendingInteraction?: AskUserInteractionRequest | undefined;
  readonly lifecycle?: ChatLifecycle | undefined;
  readonly activeErrors?: readonly ChatErrorOccurrence[] | undefined;
  /** @deprecated Prefer activeErrors; retained as the latest-error projection. */
  readonly error?: ChatError | undefined;
}

export interface AgentEventTransitionUpdate {
  readonly kind: "event.transition.upsert";
  readonly conversationId: ConversationId;
  readonly event: AgentEventTransitionPayload;
}

export type ChatUpdate =
  | { readonly kind: "snapshot.replace"; readonly snapshot: ChatSnapshot }
  | {
      readonly kind: "conversation.upsert";
      readonly conversation: Conversation;
    }
  | {
      /** Full item replacement; use event.transition.upsert for one transition. */
      readonly kind: "timeline.upsert";
      readonly conversationId: ConversationId;
      readonly item: TimelineItem;
    }
  /**
   * Idempotently upserts one transition without requiring Gateway state.
   * Runtime groups by conversationId/event.id, upserts by transition.id,
   * orders by occurredAt/sequence/id, and derives the latest status.
   */
  | AgentEventTransitionUpdate
  | {
      readonly kind: "run.replace";
      readonly conversationId: ConversationId;
      readonly run: Run | null;
    }
  | {
      readonly kind: "capabilities.replace";
      readonly conversationId: ConversationId;
      readonly capabilities: Capabilities;
    }
  | {
      readonly kind: "interaction.replace";
      readonly conversationId: ConversationId;
      readonly interaction: AskUserInteractionRequest | null;
    }
  | {
      readonly kind: "lifecycle.changed";
      readonly conversationId: ConversationId;
      readonly lifecycle: ChatLifecycle;
    }
  | {
      readonly kind: "error.reported";
      readonly conversationId?: ConversationId | undefined;
      readonly error: ChatError;
      readonly errorId?: string | undefined;
      readonly source?: ChatErrorSource | undefined;
      readonly scope?: ChatErrorScope | undefined;
      readonly generation?: number | undefined;
    }
  | {
      readonly kind: "error.resolved";
      readonly conversationId?: ConversationId | undefined;
      readonly errorId: string;
    };

export const conversationSchema = createRuntimeSchema(conversationParser);
export const askUserInteractionRequestSchema = createRuntimeSchema(
  askUserInteractionRequestParser,
);
export const askUserInteractionAnswerSchema = createRuntimeSchema(
  askUserInteractionAnswerParser,
);
export const askUserInteractionResultSchema = createRuntimeSchema(
  askUserInteractionResultParser,
);
export const messageSchema = createRuntimeSchema(messageParser);
export const agentEventSchema = createRuntimeSchema(agentEventParser);
export const unknownEventSchema = createRuntimeSchema(unknownEventParser);
export const timelineItemSchema = createRuntimeSchema(timelineItemParser);
export const runSchema = createRuntimeSchema(runParser);
export const chatErrorSchema = createRuntimeSchema(chatErrorParser);
export const capabilitiesSchema = createRuntimeSchema(capabilitiesParser);
export const chatSnapshotSchema = createRuntimeSchema(chatSnapshotParser);
export const chatUpdateSchema = createRuntimeSchema(chatUpdateParser);

/** Stable identity used by Runtime upsert and deduplication. */
export const getTimelineItemKey = (item: TimelineItem): string =>
  item.kind === "message" ? `message:${item.id}` : `event:${item.id}`;

/**
 * Total ordering independent of arrival order. Updating an existing item does
 * not move it because updatedAt is deliberately excluded from this key.
 */
export const compareTimelineItems = (
  left: TimelineItem,
  right: TimelineItem,
): number => {
  const timestampOrder = left.createdAt - right.createdAt;
  if (timestampOrder !== 0) return timestampOrder;

  const sequenceOrder =
    (left.sequence ?? Number.MAX_SAFE_INTEGER) -
    (right.sequence ?? Number.MAX_SAFE_INTEGER);
  if (sequenceOrder !== 0) return sequenceOrder;

  const leftKey = getTimelineItemKey(left);
  const rightKey = getTimelineItemKey(right);
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
};

/**
 * Enforces the immutable envelope rule for event.transition.upsert. Runtime
 * ignores and reports conflicting updates instead of guessing an overwrite.
 */
export const hasCompatibleAgentEventMetadata = (
  event: AgentEvent,
  update: AgentEventTransitionUpdate,
): boolean =>
  event.conversationId === update.conversationId &&
  event.id === update.event.id &&
  event.eventCategory === update.event.eventCategory &&
  event.eventType === update.event.eventType &&
  (update.event.createdAt === undefined ||
    event.createdAt === update.event.createdAt) &&
  event.sequence === update.event.sequence;
