import {
  agentEventSchema,
  chatErrorSchema,
  chatSnapshotSchema,
  chatUpdateSchema,
  compareAgentEventTransitions,
  compareTimelineItems,
  conversationSchema,
  messageSchema,
  sanitizeDiagnosticText,
  sanitizeRaw,
  unknownEventSchema,
  type AgentEvent,
  type AgentEventStatus,
  type AgentEventTransition,
  type ChatError,
  type ChatSnapshot,
  type ChatUpdate,
  type Conversation,
  type Message,
  type MessageContent,
  type MessageRole,
  type ReadonlyJsonValue,
  type Run,
  type ToolEventTransition,
  type ToolReturn,
} from "@turingfocus/chat-protocol";

import type {
  ConversationDto,
  EventDto,
  HistoryDto,
  MessageDto,
  StatusDto,
} from "./dto.js";

export const TFROBOT_CAPABILITIES = Object.freeze({
  interrupt: true,
  listConversations: true,
  liveUpdates: true,
  loadHistory: true,
  sendText: true,
});

const asId = (value: number | string): string => String(value);

export const syntheticRunId = (conversationId: string): string =>
  `run:${conversationId}:active`;

const safeRaw = (value: unknown): ReadonlyJsonValue | undefined => {
  try {
    return sanitizeRaw(value);
  } catch {
    return undefined;
  }
};

const optionalRaw = (
  value: unknown,
): { readonly raw?: ReadonlyJsonValue | undefined } => {
  const raw = safeRaw(value);
  return raw === undefined ? {} : { raw };
};

const extraRaw = (
  value: Record<string, unknown>,
  knownKeys: ReadonlySet<string>,
): { readonly raw?: ReadonlyJsonValue | undefined } => {
  const extras: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!knownKeys.has(key)) extras[key] = item;
  }
  return Object.keys(extras).length === 0 ? {} : optionalRaw(extras);
};

const CONVERSATION_KEYS = new Set([
  "conversationId",
  "description",
  "title",
  "updateTimestamp",
]);
const MESSAGE_KEYS = new Set([
  "additionalKwargs",
  "attachments",
  "content",
  "conversationId",
  "createTimestamp",
  "creator",
  "msgId",
  "msgType",
  "reasoningContent",
  "role",
  "sequence",
]);
const EVENT_KEYS = new Set([
  "content",
  "conversationId",
  "createTimestamp",
  "eventCreateTimestamp",
  "eventId",
  "eventScene",
  "exception",
  "sequence",
  "status",
  "transitionId",
  "transitionSequence",
]);

const messageRaw = (
  dto: MessageDto,
): { readonly raw?: ReadonlyJsonValue | undefined } => {
  const raw: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(dto)) {
    if (!MESSAGE_KEYS.has(key)) raw[key] = value;
  }
  if (!isEmptyRecord(dto.additionalKwargs)) {
    raw["additionalKwargs"] = dto.additionalKwargs;
  }
  if (dto.attachments != null) raw["attachments"] = dto.attachments;
  if (Array.isArray(dto.reasoningContent)) {
    raw["reasoningContent"] = dto.reasoningContent;
  }
  return Object.keys(raw).length === 0 ? {} : optionalRaw(raw);
};

const reasoningText = (dto: MessageDto): string | undefined => {
  if (typeof dto.reasoningContent === "string") return dto.reasoningContent;
  if (!Array.isArray(dto.reasoningContent)) return undefined;
  const thinking = dto.reasoningContent.flatMap((entry) => {
    const frozenText = entry["reasoningContent"];
    if (typeof frozenText === "string" && frozenText.length > 0) {
      return [frozenText];
    }
    const currentText = entry["text"];
    return entry["kind"] === "thinking" &&
      typeof currentText === "string" &&
      currentText.length > 0
      ? [currentText]
      : [];
  });
  return thinking.length === 0 ? undefined : thinking.join("\n\n");
};

const summaryOf = (value: unknown, fallback: string): string => {
  if (typeof value === "string" && value.trim().length > 0) {
    return sanitizeDiagnosticText(value);
  }
  return fallback;
};

export const mapConversation = (dto: ConversationDto): Conversation =>
  conversationSchema.parse({
    id: asId(dto.conversationId),
    title: dto.title,
    ...(dto.description == null ? {} : { description: dto.description }),
    ...(dto.updateTimestamp === undefined
      ? {}
      : { updatedAt: dto.updateTimestamp }),
    ...extraRaw(dto, CONVERSATION_KEYS),
  });

const mapRole = (role: string): MessageRole => {
  switch (role.toLocaleLowerCase("en-US")) {
    case "assistant":
    case "system":
    case "tool":
    case "user":
      return role.toLocaleLowerCase("en-US") as MessageRole;
    default:
      return "unknown";
  }
};

const mapMessageContent = (dto: MessageDto): MessageContent => {
  const type = dto.msgType.toLocaleLowerCase("en-US");
  if (type === "text" && typeof dto.content === "string") {
    return { kind: "text", text: dto.content };
  }
  if (type === "audio" || type === "image" || type === "video") {
    return {
      kind: "media",
      mediaType: type,
      summary: summaryOf(dto.content, `${type} message`),
      ...optionalRaw({
        content: dto.content,
        attachments: dto.attachments,
        additionalKwargs: dto.additionalKwargs,
      }),
    };
  }
  if (type === "file") {
    return {
      kind: "file",
      summary: summaryOf(dto.content, "File message"),
      ...optionalRaw({
        content: dto.content,
        attachments: dto.attachments,
        additionalKwargs: dto.additionalKwargs,
      }),
    };
  }
  if (type === "contact") {
    return {
      kind: "contact",
      summary: summaryOf(dto.content, "Contact message"),
      ...optionalRaw({ content: dto.content }),
    };
  }
  if (type === "url") {
    return {
      kind: "url",
      summary: summaryOf(dto.content, "URL message"),
      ...optionalRaw({ content: dto.content }),
    };
  }
  return {
    kind: "unknown",
    summary: summaryOf(dto.content, `Unsupported message type: ${dto.msgType}`),
    ...optionalRaw({
      msgType: dto.msgType,
      content: dto.content,
      attachments: dto.attachments,
      additionalKwargs: dto.additionalKwargs,
    }),
  };
};

export const mapMessage = (dto: MessageDto): Message => {
  const reasoning = reasoningText(dto);
  return messageSchema.parse({
    kind: "message",
    id:
      dto.msgId == null
        ? `message:${asId(dto.conversationId)}:${dto.createTimestamp}`
        : asId(dto.msgId),
    conversationId: asId(dto.conversationId),
    role: mapRole(dto.role),
    content: mapMessageContent(dto),
    createdAt: dto.createTimestamp,
    ...(dto.sequence === undefined ? {} : { sequence: dto.sequence }),
    ...(dto.creator == null
      ? {}
      : {
          author: {
            ...(dto.creator.uid == null ? {} : { id: asId(dto.creator.uid) }),
            ...(dto.creator.name == null
              ? {}
              : { displayName: dto.creator.name }),
            ...(dto.creator.avatar == null
              ? {}
              : { avatarUrl: dto.creator.avatar }),
          },
        }),
    ...(reasoning === undefined ? {} : { reasoning }),
    ...messageRaw(dto),
  });
};

function isEmptyRecord(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === 0
  );
}

const mapEventStatus = (status: string): AgentEventStatus => {
  switch (status.toLocaleLowerCase("en-US")) {
    case "aborted":
    case "failed":
    case "running":
    case "success":
    case "timeout":
      return status.toLocaleLowerCase("en-US") as AgentEventStatus;
    default:
      return "unknown";
  }
};

const parseJsonIfPossible = (value: unknown): unknown => {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const eventIdentity = (dto: EventDto): string =>
  dto.eventId == null
    ? `event:${asId(dto.conversationId)}:${dto.createTimestamp}:${dto.eventScene}`
    : asId(dto.eventId);

const mapEventError = (dto: EventDto): ChatError | undefined => {
  if (dto.exception == null) return undefined;
  return chatErrorSchema.parse({
    code: "server",
    message: summaryOf(dto.exception, "TFRobot event failed"),
    retryable: false,
    conversationId: asId(dto.conversationId),
    ...optionalRaw({ exception: dto.exception }),
  });
};

const mapToolTransition = (
  dto: EventDto,
  transitionId: string,
): ToolEventTransition | undefined => {
  if (!isRecord(dto.content)) return undefined;
  const toolCallValue = dto.content["toolCall"];
  const toolReturnValue = dto.content["toolReturn"];
  const toolCall = isRecord(toolCallValue) ? toolCallValue : undefined;
  const functionCall = isRecord(toolCall?.["functionCall"])
    ? toolCall["functionCall"]
    : undefined;
  const name = functionCall?.["name"];
  const toolReturn = isRecord(toolReturnValue) ? toolReturnValue : undefined;
  const meta = isRecord(toolReturn?.["meta"]) ? toolReturn["meta"] : undefined;
  const normalizedToolCall =
    typeof name === "string" && name.length > 0
      ? {
          ...(toolCall?.["toolId"] == null
            ? {}
            : { id: asId(toolCall["toolId"] as number | string) }),
          name,
          ...(typeof functionCall?.["description"] === "string"
            ? { description: functionCall["description"] }
            : {}),
          ...(functionCall?.["parameters"] === undefined
            ? {}
            : {
                arguments: safeRaw(
                  parseJsonIfPossible(functionCall["parameters"]),
                ),
              }),
          ...(typeof toolCall?.["index"] === "number"
            ? { index: toolCall["index"] }
            : {}),
        }
      : undefined;
  const result =
    toolReturn?.["origin"] === undefined
      ? undefined
      : safeRaw(toolReturn["origin"]);
  const success =
    typeof meta?.["success"] === "boolean" ? meta["success"] : undefined;
  const done = typeof meta?.["done"] === "boolean" ? meta["done"] : undefined;
  let normalizedToolReturn: ToolReturn | undefined;
  if (result !== undefined) {
    normalizedToolReturn = {
      result,
      ...(success === undefined ? {} : { success }),
      ...(done === undefined ? {} : { done }),
      ...optionalRaw(toolReturn),
    };
  } else if (success !== undefined) {
    normalizedToolReturn = {
      success,
      ...(done === undefined ? {} : { done }),
      ...optionalRaw(toolReturn),
    };
  } else if (done !== undefined) {
    normalizedToolReturn = {
      done,
      ...optionalRaw(toolReturn),
    };
  }
  if (normalizedToolCall === undefined && normalizedToolReturn === undefined) {
    return undefined;
  }
  return {
    id: transitionId,
    status: mapEventStatus(dto.status),
    occurredAt: dto.createTimestamp,
    ...(dto.transitionSequence === undefined
      ? {}
      : { sequence: dto.transitionSequence }),
    ...(mapEventError(dto) === undefined ? {} : { error: mapEventError(dto) }),
    ...(normalizedToolCall === undefined
      ? {}
      : { toolCall: normalizedToolCall }),
    ...(normalizedToolReturn === undefined
      ? {}
      : { toolReturn: normalizedToolReturn }),
    ...extraRaw(dto, EVENT_KEYS),
  };
};

export const mapEvent = (dto: EventDto): AgentEvent => {
  const id = eventIdentity(dto);
  const transitionId =
    dto.transitionId === undefined
      ? `${id}:${dto.status}:${dto.createTimestamp}`
      : asId(dto.transitionId);
  const isTool = dto.eventScene.toLocaleLowerCase("en-US") === "tool";
  const toolTransition = isTool
    ? mapToolTransition(dto, transitionId)
    : undefined;
  if (isTool && toolTransition === undefined) {
    return agentEventSchema.parse({
      kind: "agent-event",
      eventCategory: "generic",
      id,
      conversationId: asId(dto.conversationId),
      eventType: dto.eventScene,
      status: mapEventStatus(dto.status),
      createdAt: dto.eventCreateTimestamp ?? dto.createTimestamp,
      ...(dto.sequence === undefined ? {} : { sequence: dto.sequence }),
      transitions: [
        {
          id: transitionId,
          status: mapEventStatus(dto.status),
          occurredAt: dto.createTimestamp,
          ...(dto.transitionSequence === undefined
            ? {}
            : { sequence: dto.transitionSequence }),
          summary: "Tool event payload could not be normalized",
          ...(mapEventError(dto) === undefined
            ? {}
            : { error: mapEventError(dto) }),
          ...extraRaw(dto, EVENT_KEYS),
        },
      ],
      summary: "Tool event payload could not be normalized",
      ...extraRaw(dto, EVENT_KEYS),
    });
  }
  const transition: AgentEventTransition | ToolEventTransition =
    toolTransition ?? {
      id: transitionId,
      status: mapEventStatus(dto.status),
      occurredAt: dto.createTimestamp,
      ...(dto.transitionSequence === undefined
        ? {}
        : { sequence: dto.transitionSequence }),
      ...(typeof dto.content === "string"
        ? { summary: sanitizeDiagnosticText(dto.content) }
        : {}),
      ...(mapEventError(dto) === undefined
        ? {}
        : { error: mapEventError(dto) }),
      ...extraRaw(dto, EVENT_KEYS),
    };
  return agentEventSchema.parse({
    kind: "agent-event",
    eventCategory: toolTransition === undefined ? "generic" : "tool",
    id,
    conversationId: asId(dto.conversationId),
    eventType: dto.eventScene,
    status: transition.status,
    createdAt: dto.eventCreateTimestamp ?? dto.createTimestamp,
    ...(dto.sequence === undefined ? {} : { sequence: dto.sequence }),
    transitions: [transition],
    ...(transition.summary === undefined
      ? {}
      : { summary: transition.summary }),
    ...extraRaw(dto, EVENT_KEYS),
  });
};

const mergeEvents = (events: readonly AgentEvent[]): readonly AgentEvent[] => {
  const merged = new Map<string, AgentEvent>();
  for (const event of events) {
    const current = merged.get(event.id);
    if (
      current === undefined ||
      current.eventCategory !== event.eventCategory ||
      current.eventType !== event.eventType
    ) {
      merged.set(event.id, event);
      continue;
    }
    const transitions = new Map(
      current.transitions.map((transition) => [transition.id, transition]),
    );
    for (const transition of event.transitions) {
      transitions.set(transition.id, transition);
    }
    const ordered = [...transitions.values()].sort(
      compareAgentEventTransitions,
    );
    const latest = ordered.at(-1)!;
    merged.set(
      event.id,
      agentEventSchema.parse({
        ...current,
        status: latest.status,
        transitions: ordered,
        ...(latest.summary === undefined ? {} : { summary: latest.summary }),
      }),
    );
  }
  return [...merged.values()];
};

export const mapRun = (conversationId: string, dto: StatusDto): Run | null => {
  if (!dto.working) return null;
  const hasTransportTaskId = dto.taskId != null;
  return {
    id: dto.taskId == null ? syntheticRunId(conversationId) : asId(dto.taskId),
    conversationId,
    status: "running",
    canInterrupt: hasTransportTaskId,
    ...(dto.startedAt === undefined ? {} : { startedAt: dto.startedAt }),
  };
};

export const mapSnapshot = (
  conversation: Conversation,
  history: HistoryDto,
  status: StatusDto,
): ChatSnapshot => {
  const timeline = [
    ...(history.messages ?? []).map(mapMessage),
    ...mergeEvents((history.events ?? []).map(mapEvent)),
  ].sort(compareTimelineItems);
  return chatSnapshotSchema.parse({
    conversation,
    timeline,
    run: mapRun(conversation.id, status),
    capabilities: TFROBOT_CAPABILITIES,
    pageInfo: {
      hasPreviousPage: Boolean(history.cursor),
      ...(history.cursor == null || history.cursor.length === 0
        ? {}
        : { previousCursor: history.cursor }),
    },
  });
};

export const mapMessageUpdate = (dto: MessageDto): ChatUpdate =>
  chatUpdateSchema.parse({
    kind: "timeline.upsert",
    conversationId: asId(dto.conversationId),
    item: mapMessage(dto),
  });

export const mapEventUpdate = (dto: EventDto): ChatUpdate => {
  const event = mapEvent(dto);
  return chatUpdateSchema.parse({
    kind: "event.transition.upsert",
    conversationId: event.conversationId,
    event: {
      id: event.id,
      eventCategory: event.eventCategory,
      eventType: event.eventType,
      createdAt: event.createdAt,
      ...(event.sequence === undefined ? {} : { sequence: event.sequence }),
      transition: event.transitions[0]!,
    },
  });
};

export const mapUnknownSocketEvent = (
  eventName: string,
  payload: unknown,
  conversationId: string,
  now: number,
): ChatUpdate => {
  const safeEventName = sanitizeDiagnosticText(eventName);
  const record = isRecord(payload) ? payload : undefined;
  const idValue = record?.["id"] ?? record?.["eventId"];
  const createdAtValue = record?.["createTimestamp"];
  const summaryValue = record?.["summary"];
  const sequenceValue = record?.["sequence"];
  const payloadConversationId =
    record?.["conversationId"] ?? record?.["conversation_id"];
  const targetConversationId =
    typeof payloadConversationId === "string" ||
    typeof payloadConversationId === "number"
      ? String(payloadConversationId)
      : conversationId;
  const rawPayload =
    record === undefined
      ? payload
      : Object.fromEntries(
          Object.entries(record).filter(
            ([key]) =>
              key !== "id" &&
              key !== "eventId" &&
              key !== "conversationId" &&
              key !== "conversation_id" &&
              key !== "createTimestamp" &&
              key !== "summary" &&
              key !== "sequence",
          ),
        );
  return chatUpdateSchema.parse({
    kind: "timeline.upsert",
    conversationId: targetConversationId,
    item: unknownEventSchema.parse({
      kind: "unknown-event",
      id:
        typeof idValue === "string" || typeof idValue === "number"
          ? String(idValue)
          : `socket:${targetConversationId}:${safeEventName}:${now}`,
      conversationId: targetConversationId,
      originalType: safeEventName,
      createdAt:
        typeof createdAtValue === "number" && Number.isFinite(createdAtValue)
          ? createdAtValue
          : now,
      summary:
        typeof summaryValue === "string"
          ? sanitizeDiagnosticText(summaryValue)
          : `Unsupported realtime event: ${safeEventName}`,
      ...(typeof sequenceValue === "number" &&
      Number.isInteger(sequenceValue) &&
      sequenceValue >= 0
        ? { sequence: sequenceValue }
        : {}),
      ...optionalRaw(rawPayload),
    }),
  });
};
