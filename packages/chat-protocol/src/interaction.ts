import { z } from "zod/v4";

import {
  ASK_USER_MAX_REQUEST_ID_CHARACTERS,
  ASK_USER_MAX_TEXT_CHARACTERS,
} from "./ask-user.js";
import {
  askUserInteractionRequestSchema,
  type AskUserInteractionRequest,
  type InteractionHistory,
} from "./models.js";
import type { RemoteToolClock } from "./remote-tool.js";
import { createRuntimeSchema } from "./internal-runtime-schema.js";

/**
 * Interaction channel wire contract (ADR v7). The protocol owns normalized
 * models and validation only; transport event names stay in the Gateway.
 * Limits mirror tfrobotserver/interaction/dtos.py so valid Server frames are
 * never dropped by a tighter client cap.
 */
export const INTERACTION_PROTOCOL_VERSION = 1;
/** Capability marker negotiated by both hello directions. */
export const INTERACTION_VERSION = "interaction_v1";

export const INTERACTION_MAX_ID_CHARACTERS = 1_024;
export const INTERACTION_MAX_QUESTION_CHARACTERS = 32 * 1_024;
export const INTERACTION_MAX_ANSWER_CHARACTERS = 64 * 1_024;
export const INTERACTION_MAX_OPTION_VALUE_CHARACTERS = 1_024;
export const INTERACTION_MAX_OPTION_LABEL_CHARACTERS = 1_024;
export const INTERACTION_MAX_OPTION_DESCRIPTION_CHARACTERS = 4_096;
export const INTERACTION_MAX_OPTIONS = 50;
export const INTERACTION_MAX_SELECTED_OPTIONS = 50;
export const INTERACTION_MAX_DISPLAY_TEXT_CHARACTERS = 32 * 1_024;
/** Shared upload budget for early frames before a consumer attaches. */
export const INTERACTION_MAX_EARLY_FRAMES = 50;
/** Defensive envelope caps; the Server sends at most 10 pending interactions. */
export const INTERACTION_MAX_PENDING_ITEMS = 100;
export const INTERACTION_MAX_VERSIONS = 32;
/** Retained name for display text; the wire caps are the specific constants. */
export const INTERACTION_MAX_TEXT_CHARACTERS =
  INTERACTION_MAX_DISPLAY_TEXT_CHARACTERS;

export interface InteractionOption {
  readonly value: string;
  readonly label?: string | undefined;
  readonly description?: string | undefined;
}

export interface InteractionParticipant {
  readonly id: string;
  readonly name?: string | undefined;
  readonly avatar?: string | undefined;
}

export interface InteractionTarget {
  /** Closed set is human|agent; unknown values stay renderable. */
  readonly kind: string;
  readonly id?: string | undefined;
  readonly name?: string | undefined;
  readonly avatar?: string | undefined;
}

export interface InteractionRequest {
  readonly interactionId: string;
  readonly conversationId: string;
  readonly conversationTitle?: string | undefined;
  readonly robotId: string;
  readonly namespace: string;
  readonly requester: InteractionParticipant;
  readonly target: InteractionTarget;
  readonly question: string;
  readonly options?: readonly InteractionOption[] | undefined;
  readonly multiSelect: boolean;
  /** Remaining whole seconds captured when the request was emitted; display only. */
  readonly timeoutSeconds: number;
  /** Epoch milliseconds; the single authority for countdown and EDF. */
  readonly expiresAt: number;
  readonly callId?: string | undefined;
  readonly eventId?: string | undefined;
}

export type InteractionResponseStatus = "answered" | "cancelled";

/** Browser response input; option answers always carry option.value. */
export interface InteractionResponse {
  readonly interactionId: string;
  readonly status: InteractionResponseStatus;
  readonly answer?: string | undefined;
  /** option.value list; a single-select answer is still a one-element list. */
  readonly selectedOptions?: readonly string[] | undefined;
}

export type InteractionAckStatus =
  "accepted" | "already_closed" | "unknown_request";

export interface InteractionAck {
  readonly interactionId: string;
  readonly status: InteractionAckStatus;
}

export interface InteractionClosed {
  readonly interactionId: string;
  /** Closed set terminalReason is documented; unknown values stay renderable. */
  readonly terminalReason: string;
  readonly answeredBy?: string | undefined;
  readonly answeredAt?: number | undefined;
}

export interface InteractionServerHello {
  readonly versions: readonly string[];
  readonly robotId: string;
  readonly namespace: string;
}

export interface InteractionClientHello {
  readonly versions: readonly string[];
  readonly supportsAskUserAdapter: boolean;
}

export interface InteractionClientHelloPayload extends InteractionClientHello {
  readonly protocolVersion: number;
}

export type InteractionConnectionState = "connected" | "disconnected";

/**
 * Cross-frame synchronization signal. A malformed snapshot still means the
 * server reached a snapshot boundary, so consumers must leave any waiting
 * state without closing locally known interactions.
 */
export type InteractionPendingSnapshot =
  | {
      readonly kind: "snapshot";
      readonly requests: readonly InteractionRequest[];
      /** Every readable interactionId, including items that failed validation. */
      readonly knownIds: readonly string[];
    }
  | { readonly kind: "malformed" };

export interface InteractionTransportObserver {
  hello(hello: InteractionServerHello): void;
  pending(snapshot: InteractionPendingSnapshot): void;
  requested(request: InteractionRequest): void;
  closed(closed: InteractionClosed): void;
  connection(state: InteractionConnectionState): void;
  /** Optional sanitized diagnostic; never carries credentials or raw payloads. */
  diagnostic?(message: string, error?: unknown): void;
}

export interface InteractionTransportAttachment {
  /**
   * Sends one response on the shared channel. The callback receives a
   * validated ack, or undefined when the ack was missing, timed out or
   * invalid. It is invoked at most once.
   */
  respond(
    response: InteractionResponse,
    onAck: (ack: InteractionAck | undefined) => void,
  ): boolean;
  /** Detaches only this consumer; the transport keeps other consumers alive. */
  detach(): void;
}

/**
 * Alias used by the Issue text: the per-consumer channel handle is the
 * attachment returned by attachInteraction.
 */
export type InteractionChannel = InteractionTransportAttachment;

/**
 * Instance-scoped interaction channel consumed by Runtime. Attach may happen
 * before the socket connects; the transport buffers early frames until a
 * consumer is attached. Runtime never sees Socket.IO names or namespaces;
 * `namespace` is an opaque expected identity supplied by the implementation.
 */
export interface InteractionTransport {
  readonly clock: RemoteToolClock;
  /** Expected wire namespace, when the implementation can assert it. */
  readonly namespace?: string | undefined;
  attachInteraction(
    observer: InteractionTransportObserver,
  ): InteractionTransportAttachment;
  /** Optional explicit recovery after a terminal transport failure. */
  retry?(): void;
}

const optionalText = (maximum = INTERACTION_MAX_DISPLAY_TEXT_CHARACTERS) =>
  z
    .string()
    .max(maximum)
    .nullable()
    .optional()
    .transform((value) => value ?? undefined);

const optionalId = z
  .union([z.string().min(1).max(INTERACTION_MAX_ID_CHARACTERS), z.number()])
  .nullable()
  .optional()
  .transform((value) => (value == null ? undefined : String(value)));

const conversationId = z
  .union([
    z.string().min(1).max(INTERACTION_MAX_ID_CHARACTERS),
    z.number().finite(),
  ])
  .transform((value) => String(value));

const interactionOptionParser: z.ZodType<InteractionOption> = z.object({
  value: z.string().min(1).max(INTERACTION_MAX_OPTION_VALUE_CHARACTERS),
  label: optionalText(INTERACTION_MAX_OPTION_LABEL_CHARACTERS),
  description: optionalText(INTERACTION_MAX_OPTION_DESCRIPTION_CHARACTERS),
});

const interactionParticipantParser: z.ZodType<InteractionParticipant> =
  z.object({
    id: z.string().min(1).max(INTERACTION_MAX_ID_CHARACTERS),
    name: optionalText(),
    avatar: optionalText(),
  });

const interactionTargetParser: z.ZodType<InteractionTarget> = z.object({
  kind: z.string().min(1).max(INTERACTION_MAX_ID_CHARACTERS),
  id: optionalId,
  name: optionalText(),
  avatar: optionalText(),
});

const interactionRequestWireParser = z
  .object({
    protocolVersion: z.number(),
    interactionId: z.string().min(1).max(INTERACTION_MAX_ID_CHARACTERS),
    conversationId,
    conversationTitle: optionalText(),
    robotId: z.string().min(1).max(INTERACTION_MAX_ID_CHARACTERS),
    namespace: z.string().min(1).max(INTERACTION_MAX_ID_CHARACTERS),
    requester: interactionParticipantParser,
    target: interactionTargetParser,
    question: z.string().max(INTERACTION_MAX_QUESTION_CHARACTERS),
    options: z
      .array(interactionOptionParser)
      .max(INTERACTION_MAX_OPTIONS)
      .nullable()
      .optional()
      .transform((value) => value ?? undefined),
    multiSelect: z.boolean().default(false),
    timeoutSeconds: z.number().int().nonnegative(),
    expiresAt: z.number().int().nonnegative(),
    callId: optionalId,
    eventId: optionalId,
  })
  .transform(({ protocolVersion, ...request }) => {
    void protocolVersion;
    return request;
  });

export const interactionRequestSchema = createRuntimeSchema<InteractionRequest>(
  interactionRequestWireParser,
);

const interactionPendingEnvelopeWireParser = z.object({
  protocolVersion: z.number(),
  interactions: z.array(z.unknown()).max(INTERACTION_MAX_PENDING_ITEMS),
});

export const interactionPendingEnvelopeSchema = createRuntimeSchema<{
  readonly interactions: readonly unknown[];
}>(
  interactionPendingEnvelopeWireParser.transform(({ interactions }) => ({
    interactions,
  })),
);

const interactionHelloServerWireParser = z.object({
  protocolVersion: z.number(),
  versions: z
    .array(z.string().max(64))
    .max(INTERACTION_MAX_VERSIONS)
    .default([]),
  robotId: z.string().min(1).max(INTERACTION_MAX_ID_CHARACTERS),
  namespace: z.string().min(1).max(INTERACTION_MAX_ID_CHARACTERS),
});

export const interactionHelloServerSchema =
  createRuntimeSchema<InteractionServerHello>(
    interactionHelloServerWireParser.transform(
      ({ versions, robotId, namespace }) => ({ versions, robotId, namespace }),
    ),
  );

export const interactionHelloClientPayloadSchema =
  createRuntimeSchema<InteractionClientHelloPayload>(
    z.object({
      protocolVersion: z.number(),
      versions: z.array(z.string().max(64)).max(INTERACTION_MAX_VERSIONS),
      supportsAskUserAdapter: z.boolean(),
    }),
  );

const interactionResponseWireParser = z.object({
  protocolVersion: z.number(),
  interactionId: z.string().min(1).max(INTERACTION_MAX_ID_CHARACTERS),
  status: z.enum(["answered", "cancelled"]),
  answer: z.string().max(INTERACTION_MAX_ANSWER_CHARACTERS).optional(),
  selectedOptions: z
    .array(z.string().max(INTERACTION_MAX_OPTION_VALUE_CHARACTERS))
    .max(INTERACTION_MAX_SELECTED_OPTIONS)
    .optional(),
});

export type InteractionResponsePayload = z.infer<
  typeof interactionResponseWireParser
>;

export const interactionResponsePayloadSchema = createRuntimeSchema(
  interactionResponseWireParser,
);

/**
 * Single wire builder shared by Runtime and Gateway. Returns undefined when the
 * response would exceed the Server's documented limits.
 */
export const createInteractionResponsePayload = (
  response: InteractionResponse,
): InteractionResponsePayload | undefined => {
  const candidate = {
    protocolVersion: INTERACTION_PROTOCOL_VERSION,
    interactionId: response.interactionId,
    status: response.status,
    ...(response.status === "answered" && (response.answer?.length ?? 0) > 0
      ? { answer: response.answer }
      : {}),
    ...(response.status === "answered" &&
    (response.selectedOptions?.length ?? 0) > 0
      ? { selectedOptions: [...response.selectedOptions!] }
      : {}),
  };
  const parsed = interactionResponsePayloadSchema.safeParse(candidate);
  return parsed.success ? parsed.data : undefined;
};

const interactionAckWireParser = z.object({
  protocolVersion: z.number(),
  interactionId: z.string().min(1).max(INTERACTION_MAX_ID_CHARACTERS),
  status: z.enum(["accepted", "already_closed", "unknown_request"]),
});

export const interactionAckSchema = createRuntimeSchema<InteractionAck>(
  interactionAckWireParser.transform(({ interactionId, status }) => ({
    interactionId,
    status,
  })),
);

const interactionClosedWireParser = z.object({
  protocolVersion: z.number(),
  interactionId: z.string().min(1).max(INTERACTION_MAX_ID_CHARACTERS),
  terminalReason: z
    .string()
    .min(1)
    .max(INTERACTION_MAX_DISPLAY_TEXT_CHARACTERS),
  answeredBy: optionalText(),
  answeredAt: z
    .number()
    .int()
    .nonnegative()
    .nullable()
    .optional()
    .transform((value) => value ?? undefined),
});

export const interactionClosedSchema = createRuntimeSchema<InteractionClosed>(
  interactionClosedWireParser.transform(
    ({ interactionId, terminalReason, answeredBy, answeredAt }) => ({
      interactionId,
      terminalReason,
      ...(answeredBy === undefined ? {} : { answeredBy }),
      ...(answeredAt === undefined ? {} : { answeredAt }),
    }),
  ),
);

export const isSupportedInteractionProtocolVersion = (
  version: unknown,
): boolean => version === INTERACTION_PROTOCOL_VERSION;

export const createInteractionHelloClientPayload = (
  supportsAskUserAdapter = false,
): InteractionClientHelloPayload => ({
  protocolVersion: INTERACTION_PROTOCOL_VERSION,
  versions: [INTERACTION_VERSION],
  supportsAskUserAdapter,
});

/**
 * Compatibility projection onto the session-scoped Ask User model. Lossy by
 * design (single question; requester/target/expiresAt have no equivalent);
 * live UI should consume the Interaction model directly. Returns undefined
 * when the payload cannot satisfy Ask User invariants (for example a
 * multi-select free-text question with no options).
 */
export const toAskUserInteractionRequest = (
  request: InteractionRequest,
): AskUserInteractionRequest | undefined => {
  const rawOptions = request.options ?? [];
  if (request.multiSelect && rawOptions.length === 0) return undefined;
  const seenValues = new Set<string>();
  const options = rawOptions.flatMap((option) => {
    const value = option.value.slice(0, ASK_USER_MAX_TEXT_CHARACTERS);
    if (value.length === 0 || seenValues.has(value)) return [];
    seenValues.add(value);
    const label = (option.label ?? value).slice(
      0,
      ASK_USER_MAX_TEXT_CHARACTERS,
    );
    const description = option.description?.slice(
      0,
      ASK_USER_MAX_TEXT_CHARACTERS,
    );
    return [
      {
        value,
        label: label.length === 0 ? value : label,
        ...(description === undefined ? {} : { description }),
      },
    ];
  });
  const question = request.question.slice(0, ASK_USER_MAX_TEXT_CHARACTERS);
  const prompt = question.length === 0 ? "Question" : question;
  const candidate = {
    kind: "ask-user" as const,
    conversationId: request.conversationId,
    requestId: request.interactionId.slice(
      0,
      ASK_USER_MAX_REQUEST_ID_CHARACTERS,
    ),
    revision: request.interactionId.slice(
      0,
      ASK_USER_MAX_REQUEST_ID_CHARACTERS,
    ),
    ...(request.eventId === undefined
      ? {}
      : {
          eventId: request.eventId.slice(0, ASK_USER_MAX_REQUEST_ID_CHARACTERS),
        }),
    title: prompt,
    questions: [
      {
        id: "0",
        prompt,
        required: true,
        multiple: request.multiSelect,
        options,
      },
    ],
    ...(request.timeoutSeconds > 0
      ? { timeoutSeconds: request.timeoutSeconds }
      : {}),
  };
  const parsed = askUserInteractionRequestSchema.safeParse(candidate);
  return parsed.success ? parsed.data : undefined;
};

export type { InteractionHistory };
