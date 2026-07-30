import { z } from "zod/v4";

const identifierSchema = z.union([
  z.number().finite(),
  z.string().trim().min(1),
]);
const nullableStringSchema = z.string().nullable().optional();
const opaqueReasoningEntryDtoSchema = z
  .looseObject({
    correlation_id: z.string().nullable().optional(),
    kind: z.enum([
      "redacted_thinking",
      "tool_call_signature",
      "encrypted_content",
    ]),
    provider: z.string(),
  })
  .superRefine((value, context) => {
    if (typeof value["token"] === "string") return;
    context.addIssue({
      code: "custom",
      message: "Opaque reasoning entries require a string payload",
      path: ["token"],
    });
  });

const reasoningEntryDtoSchema = z.union([
  z.looseObject({
    reasoningContent: z.string(),
  }),
  z.looseObject({
    kind: z.literal("thinking"),
    provider: z.string().nullable().optional(),
    signature: z.string().nullable().optional(),
    text: z.string(),
  }),
  opaqueReasoningEntryDtoSchema,
]);

export const outboundMessageCreatorSchema = z.object({
  avatar: z.string().nullable().optional(),
  name: z.string().trim().min(1),
  uid: z.union([z.number().finite(), z.string().trim().min(1)]),
});

export const responseEnvelopeSchema = z.looseObject({
  code: z.number(),
  data: z.unknown(),
  message: z.string(),
});

export const conversationDtoSchema = z.looseObject({
  conversationId: identifierSchema,
  description: nullableStringSchema,
  title: z.string(),
  updateTimestamp: z.number().finite().nonnegative().optional(),
});

export const conversationPageDtoSchema = z.looseObject({
  conversations: z.array(conversationDtoSchema).nullable(),
  cursor: z.string().nullable().optional(),
});

export const messageCreatorDtoSchema = z.looseObject({
  avatar: nullableStringSchema,
  name: nullableStringSchema,
  uid: identifierSchema.nullable().optional(),
});

export const messageDtoSchema = z.looseObject({
  additionalKwargs: z.unknown().optional(),
  attachments: z.unknown().optional(),
  content: z.unknown(),
  conversationId: identifierSchema,
  createTimestamp: z.number().finite().nonnegative(),
  creator: messageCreatorDtoSchema.nullable().optional(),
  msgId: identifierSchema.nullable().optional(),
  msgType: z.string(),
  reasoningContent: z
    .union([z.string(), z.array(reasoningEntryDtoSchema)])
    .nullable()
    .optional(),
  role: z.string(),
  sequence: z.number().int().nonnegative().optional(),
});

export const eventDtoSchema = z.looseObject({
  content: z.unknown().optional(),
  conversationId: identifierSchema,
  createTimestamp: z.number().finite().nonnegative(),
  eventCreateTimestamp: z.number().finite().nonnegative().optional(),
  eventId: identifierSchema.nullable().optional(),
  eventScene: z.string(),
  exception: z.unknown().optional(),
  sequence: z.number().int().nonnegative().optional(),
  status: z.string(),
  transitionId: identifierSchema.optional(),
  transitionSequence: z.number().int().nonnegative().optional(),
});

export const historyDtoSchema = z.looseObject({
  cursor: z.string().nullable().optional(),
  events: z.array(eventDtoSchema).nullable(),
  messages: z.array(messageDtoSchema).nullable(),
});

export const statusDtoSchema = z.looseObject({
  startedAt: z.number().finite().nonnegative().optional(),
  taskId: identifierSchema.nullable().optional(),
  working: z.boolean(),
});

export const sendTextDtoSchema = z.looseObject({
  taskId: identifierSchema,
});

export const interruptDtoSchema = z.looseObject({
  taskId: identifierSchema,
});

export const chatErrorEventDtoSchema = z.looseObject({
  conversationId: identifierSchema,
  createTimestamp: z.number().finite().nonnegative().optional(),
  error: z.unknown(),
});

export const socketProtocolErrorDtoSchema = z.looseObject({
  message: z.unknown(),
  status: z.string().optional(),
});

export const stateChangedDtoSchema = z.looseObject({
  conversationId: identifierSchema,
  state: z.enum(["working", "idle"]),
  taskId: identifierSchema.nullable().optional(),
});

export type ConversationDto = z.infer<typeof conversationDtoSchema>;
export type EventDto = z.infer<typeof eventDtoSchema>;
export type HistoryDto = z.infer<typeof historyDtoSchema>;
export type MessageDto = z.infer<typeof messageDtoSchema>;
export type StatusDto = z.infer<typeof statusDtoSchema>;
