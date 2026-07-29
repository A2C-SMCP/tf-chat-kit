import { z } from "zod/v4";

import {
  ASK_USER_MAX_ANSWER_VALUES,
  ASK_USER_MAX_OPTIONS,
  ASK_USER_MAX_QUESTIONS,
  ASK_USER_MAX_QUESTION_ID_CHARACTERS,
  ASK_USER_MAX_REQUEST_ID_CHARACTERS,
  ASK_USER_MAX_TEXT_CHARACTERS,
  isAskUserInteractionValueCompatible,
  isSafeAskUserQuestionId,
} from "./ask-user.js";
import type {
  AgentEvent,
  AgentEventTransition,
  AgentEventTransitionPayload,
  AskUserInteractionAnswer,
  AskUserInteractionOption,
  AskUserInteractionQuestion,
  AskUserInteractionRequest,
  AskUserInteractionResult,
  AskUserInteractionValue,
  Capabilities,
  ChatError,
  ChatSnapshot,
  ChatUpdate,
  Conversation,
  ContactMessageContent,
  FileMessageContent,
  GenericAgentEvent,
  GenericAgentEventTransitionPayload,
  MediaMessageContent,
  Message,
  MessageAuthor,
  MessageContent,
  Run,
  ToolAgentEvent,
  ToolAgentEventTransitionPayload,
  ToolCall,
  ToolEventTransition,
  ToolReturn,
  TimelineItem,
  TimelinePageInfo,
  UnknownEvent,
} from "./models.js";
import { compareAgentEventTransitions } from "./ordering.js";
import { sanitizeDiagnosticText, sanitizeRaw } from "./raw.js";

const idParser = z.string().min(1);
const timestampParser = z.number().finite().nonnegative();
const sequenceParser = z.number().int().nonnegative();
const rawParser = z.unknown().transform((input, context) => {
  try {
    return sanitizeRaw(input);
  } catch (error) {
    context.addIssue({
      code: "custom",
      message: error instanceof Error ? error.message : "raw data is invalid",
    });
    return z.NEVER;
  }
});

export const conversationParser: z.ZodType<Conversation> = z.object({
  id: idParser,
  title: z.string(),
  description: z.string().optional(),
  updatedAt: timestampParser.optional(),
  raw: rawParser.optional(),
});

const messageContentParser: z.ZodType<MessageContent> = z.discriminatedUnion(
  "kind",
  [
    z.object({ kind: z.literal("text"), text: z.string() }),
    z.object({
      kind: z.literal("media"),
      mediaType: z.enum(["audio", "image", "video"]),
      summary: z.string(),
      raw: rawParser.optional(),
    }) satisfies z.ZodType<MediaMessageContent>,
    z.object({
      kind: z.literal("file"),
      summary: z.string(),
      raw: rawParser.optional(),
    }) satisfies z.ZodType<FileMessageContent>,
    z.object({
      kind: z.literal("contact"),
      summary: z.string(),
      raw: rawParser.optional(),
    }) satisfies z.ZodType<ContactMessageContent>,
    z.object({
      kind: z.literal("url"),
      summary: z.string(),
      raw: rawParser.optional(),
    }),
    z.object({
      kind: z.literal("unknown"),
      summary: z.string(),
      raw: rawParser.optional(),
    }),
  ],
);

const messageAuthorParser: z.ZodType<MessageAuthor> = z.object({
  id: z.string().optional(),
  displayName: z.string().optional(),
  avatarUrl: z.string().optional(),
});

export const chatErrorParser: z.ZodType<ChatError> = z.object({
  code: z.enum([
    "authentication",
    "authorization",
    "conflict",
    "network",
    "not-found",
    "server",
    "timeout",
    "unknown",
    "unsupported",
    "validation",
  ]),
  message: z.string().transform(sanitizeDiagnosticText),
  retryable: z.boolean(),
  conversationId: idParser.optional(),
  details: rawParser.optional(),
});

const validateErrorConversation = (
  error: ChatError | undefined,
  expectedConversationId: string,
  path: readonly PropertyKey[],
  context: z.RefinementCtx,
): void => {
  if (
    error?.conversationId !== undefined &&
    error.conversationId !== expectedConversationId
  ) {
    context.addIssue({
      code: "custom",
      path: [...path, "conversationId"],
      message: "error must belong to the containing conversation",
    });
  }
};

export const messageParser: z.ZodType<Message> = z.object({
  kind: z.literal("message"),
  id: idParser,
  conversationId: idParser,
  role: z.enum(["assistant", "system", "tool", "unknown", "user"]),
  content: messageContentParser,
  createdAt: timestampParser,
  updatedAt: timestampParser.optional(),
  sequence: sequenceParser.optional(),
  author: messageAuthorParser.optional(),
  reasoning: z.string().optional(),
  raw: rawParser.optional(),
});

const agentEventStatusParser = z.enum([
  "aborted",
  "failed",
  "running",
  "success",
  "timeout",
  "unknown",
]);

const agentEventTransitionParser: z.ZodType<AgentEventTransition> = z.object({
  id: idParser,
  status: agentEventStatusParser,
  occurredAt: timestampParser,
  sequence: sequenceParser.optional(),
  summary: z.string().optional(),
  error: chatErrorParser.optional(),
  raw: rawParser.optional(),
});

const toolCallParser: z.ZodType<ToolCall> = z.object({
  id: idParser.optional(),
  name: z.string().min(1),
  description: z.string().optional(),
  arguments: rawParser.optional(),
  index: sequenceParser.optional(),
});

const toolReturnParser = z
  .object({
    result: rawParser.optional(),
    success: z.boolean().optional(),
    done: z.boolean().optional(),
    raw: rawParser.optional(),
  })
  .refine(
    (toolReturn) =>
      toolReturn.result !== undefined ||
      toolReturn.success !== undefined ||
      toolReturn.done !== undefined ||
      toolReturn.raw !== undefined,
    { message: "tool returns must preserve at least one field" },
  ) as z.ZodType<ToolReturn>;

const askUserInteractionOptionParser: z.ZodType<AskUserInteractionOption> =
  z.object({
    label: z.string().min(1).max(ASK_USER_MAX_TEXT_CHARACTERS),
    value: z.string().max(ASK_USER_MAX_TEXT_CHARACTERS),
    description: z.string().max(ASK_USER_MAX_TEXT_CHARACTERS).optional(),
  });

const askUserInteractionValueParser: z.ZodType<AskUserInteractionValue> =
  z.union([
    z.string().max(ASK_USER_MAX_TEXT_CHARACTERS),
    z
      .array(z.string().max(ASK_USER_MAX_TEXT_CHARACTERS))
      .max(ASK_USER_MAX_ANSWER_VALUES),
  ]);

const askUserInteractionQuestionIdParser = idParser
  .max(ASK_USER_MAX_QUESTION_ID_CHARACTERS)
  .refine(isSafeAskUserQuestionId, {
    message: "Ask User question IDs must not use reserved object keys",
  });

const askUserInteractionRequestIdParser = idParser.max(
  ASK_USER_MAX_REQUEST_ID_CHARACTERS,
);

const askUserInteractionAnswersParser = z.preprocess(
  (value, context) => {
    if (
      value !== null &&
      typeof value === "object" &&
      Reflect.ownKeys(value).some(
        (key) => typeof key === "string" && !isSafeAskUserQuestionId(key),
      )
    ) {
      context.addIssue({
        code: "custom",
        message: "Ask User answer keys must not use reserved object keys",
      });
      return z.NEVER;
    }
    return value;
  },
  z
    .record(askUserInteractionQuestionIdParser, askUserInteractionValueParser)
    .refine(
      (answers) => Object.keys(answers).length <= ASK_USER_MAX_QUESTIONS,
      { message: "Ask User answers exceed the question budget" },
    ),
) as z.ZodType<Readonly<Record<string, AskUserInteractionValue>>>;

const askUserInteractionQuestionParser: z.ZodType<AskUserInteractionQuestion> =
  z
    .object({
      id: askUserInteractionQuestionIdParser,
      prompt: z.string().min(1).max(ASK_USER_MAX_TEXT_CHARACTERS),
      title: z.string().max(ASK_USER_MAX_TEXT_CHARACTERS).optional(),
      description: z.string().max(ASK_USER_MAX_TEXT_CHARACTERS).optional(),
      placeholder: z.string().max(ASK_USER_MAX_TEXT_CHARACTERS).optional(),
      required: z.boolean(),
      multiple: z.boolean(),
      defaultValue: askUserInteractionValueParser.optional(),
      options: z
        .array(askUserInteractionOptionParser)
        .max(ASK_USER_MAX_OPTIONS),
    })
    .superRefine((question, context) => {
      if (
        new Set(question.options.map((option) => option.value)).size !==
        question.options.length
      ) {
        context.addIssue({
          code: "custom",
          path: ["options"],
          message: "Ask User option values must be unique within a question",
        });
      }
    });

const askUserInteractionQuestionsParser = z
  .array(askUserInteractionQuestionParser)
  .min(1)
  .max(ASK_USER_MAX_QUESTIONS)
  .refine(
    (questions) =>
      new Set(questions.map((question) => question.id)).size ===
      questions.length,
    { message: "Ask User question IDs must be unique" },
  );

const askUserInteractionRequestQuestionsParser =
  askUserInteractionQuestionsParser.superRefine((questions, context) => {
    questions.forEach((question, index) => {
      if (question.multiple && question.options.length === 0) {
        context.addIssue({
          code: "custom",
          path: [index, "options"],
          message: "multi-select Ask User requests require options",
        });
      }
      if (
        question.defaultValue !== undefined &&
        !isAskUserInteractionValueCompatible(question, question.defaultValue)
      ) {
        context.addIssue({
          code: "custom",
          path: [index, "defaultValue"],
          message: "Ask User default value must match its question",
        });
      }
    });
  });

export const askUserInteractionRequestParser: z.ZodType<AskUserInteractionRequest> =
  z.object({
    kind: z.literal("ask-user"),
    conversationId: idParser,
    requestId: askUserInteractionRequestIdParser,
    revision: askUserInteractionRequestIdParser,
    eventId: askUserInteractionRequestIdParser.optional(),
    title: z.string().min(1).max(ASK_USER_MAX_TEXT_CHARACTERS),
    questions: askUserInteractionRequestQuestionsParser,
    timeoutSeconds: z.number().finite().positive().optional(),
  });

export const askUserInteractionAnswerParser: z.ZodType<AskUserInteractionAnswer> =
  z.object({
    requestId: askUserInteractionRequestIdParser,
    revision: askUserInteractionRequestIdParser,
    action: z.enum(["cancel", "submit"]),
    answers: askUserInteractionAnswersParser,
  });

export const askUserInteractionResultParser: z.ZodType<AskUserInteractionResult> =
  z.object({
    kind: z.literal("ask-user"),
    requestId: askUserInteractionRequestIdParser,
    revision: askUserInteractionRequestIdParser.optional(),
    status: z.enum([
      "answered",
      "cancelled",
      "chat-about-this",
      "failed",
      "timeout",
    ]),
    questions: askUserInteractionQuestionsParser,
    answers: askUserInteractionAnswersParser.optional(),
    error: z.string().max(ASK_USER_MAX_TEXT_CHARACTERS).optional(),
  });

const toolEventTransitionParser: z.ZodType<ToolEventTransition> = z
  .object({
    id: idParser,
    status: agentEventStatusParser,
    occurredAt: timestampParser,
    sequence: sequenceParser.optional(),
    summary: z.string().optional(),
    error: chatErrorParser.optional(),
    raw: rawParser.optional(),
    toolCall: toolCallParser.optional(),
    toolReturn: toolReturnParser.optional(),
    interaction: askUserInteractionResultParser.optional(),
  })
  .superRefine((transition, context) => {
    if (
      transition.toolCall === undefined &&
      transition.toolReturn === undefined &&
      transition.interaction === undefined
    ) {
      context.addIssue({
        code: "custom",
        message:
          "tool transitions must preserve a tool call, tool return, or interaction",
      });
    }
  });

const agentEventBaseShape = {
  kind: z.literal("agent-event"),
  id: idParser,
  conversationId: idParser,
  eventType: z.string().min(1),
  status: agentEventStatusParser,
  createdAt: timestampParser,
  updatedAt: timestampParser.optional(),
  sequence: sequenceParser.optional(),
  summary: z.string().optional(),
  raw: rawParser.optional(),
};

export const agentEventParser: z.ZodType<AgentEvent> = z
  .discriminatedUnion("eventCategory", [
    z.object({
      ...agentEventBaseShape,
      eventCategory: z.literal("generic"),
      transitions: z.array(agentEventTransitionParser).min(1),
    }) satisfies z.ZodType<GenericAgentEvent>,
    z.object({
      ...agentEventBaseShape,
      eventCategory: z.literal("tool"),
      transitions: z.array(toolEventTransitionParser).min(1),
    }) satisfies z.ZodType<ToolAgentEvent>,
  ])
  .superRefine((event, context) => {
    const latestTransition = event.transitions.at(-1)!;
    if (latestTransition.status !== event.status) {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "event status must match the latest transition",
      });
    }

    const transitionIds = new Set<string>();
    event.transitions.forEach((transition, index) => {
      const previousTransition = event.transitions[index - 1];
      if (
        previousTransition !== undefined &&
        compareAgentEventTransitions(previousTransition, transition) > 0
      ) {
        context.addIssue({
          code: "custom",
          path: ["transitions", index],
          message: "event transitions must be chronologically ordered",
        });
      }

      if (transitionIds.has(transition.id)) {
        context.addIssue({
          code: "custom",
          path: ["transitions", index, "id"],
          message: "event transition IDs must be unique",
        });
      }
      transitionIds.add(transition.id);

      validateErrorConversation(
        transition.error,
        event.conversationId,
        ["transitions", index, "error"],
        context,
      );
    });

    if (
      event.eventCategory === "tool" &&
      !event.transitions.some(
        (transition) =>
          transition.toolCall !== undefined ||
          transition.toolReturn !== undefined ||
          transition.interaction !== undefined,
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["transitions"],
        message:
          "tool events must preserve a tool call, tool return, or interaction",
      });
    }
  });

const agentEventTransitionPayloadBaseShape = {
  id: idParser,
  eventType: z.string().min(1),
  createdAt: timestampParser,
  sequence: sequenceParser.optional(),
};

const agentEventTransitionPayloadParser: z.ZodType<AgentEventTransitionPayload> =
  z.discriminatedUnion("eventCategory", [
    z.object({
      ...agentEventTransitionPayloadBaseShape,
      eventCategory: z.literal("generic"),
      transition: agentEventTransitionParser,
    }) satisfies z.ZodType<GenericAgentEventTransitionPayload>,
    z.object({
      ...agentEventTransitionPayloadBaseShape,
      eventCategory: z.literal("tool"),
      transition: toolEventTransitionParser,
    }) satisfies z.ZodType<ToolAgentEventTransitionPayload>,
  ]);

export const unknownEventParser: z.ZodType<UnknownEvent> = z.object({
  kind: z.literal("unknown-event"),
  id: idParser,
  conversationId: idParser,
  originalType: z.string().min(1),
  createdAt: timestampParser,
  updatedAt: timestampParser.optional(),
  sequence: sequenceParser.optional(),
  summary: z.string(),
  raw: rawParser.optional(),
});

export const timelineItemParser: z.ZodType<TimelineItem> = z.union([
  messageParser,
  agentEventParser,
  unknownEventParser,
]);

export const runParser: z.ZodType<Run> = z
  .object({
    id: idParser,
    conversationId: idParser,
    status: z.enum(["aborted", "failed", "running", "succeeded", "unknown"]),
    canInterrupt: z.boolean(),
    startedAt: timestampParser.optional(),
    finishedAt: timestampParser.optional(),
    error: chatErrorParser.optional(),
  })
  .superRefine((run, context) => {
    validateErrorConversation(
      run.error,
      run.conversationId,
      ["error"],
      context,
    );
  });

export const capabilitiesParser: z.ZodType<Capabilities> = z.object({
  answerInteraction: z.boolean().optional(),
  interrupt: z.boolean(),
  listConversations: z.boolean(),
  liveUpdates: z.boolean(),
  loadHistory: z.boolean(),
  sendText: z.boolean(),
});

const timelinePageInfoParser: z.ZodType<TimelinePageInfo> = z.object({
  previousCursor: z.string().optional(),
  hasPreviousPage: z.boolean(),
});

export const chatSnapshotParser: z.ZodType<ChatSnapshot> = z
  .object({
    conversation: conversationParser,
    timeline: z.array(timelineItemParser),
    run: runParser.nullable(),
    capabilities: capabilitiesParser,
    pageInfo: timelinePageInfoParser,
    pendingInteraction: askUserInteractionRequestParser.optional(),
    error: chatErrorParser.optional(),
  })
  .superRefine((snapshot, context) => {
    snapshot.timeline.forEach((item, index) => {
      if (item.conversationId !== snapshot.conversation.id) {
        context.addIssue({
          code: "custom",
          path: ["timeline", index, "conversationId"],
          message: "timeline item must belong to the snapshot conversation",
        });
      }
    });
    if (
      snapshot.run !== null &&
      snapshot.run.conversationId !== snapshot.conversation.id
    ) {
      context.addIssue({
        code: "custom",
        path: ["run", "conversationId"],
        message: "run must belong to the snapshot conversation",
      });
    }
    validateErrorConversation(
      snapshot.error,
      snapshot.conversation.id,
      ["error"],
      context,
    );
    if (
      snapshot.pendingInteraction !== undefined &&
      snapshot.pendingInteraction.conversationId !== snapshot.conversation.id
    ) {
      context.addIssue({
        code: "custom",
        path: ["pendingInteraction", "conversationId"],
        message: "pending interaction must belong to the snapshot conversation",
      });
    }
  });

export const chatUpdateParser: z.ZodType<ChatUpdate> = z
  .discriminatedUnion("kind", [
    z.object({
      kind: z.literal("snapshot.replace"),
      snapshot: chatSnapshotParser,
    }),
    z.object({
      kind: z.literal("conversation.upsert"),
      conversation: conversationParser,
    }),
    z.object({
      kind: z.literal("timeline.upsert"),
      conversationId: idParser,
      item: timelineItemParser,
    }),
    z.object({
      kind: z.literal("event.transition.upsert"),
      conversationId: idParser,
      event: agentEventTransitionPayloadParser,
    }),
    z.object({
      kind: z.literal("run.replace"),
      conversationId: idParser,
      run: runParser.nullable(),
    }),
    z.object({
      kind: z.literal("capabilities.replace"),
      conversationId: idParser,
      capabilities: capabilitiesParser,
    }),
    z.object({
      kind: z.literal("interaction.replace"),
      conversationId: idParser,
      interaction: askUserInteractionRequestParser.nullable(),
    }),
    z.object({
      kind: z.literal("error.reported"),
      conversationId: idParser.optional(),
      error: chatErrorParser,
    }),
  ])
  .superRefine((update, context) => {
    if (
      update.kind === "timeline.upsert" &&
      update.item.conversationId !== update.conversationId
    ) {
      context.addIssue({
        code: "custom",
        path: ["item", "conversationId"],
        message: "timeline item must belong to the updated conversation",
      });
    }
    if (
      update.kind === "run.replace" &&
      update.run !== null &&
      update.run.conversationId !== update.conversationId
    ) {
      context.addIssue({
        code: "custom",
        path: ["run", "conversationId"],
        message: "run must belong to the updated conversation",
      });
    }
    if (
      update.kind === "interaction.replace" &&
      update.interaction !== null &&
      update.interaction.conversationId !== update.conversationId
    ) {
      context.addIssue({
        code: "custom",
        path: ["interaction", "conversationId"],
        message: "interaction must belong to the updated conversation",
      });
    }
    if (
      update.kind === "error.reported" &&
      update.conversationId !== undefined
    ) {
      validateErrorConversation(
        update.error,
        update.conversationId,
        ["error"],
        context,
      );
    }
    if (update.kind === "event.transition.upsert") {
      validateErrorConversation(
        update.event.transition.error,
        update.conversationId,
        ["event", "transition", "error"],
        context,
      );
    }
  });
