import { describe, expect, it } from "vitest";

import {
  INTERACTION_MAX_ANSWER_CHARACTERS,
  INTERACTION_MAX_QUESTION_CHARACTERS,
  INTERACTION_PROTOCOL_VERSION,
  createInteractionResponsePayload,
  interactionAckSchema,
  interactionClosedSchema,
  interactionHelloClientPayloadSchema,
  interactionHelloServerSchema,
  interactionHistorySchema,
  interactionPendingEnvelopeSchema,
  interactionRequestSchema,
  interactionResponsePayloadSchema,
  isSupportedInteractionProtocolVersion,
  toAskUserInteractionRequest,
} from "../packages/chat-protocol/src/index.js";

const requested = {
  protocolVersion: INTERACTION_PROTOCOL_VERSION,
  interactionId: "interaction-1",
  conversationId: 42,
  conversationTitle: null,
  robotId: "robot-1",
  namespace: "/remote-tool",
  requester: { id: "user-1", name: null, avatar: null },
  target: { kind: "human", id: "user-2", name: "Colleague", avatar: null },
  question: "Deploy the build?",
  options: [
    { value: "yes", label: "Yes", description: "Start the rollout" },
    { value: "no", label: null },
  ],
  multiSelect: false,
  timeoutSeconds: 30,
  expiresAt: 1_800_000_000_000,
  callId: "call-1",
  eventId: null,
};

describe("Interaction wire contract", () => {
  it("normalizes omitted and null optional fields while preserving values and labels", () => {
    const parsed = interactionRequestSchema.parse(requested);
    expect(parsed).toMatchObject({
      interactionId: "interaction-1",
      conversationId: "42",
      robotId: "robot-1",
      namespace: "/remote-tool",
      requester: { id: "user-1" },
      target: { kind: "human", id: "user-2", name: "Colleague" },
      multiSelect: false,
      timeoutSeconds: 30,
      expiresAt: 1_800_000_000_000,
      callId: "call-1",
      options: [
        { value: "yes", label: "Yes", description: "Start the rollout" },
        { value: "no" },
      ],
    });
    expect("protocolVersion" in parsed).toBe(false);
    expect(parsed.conversationTitle).toBeUndefined();
    expect(parsed.eventId).toBeUndefined();
    expect(parsed.requester.name).toBeUndefined();
    expect(parsed.target.avatar).toBeUndefined();
    expect(parsed.options?.[1]?.label).toBeUndefined();
  });

  it("defaults multiSelect and tolerates missing options for free text", () => {
    const parsed = interactionRequestSchema.parse({
      ...requested,
      multiSelect: undefined,
      options: undefined,
    });
    expect(parsed.multiSelect).toBe(false);
    expect(parsed.options).toBeUndefined();
  });

  it("rejects malformed frames without fabricating identity or deadlines", () => {
    expect(
      interactionRequestSchema.safeParse({ ...requested, interactionId: "" })
        .success,
    ).toBe(false);
    expect(
      interactionRequestSchema.safeParse({ ...requested, requester: null })
        .success,
    ).toBe(false);
    expect(
      interactionRequestSchema.safeParse({ ...requested, expiresAt: -1 })
        .success,
    ).toBe(false);
    expect(
      interactionRequestSchema.safeParse({
        ...requested,
        options: [{ value: "" }],
      }).success,
    ).toBe(false);
    expect(
      interactionRequestSchema.safeParse({
        ...requested,
        conversationId: "c".repeat(1_025),
      }).success,
    ).toBe(false);
  });

  it("caps snapshot and hello envelopes defensively", () => {
    expect(
      interactionPendingEnvelopeSchema.safeParse({
        protocolVersion: 1,
        interactions: Array.from({ length: 101 }, () => ({})),
      }).success,
    ).toBe(false);
    expect(
      interactionHelloServerSchema.safeParse({
        protocolVersion: 1,
        versions: Array.from({ length: 33 }, () => "interaction_v1"),
        robotId: "robot-1",
        namespace: "/remote-tool",
      }).success,
    ).toBe(false);
  });

  it("recognizes only the supported protocol version", () => {
    expect(
      isSupportedInteractionProtocolVersion(INTERACTION_PROTOCOL_VERSION),
    ).toBe(true);
    expect(isSupportedInteractionProtocolVersion(0)).toBe(false);
    expect(isSupportedInteractionProtocolVersion("1")).toBe(false);
  });

  it("keeps unknown pending items for readable-id reconciliation", () => {
    const envelope = interactionPendingEnvelopeSchema.parse({
      protocolVersion: INTERACTION_PROTOCOL_VERSION,
      interactions: [requested, { interactionId: "broken" }, { nope: true }],
    });
    expect(envelope.interactions).toHaveLength(3);
  });

  it("validates hello, ack, closed and response payloads", () => {
    expect(
      interactionHelloServerSchema.parse({
        protocolVersion: 1,
        versions: ["interaction_v1"],
        robotId: "robot-1",
        namespace: "/remote-tool",
      }),
    ).toEqual({
      versions: ["interaction_v1"],
      robotId: "robot-1",
      namespace: "/remote-tool",
    });
    expect(
      interactionAckSchema.parse({
        protocolVersion: 1,
        interactionId: "interaction-1",
        status: "already_closed",
      }),
    ).toEqual({ interactionId: "interaction-1", status: "already_closed" });
    expect(
      interactionClosedSchema.parse({
        protocolVersion: 1,
        interactionId: "interaction-1",
        terminalReason: "weird-but-visible",
        answeredBy: null,
        answeredAt: null,
      }),
    ).toEqual({
      interactionId: "interaction-1",
      terminalReason: "weird-but-visible",
    });
    expect(
      interactionResponsePayloadSchema.parse({
        protocolVersion: 1,
        interactionId: "interaction-1",
        status: "answered",
        selectedOptions: ["yes"],
      }),
    ).toMatchObject({ selectedOptions: ["yes"] });
    const hello = interactionHelloClientPayloadSchema.parse({
      protocolVersion: 1,
      versions: ["interaction_v1"],
      supportsAskUserAdapter: false,
    });
    expect(hello.protocolVersion).toBe(1);
  });

  it("maps a single interaction onto the compatibility Ask User request", () => {
    const mapped = toAskUserInteractionRequest(
      interactionRequestSchema.parse(requested),
    );
    expect(mapped).toMatchObject({
      kind: "ask-user",
      conversationId: "42",
      requestId: "interaction-1",
      revision: "interaction-1",
      title: "Deploy the build?",
      questions: [
        {
          id: "0",
          prompt: "Deploy the build?",
          required: true,
          multiple: false,
          options: [
            { value: "yes", label: "Yes", description: "Start the rollout" },
            { value: "no", label: "no" },
          ],
        },
      ],
    });
  });

  it("accepts Server-sized question text and truncates only the Ask User projection", () => {
    const question = "q".repeat(3_000);
    const parsed = interactionRequestSchema.parse({ ...requested, question });
    expect(parsed.question).toHaveLength(3_000);
    const mapped = toAskUserInteractionRequest(parsed);
    expect(mapped?.questions[0]?.prompt).toHaveLength(2_000);
    expect(
      interactionRequestSchema.safeParse({
        ...requested,
        question: "q".repeat(INTERACTION_MAX_QUESTION_CHARACTERS + 1),
      }).success,
    ).toBe(false);
  });

  it("returns undefined when the interaction cannot satisfy Ask User invariants", () => {
    expect(
      toAskUserInteractionRequest(
        interactionRequestSchema.parse({
          ...requested,
          multiSelect: true,
          options: undefined,
        }),
      ),
    ).toBeUndefined();
    const deduped = toAskUserInteractionRequest(
      interactionRequestSchema.parse({
        ...requested,
        options: [
          { value: "yes", label: "First" },
          { value: "yes", label: "Duplicate" },
        ],
      }),
    );
    expect(deduped?.questions[0]?.options).toEqual([
      { value: "yes", label: "First" },
    ]);
  });

  it("rejects responses beyond the Server limits instead of emitting them", () => {
    expect(
      createInteractionResponsePayload({
        interactionId: "interaction-1",
        status: "answered",
        answer: "a".repeat(INTERACTION_MAX_ANSWER_CHARACTERS + 1),
      }),
    ).toBeUndefined();
    expect(
      createInteractionResponsePayload({
        interactionId: "interaction-1",
        status: "answered",
        selectedOptions: Array.from({ length: 51 }, (_, index) =>
          String(index),
        ),
      }),
    ).toBeUndefined();
    expect(
      createInteractionResponsePayload({
        interactionId: "interaction-1",
        status: "cancelled",
      }),
    ).toEqual({
      protocolVersion: INTERACTION_PROTOCOL_VERSION,
      interactionId: "interaction-1",
      status: "cancelled",
    });
  });

  it("validates historical interaction results with optional fields", () => {
    expect(
      interactionHistorySchema.parse({
        kind: "interaction-history",
        interactionId: "interaction-1",
        direction: "ask",
        status: "answered",
        question: "Deploy the build?",
        answer: "Yes",
      }),
    ).toMatchObject({ direction: "ask", status: "answered", answer: "Yes" });
    expect(
      interactionHistorySchema.safeParse({
        kind: "interaction-history",
        interactionId: "interaction-1",
        direction: "reply",
        status: "answered",
      }).success,
    ).toBe(false);
  });
});
