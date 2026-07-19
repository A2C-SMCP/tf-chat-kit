import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import {
  ProtocolValidationError,
  agentEventSchema,
  chatErrorSchema,
  chatSnapshotSchema,
  chatUpdateSchema,
  compareAgentEventTransitions,
  compareTimelineItems,
  conversationSchema,
  createGatewayDeadlineExceededError,
  getTimelineItemKey,
  gatewayRequestOptionsSchema,
  hasCompatibleAgentEventMetadata,
  interruptRunResultSchema,
  interruptRunInputSchema,
  isGatewayDeadlineExceeded,
  isGatewayOperationSupported,
  listConversationsInputSchema,
  loadConversationInputSchema,
  messageSchema,
  sanitizeRaw,
  sendTextInputSchema,
  sendTextResultSchema,
  sessionRequestSchema,
  subscribeConversationInputSchema,
  unknownEventSchema,
  type ChatGateway,
  type ChatSnapshot,
  type GatewayObserver,
} from "../packages/chat-protocol/src/index.js";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const requireStringArray = (
  value: unknown,
  fieldName: string,
): readonly string[] => {
  if (
    !Array.isArray(value) ||
    !value.every((item) => typeof item === "string")
  ) {
    throw new TypeError(`${fieldName} must be a string array`);
  }
  return value;
};

const serverContract: unknown = JSON.parse(
  readFileSync(
    new URL(
      "../fixtures/tfck-3/v1/tfrobotserver-chat-contract.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
if (!isRecord(serverContract) || !isRecord(serverContract["socket"])) {
  throw new TypeError("TFCK-3 server contract fixture is missing socket data");
}
const serverEventStatuses = requireStringArray(
  serverContract["socket"]["eventStatuses"],
  "socket.eventStatuses",
);
const toleratedEventStatuses = requireStringArray(
  serverContract["socket"]["toleratedButNotServerEmittedStatuses"],
  "socket.toleratedButNotServerEmittedStatuses",
);

const capabilities = {
  interrupt: true,
  listConversations: true,
  liveUpdates: true,
  loadHistory: true,
  sendText: true,
} as const;

const requestDeadlineAt = 1_773_705_630_000;

const conversation = {
  id: "conversation-42",
  title: "Example conversation",
  updatedAt: 1_773_705_600_000,
} as const;

const message = {
  kind: "message",
  id: "message-1",
  conversationId: conversation.id,
  role: "user",
  content: { kind: "text", text: "Hello" },
  createdAt: 1_773_705_600_000,
  sequence: 1,
} as const;

const snapshot: ChatSnapshot = {
  conversation,
  timeline: [message],
  run: null,
  capabilities,
  pageInfo: { hasPreviousPage: false },
};

describe("normalized protocol schemas", () => {
  it("parses and recursively freezes a normalized snapshot", () => {
    const { parse } = chatSnapshotSchema;
    const parsed = parse(snapshot);

    expect(parsed).toEqual(snapshot);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.timeline)).toBe(true);
    expect(Object.isFrozen(parsed.timeline[0])).toBe(true);
  });

  it("is a tolerant reader for additive optional fields", () => {
    expect(
      conversationSchema.parse({
        ...conversation,
        futureOptionalServerField: "ignored",
      }),
    ).toEqual(conversation);
  });

  it("reports stable validation errors without exposing Zod", () => {
    const result = sendTextInputSchema.safeParse({
      conversationId: "conversation-42",
      text: "",
      deadlineAt: requestDeadlineAt,
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toBeInstanceOf(ProtocolValidationError);
    expect(result.error.issues[0]?.path).toEqual(["text"]);
  });

  it("preserves unknown events as an explicit safe fallback", () => {
    const event = unknownEventSchema.parse({
      kind: "unknown-event",
      id: "event-unknown",
      conversationId: conversation.id,
      originalType: "future_scene",
      createdAt: 1_773_705_600_100,
      summary: "Unsupported event: future_scene",
      raw: { accessToken: "secret", payload: { value: 1 } },
    });

    expect(event.kind).toBe("unknown-event");
    expect(event.originalType).toBe("future_scene");
    expect(event.raw).toEqual({
      accessToken: "[REDACTED]",
      payload: { value: 1 },
    });
  });

  it("accepts the frozen server event status vocabulary", () => {
    for (const status of [...serverEventStatuses, ...toleratedEventStatuses]) {
      expect(
        agentEventSchema.safeParse({
          kind: "agent-event",
          eventCategory: "generic",
          id: `event-${status}`,
          conversationId: conversation.id,
          eventType: "chain",
          status,
          createdAt: 1_773_705_600_100,
          transitions: [
            {
              id: `transition-${status}`,
              status,
              occurredAt: 1_773_705_600_100,
            },
          ],
        }).success,
      ).toBe(true);
    }
  });

  it("preserves ordered Tool call and return transitions", () => {
    const event = agentEventSchema.parse({
      kind: "agent-event",
      eventCategory: "tool",
      id: "event-1",
      conversationId: conversation.id,
      eventType: "tool",
      status: "success",
      createdAt: 1_773_705_600_100,
      transitions: [
        {
          id: "transition-running",
          status: "running",
          occurredAt: 1_773_705_600_100,
          toolCall: {
            id: "tool-redacted",
            name: "example_tool",
            arguments: {},
            index: 0,
          },
        },
        {
          id: "transition-success",
          status: "success",
          occurredAt: 1_773_705_600_200,
          toolReturn: {
            result: { value: "redacted" },
            success: true,
            done: true,
          },
        },
      ],
    });
    const update = chatUpdateSchema.parse({
      kind: "timeline.upsert",
      conversationId: conversation.id,
      item: event,
    });

    expect(update.kind).toBe("timeline.upsert");
    expect(event.eventCategory).toBe("tool");
    if (event.eventCategory !== "tool") return;
    expect(event.transitions[0]?.toolCall?.name).toBe("example_tool");
    expect(event.transitions[1]?.toolReturn?.success).toBe(true);
  });

  it("accepts independent idempotent Tool transition updates", () => {
    const rawUpdates = [
      {
        kind: "event.transition.upsert",
        conversationId: conversation.id,
        event: {
          eventCategory: "tool",
          id: "event-streamed-tool",
          eventType: "tool",
          createdAt: 1_773_705_600_100,
          transition: {
            id: "transition-running",
            status: "running",
            occurredAt: 1_773_705_600_100,
            toolCall: { id: "tool-1", name: "example_tool", arguments: {} },
          },
        },
      },
      {
        kind: "event.transition.upsert",
        conversationId: conversation.id,
        event: {
          eventCategory: "tool",
          id: "event-streamed-tool",
          eventType: "tool",
          createdAt: 1_773_705_600_100,
          transition: {
            id: "transition-success",
            status: "success",
            occurredAt: 1_773_705_600_200,
            toolReturn: { result: { value: 1 }, success: true, done: true },
          },
        },
      },
    ] as const;

    const transitions = rawUpdates.map((rawUpdate) => {
      const update = chatUpdateSchema.parse(rawUpdate);
      if (update.kind !== "event.transition.upsert") {
        throw new TypeError("expected an event transition update");
      }
      return update.event.transition;
    });

    const transitionById = new Map(
      [...transitions, transitions[0]!].map((transition) => [
        transition.id,
        transition,
      ]),
    );
    const orderedTransitions = [...transitionById.values()].sort(
      compareAgentEventTransitions,
    );
    expect(orderedTransitions.map(({ id }) => id)).toEqual([
      "transition-running",
      "transition-success",
    ]);

    const event = agentEventSchema.parse({
      kind: "agent-event",
      eventCategory: "tool",
      id: "event-streamed-tool",
      conversationId: conversation.id,
      eventType: "tool",
      status: orderedTransitions.at(-1)!.status,
      createdAt: 1_773_705_600_100,
      transitions: orderedTransitions,
    });
    const firstUpdate = chatUpdateSchema.parse(rawUpdates[0]);
    if (firstUpdate.kind !== "event.transition.upsert") {
      throw new TypeError("expected an event transition update");
    }
    expect(hasCompatibleAgentEventMetadata(event, firstUpdate)).toBe(true);
    expect(
      hasCompatibleAgentEventMetadata(event, {
        ...firstUpdate,
        event: { ...firstUpdate.event, eventType: "conflicting-type" },
      }),
    ).toBe(false);
    expect(
      hasCompatibleAgentEventMetadata(event, {
        ...firstUpdate,
        conversationId: "conversation-other",
      }),
    ).toBe(false);
  });

  it("rejects stale latest status and out-of-order event transitions", () => {
    const baseEvent = {
      kind: "agent-event",
      eventCategory: "generic",
      id: "event-ordering",
      conversationId: conversation.id,
      eventType: "chain",
      createdAt: 1_773_705_600_100,
    } as const;

    expect(
      agentEventSchema.safeParse({
        ...baseEvent,
        status: "running",
        transitions: [
          {
            id: "transition-running",
            status: "running",
            occurredAt: 1_773_705_600_100,
          },
          {
            id: "transition-success",
            status: "success",
            occurredAt: 1_773_705_600_200,
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      agentEventSchema.safeParse({
        ...baseEvent,
        status: "success",
        transitions: [
          {
            id: "transition-running",
            status: "running",
            occurredAt: 1_773_705_600_200,
          },
          {
            id: "transition-success",
            status: "success",
            occurredAt: 1_773_705_600_100,
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      agentEventSchema.safeParse({
        ...baseEvent,
        status: "success",
        transitions: [
          {
            id: "transition-without-sequence",
            status: "running",
            occurredAt: 1_773_705_600_100,
          },
          {
            id: "transition-with-sequence",
            status: "success",
            occurredAt: 1_773_705_600_100,
            sequence: 0,
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      agentEventSchema.safeParse({
        ...baseEvent,
        status: "success",
        transitions: [
          {
            id: "duplicate-transition",
            status: "running",
            occurredAt: 1_773_705_600_100,
          },
          {
            id: "duplicate-transition",
            status: "success",
            occurredAt: 1_773_705_600_200,
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("rejects a Tool transition update without structured Tool data", () => {
    expect(
      chatUpdateSchema.safeParse({
        kind: "event.transition.upsert",
        conversationId: conversation.id,
        event: {
          eventCategory: "tool",
          id: "event-tool-without-data",
          eventType: "tool",
          createdAt: 1_773_705_600_100,
          transition: {
            id: "transition-running",
            status: "running",
            occurredAt: 1_773_705_600_100,
          },
        },
      }).success,
    ).toBe(false);
    expect(
      chatUpdateSchema.safeParse({
        kind: "event.transition.upsert",
        conversationId: conversation.id,
        event: {
          eventCategory: "tool",
          id: "event-tool-empty-return",
          eventType: "tool",
          createdAt: 1_773_705_600_100,
          transition: {
            id: "transition-success",
            status: "success",
            occurredAt: 1_773_705_600_100,
            toolReturn: {},
          },
        },
      }).success,
    ).toBe(false);
  });

  it.each([
    { kind: "text", text: "Hello" },
    { kind: "media", mediaType: "image", summary: "Image message" },
    { kind: "file", summary: "File message" },
    { kind: "contact", summary: "Contact message" },
    { kind: "url", summary: "URL message" },
    {
      kind: "unknown",
      summary: "Unsupported history message",
      raw: { payload: 1 },
    },
  ])("parses normalized received-message variant $kind", (content) => {
    const parsed = messageSchema.parse({ ...message, content });
    expect(parsed.content.kind).toBe(content.kind);
  });

  it("rejects cross-conversation snapshot, update and nested error data", () => {
    const invalidSnapshot = chatSnapshotSchema.safeParse({
      ...snapshot,
      timeline: [{ ...message, conversationId: "conversation-other" }],
    });
    const invalidUpdate = chatUpdateSchema.safeParse({
      kind: "timeline.upsert",
      conversationId: conversation.id,
      item: { ...message, conversationId: "conversation-other" },
    });
    const invalidSnapshotError = chatSnapshotSchema.safeParse({
      ...snapshot,
      error: {
        code: "network",
        message: "Wrong conversation",
        retryable: true,
        conversationId: "conversation-other",
      },
    });
    const invalidRunError = chatSnapshotSchema.safeParse({
      ...snapshot,
      run: {
        id: "run-1",
        conversationId: conversation.id,
        status: "failed",
        canInterrupt: false,
        error: {
          code: "server",
          message: "Wrong conversation",
          retryable: false,
          conversationId: "conversation-other",
        },
      },
    });
    const invalidEventError = chatSnapshotSchema.safeParse({
      ...snapshot,
      timeline: [
        {
          kind: "agent-event",
          eventCategory: "generic",
          id: "event-invalid-error",
          conversationId: conversation.id,
          eventType: "chain",
          status: "failed",
          createdAt: 1_773_705_600_100,
          transitions: [
            {
              id: "transition-failed",
              status: "failed",
              occurredAt: 1_773_705_600_100,
              error: {
                code: "server",
                message: "Wrong conversation",
                retryable: false,
                conversationId: "conversation-other",
              },
            },
          ],
        },
      ],
    });
    const invalidReportedError = chatUpdateSchema.safeParse({
      kind: "error.reported",
      conversationId: conversation.id,
      error: {
        code: "network",
        message: "Wrong conversation",
        retryable: true,
        conversationId: "conversation-other",
      },
    });
    const invalidTransitionError = chatUpdateSchema.safeParse({
      kind: "event.transition.upsert",
      conversationId: conversation.id,
      event: {
        eventCategory: "generic",
        id: "event-invalid-transition-error",
        eventType: "chain",
        createdAt: 1_773_705_600_100,
        transition: {
          id: "transition-invalid-error",
          status: "failed",
          occurredAt: 1_773_705_600_100,
          error: {
            code: "server",
            message: "Wrong conversation",
            retryable: false,
            conversationId: "conversation-other",
          },
        },
      },
    });

    expect(invalidSnapshot.success).toBe(false);
    expect(invalidUpdate.success).toBe(false);
    expect(invalidSnapshotError.success).toBe(false);
    expect(invalidRunError.success).toBe(false);
    expect(invalidEventError.success).toBe(false);
    expect(invalidReportedError.success).toBe(false);
    expect(invalidTransitionError.success).toBe(false);
  });
});

describe("raw payload safety", () => {
  it("redacts credential-shaped keys at every depth", () => {
    const raw = sanitizeRaw({
      Authorization: "Bearer secret",
      nested: {
        adminToken: "secret",
        access_token: "secret",
        safe: "visible",
        userToken: "secret",
      },
    });

    expect(raw).toEqual({
      Authorization: "[REDACTED]",
      nested: {
        adminToken: "[REDACTED]",
        access_token: "[REDACTED]",
        safe: "visible",
        userToken: "[REDACTED]",
      },
    });
    expect(Object.isFrozen(raw)).toBe(true);
  });

  it("redacts credential-bearing values and header tuples", () => {
    expect(
      sanitizeRaw({
        url: "https://example.invalid/file?access_token=secret&safe=visible",
        auth: ["Bearer secret"],
        headers: [
          ["Authorization", "Bearer secret"],
          ["X-Trace-Id", "trace-visible"],
        ],
        embeddedAuthorization: "Bearer secret",
        fragmentUrl:
          "https://example.invalid/callback#access_token=secret&state=visible",
        jwtValue:
          "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJyZWRhY3RlZCJ9.signature-redacted",
        userInfoUrl: "https://user:password@example.invalid/path",
      }),
    ).toEqual({
      url: "https://example.invalid/file?access_token=%5BREDACTED%5D&safe=visible",
      auth: "[REDACTED]",
      headers: [
        ["Authorization", "[REDACTED]"],
        ["X-Trace-Id", "trace-visible"],
      ],
      embeddedAuthorization: "[REDACTED]",
      fragmentUrl:
        "https://example.invalid/callback#access_token=%5BREDACTED%5D&state=visible",
      jwtValue: "[REDACTED]",
      userInfoUrl: "https://[REDACTED]@example.invalid/path",
    });
  });

  it("redacts credentials embedded in diagnostics and structured errors", () => {
    expect(
      sanitizeRaw({
        message:
          "request failed: Bearer abcdefgh.abcdefgh.abcdefgh while connecting",
        socket: "wss://user:super-secret@chat.example/socket",
        networkPath: "connect //user:pass@example.invalid/path",
        parameter: "request token: live-secret",
        bearer: "Bearer secret~tail",
      }),
    ).toEqual({
      message: "request failed: [REDACTED] while connecting",
      socket: "wss://[REDACTED]@chat.example/socket",
      networkPath: "connect //[REDACTED]@example.invalid/path",
      parameter: "request token:[REDACTED]",
      bearer: "[REDACTED]",
    });
    expect(
      chatErrorSchema.parse({
        code: "server",
        message: "Authorization: Bearer live-secret",
        retryable: false,
      }),
    ).toEqual({
      code: "server",
      message: "[REDACTED]",
      retryable: false,
    });
    expect(
      chatErrorSchema.parse({
        code: "authentication",
        message: "password: hunter2",
        retryable: false,
      }).message,
    ).toBe("[REDACTED]");
  });

  it.each([
    "X-Admin-Key: admin-secret",
    "X-API-Key=api-secret",
    "-----BEGIN PRIVATE KEY-----\nredacted-key-material",
    "-----BEGIN ENCRYPTED PRIVATE KEY-----\nredacted-key-material",
    "-----BEGIN PGP PRIVATE KEY BLOCK-----\nredacted-key-material",
    "Proxy-Authorization: Basic dXNlcjpwYXNzd29yZA==",
    "ghp_abcdefghijklmnopqrstuvwxyz1234567890",
    "sk-abcdefghijklmnopqrstuvwxyz123456",
    "AKIA1234567890ABCDEF",
    "AIDA1234567890ABCDEF",
    "AROA1234567890ABCDEF",
    "access_token=secret",
  ])("redacts credential-shaped string value %s", (credential) => {
    expect(sanitizeRaw({ note: credential })).toEqual({
      note: "[REDACTED]",
    });
  });

  it.each([
    "-----BEGIN PUBLIC KEY-----\npublic-material",
    "Proxy-Authenticate: Basic",
    "https://example.invalid/page#section=visible",
    "request_id=visible",
    "AIDA-short-public-id",
  ])("preserves non-credential string value %s", (value) => {
    expect(sanitizeRaw({ note: value })).toEqual({ note: value });
  });

  it.each([
    "X-API-Key",
    "x_api_key",
    "prefix.api-key",
    "X-Admin-Key",
    "private-key",
    "X-Secret-Key",
    "client_secret",
  ])("redacts credential key variant %s", (key) => {
    expect(sanitizeRaw({ [key]: "credential" })).toEqual({
      [key]: "[REDACTED]",
    });
  });

  it("preserves special JSON keys without mutating the result prototype", () => {
    const input = JSON.parse(
      '{"__proto__":{"polluted":true},"constructor":"kept","prototype":"kept"}',
    ) as unknown;
    const sanitized = sanitizeRaw(input);
    if (
      sanitized === null ||
      Array.isArray(sanitized) ||
      typeof sanitized !== "object"
    ) {
      throw new TypeError("expected a sanitized JSON object");
    }

    expect(Object.getPrototypeOf(sanitized)).toBe(Object.prototype);
    expect(Object.hasOwn(sanitized, "__proto__")).toBe(true);
    expect(Object.hasOwn(sanitized, "constructor")).toBe(true);
    expect(Object.hasOwn(sanitized, "prototype")).toBe(true);
    expect(JSON.stringify(sanitized)).toBe(
      '{"__proto__":{"polluted":true},"constructor":"kept","prototype":"kept"}',
    );
  });

  it("rejects non-JSON and circular raw values", () => {
    expect(() => sanitizeRaw({ bad: undefined })).toThrow(
      /unsupported undefined/u,
    );
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;
    expect(() => sanitizeRaw(circular)).toThrow(/circular/u);
    expect(() => sanitizeRaw(new Date())).toThrow(/plain JSON objects/u);
  });

  it("rejects raw values beyond bounded size limits", () => {
    expect(() => sanitizeRaw("x".repeat(262_145))).toThrow(/strings/u);
    expect(() =>
      sanitizeRaw(Array.from({ length: 10_001 }, () => null)),
    ).toThrow(/node count/u);
    expect(() => sanitizeRaw({ ["x".repeat(1_025)]: true })).toThrow(/keys/u);
    expect(() =>
      sanitizeRaw(Array.from({ length: 5 }, () => "x".repeat(262_144))),
    ).toThrow(/total character count/u);
    const replacementExpansion = `?${"token=x&".repeat(32_767)}token=x`;
    expect(replacementExpansion).toHaveLength(262_144);
    expect(() => sanitizeRaw(replacementExpansion)).toThrow(
      /sanitized raw data strings/u,
    );
    expect(() => sanitizeRaw(new Array(20_000))).toThrow(/node count/u);
    expect(() =>
      sanitizeRaw(new Array(10).fill(null).slice(0, 9)),
    ).not.toThrow();
    const sparse = new Array(10);
    sparse[9] = null;
    expect(() => sanitizeRaw(sparse)).toThrow(/must not be sparse/u);
    expect(() =>
      sanitizeRaw(
        Object.fromEntries(
          Array.from({ length: 10_000 }, (_, index) => [
            `field${index}Token`,
            "secret",
          ]),
        ),
      ),
    ).toThrow(/node count/u);
  });
});

describe("stable identity and ordering", () => {
  it("deduplicates message and event namespaces independently", () => {
    expect(getTimelineItemKey(message)).toBe("message:message-1");
    expect(
      getTimelineItemKey({
        kind: "agent-event",
        eventCategory: "generic",
        id: "message-1",
        conversationId: conversation.id,
        eventType: "chain",
        status: "running",
        createdAt: message.createdAt,
        transitions: [
          {
            id: "transition-running",
            status: "running",
            occurredAt: message.createdAt,
          },
        ],
      }),
    ).toBe("event:message-1");
  });

  it("orders by server timestamp, sequence, then stable key", () => {
    const laterSequence = { ...message, id: "message-2", sequence: 2 } as const;
    const laterTime = {
      ...message,
      id: "message-3",
      createdAt: message.createdAt + 1,
      sequence: 0,
    } as const;

    expect(
      [laterTime, laterSequence, message].sort(compareTimelineItems),
    ).toEqual([message, laterSequence, laterTime]);
  });
});

describe("Gateway and SessionProvider public contract", () => {
  it("supports a DOM-free non-TFRobot in-memory consumer", async () => {
    let observer: GatewayObserver | undefined;
    const dispose = vi.fn();
    const gateway: ChatGateway = {
      async listConversations() {
        return { ok: true, value: { conversations: [conversation] } };
      },
      async loadConversation() {
        return { ok: true, value: snapshot };
      },
      subscribe(_input, nextObserver) {
        observer = nextObserver;
        return { ok: true, value: { dispose } };
      },
      async sendText(input) {
        sendTextInputSchema.parse(input);
        return { ok: true, value: { runId: "run-1" } };
      },
      async interrupt(input) {
        return interruptRunResultSchema.parse({
          ok: true,
          value: {
            cancellationId: "cancel-1",
            interruptedRunId: input.runId,
          },
        });
      },
      dispose,
    };

    const loaded = await gateway.loadConversation({
      conversationId: conversation.id,
      deadlineAt: requestDeadlineAt,
    });
    expect(loaded.ok && loaded.value.timeline).toHaveLength(1);
    const subscribed = await gateway.subscribe(
      { conversationId: conversation.id, deadlineAt: requestDeadlineAt },
      { next: vi.fn() },
    );
    expect(subscribed.ok).toBe(true);
    if (!subscribed.ok) return;
    observer?.next({ kind: "snapshot.replace", snapshot });
    expect(
      await gateway.sendText({
        conversationId: conversation.id,
        text: "Hi",
        deadlineAt: requestDeadlineAt,
      }),
    ).toEqual({ ok: true, value: { runId: "run-1" } });
    expect(
      await gateway.interrupt({
        conversationId: conversation.id,
        runId: "run-1",
        deadlineAt: requestDeadlineAt,
      }),
    ).toEqual({
      ok: true,
      value: { cancellationId: "cancel-1", interruptedRunId: "run-1" },
    });
    await subscribed.value.dispose({ deadlineAt: requestDeadlineAt });
    await gateway.dispose({ deadlineAt: requestDeadlineAt });
    expect(dispose).toHaveBeenCalledTimes(2);
  });

  it("validates session intent without prescribing credential shape", () => {
    expect(
      sessionRequestSchema.parse({
        purpose: "reconnect",
        operation: "subscribe",
        conversationId: conversation.id,
      }),
    ).toEqual({
      purpose: "reconnect",
      operation: "subscribe",
      conversationId: conversation.id,
    });
  });

  it("requires a safe-integer deadline on Gateway operations", () => {
    expect(
      sendTextInputSchema.parse({
        conversationId: conversation.id,
        text: "Hello",
        deadlineAt: requestDeadlineAt,
      }),
    ).toEqual({
      conversationId: conversation.id,
      text: "Hello",
      deadlineAt: requestDeadlineAt,
    });
    expect(
      sendTextInputSchema.safeParse({
        conversationId: conversation.id,
        text: "Hello",
      }).success,
    ).toBe(false);
    expect(
      sendTextInputSchema.safeParse({
        conversationId: conversation.id,
        text: "Hello",
        deadlineAt: 1.5,
      }).success,
    ).toBe(false);
    expect(
      sendTextInputSchema.safeParse({
        conversationId: conversation.id,
        text: "Hello",
        deadlineAt: Number.MAX_VALUE,
      }).success,
    ).toBe(false);
  });

  it("requires deadlines for every asynchronous Gateway input", () => {
    const cases = [
      [listConversationsInputSchema, {}],
      [gatewayRequestOptionsSchema, {}],
      [loadConversationInputSchema, { conversationId: conversation.id }],
      [subscribeConversationInputSchema, { conversationId: conversation.id }],
      [sendTextInputSchema, { conversationId: conversation.id, text: "Hi" }],
      [
        interruptRunInputSchema,
        { conversationId: conversation.id, runId: "run-1" },
      ],
    ] as const;

    for (const [schema, input] of cases) {
      expect(schema.safeParse(input).success).toBe(false);
      expect(
        schema.safeParse({ ...input, deadlineAt: requestDeadlineAt }).success,
      ).toBe(true);
    }
  });

  it("provides deterministic deadline evaluation and timeout errors", () => {
    expect(
      isGatewayDeadlineExceeded(
        { deadlineAt: requestDeadlineAt },
        requestDeadlineAt - 1,
      ),
    ).toBe(false);
    expect(
      isGatewayDeadlineExceeded(
        { deadlineAt: requestDeadlineAt },
        requestDeadlineAt,
      ),
    ).toBe(true);
    expect(createGatewayDeadlineExceededError(conversation.id)).toEqual({
      code: "timeout",
      message: "Gateway operation exceeded its deadline",
      retryable: true,
      conversationId: conversation.id,
    });
  });

  it("returns structured errors for unsupported capabilities", () => {
    expect(
      sendTextResultSchema.parse({
        ok: false,
        error: {
          code: "unsupported",
          message: "Text sending is unavailable",
          retryable: false,
        },
      }),
    ).toEqual({
      ok: false,
      error: {
        code: "unsupported",
        message: "Text sending is unavailable",
        retryable: false,
      },
    });
  });

  it("maps unavailable capabilities to executable Gateway behavior", async () => {
    const unavailableCapabilities = {
      interrupt: false,
      listConversations: false,
      liveUpdates: false,
      loadHistory: false,
      sendText: false,
    } as const;
    const unavailableSnapshot: ChatSnapshot = {
      ...snapshot,
      capabilities: unavailableCapabilities,
    };
    const unsupported = {
      ok: false,
      error: {
        code: "unsupported",
        message: "Operation is unavailable",
        retryable: false,
      },
    } as const;
    const next = vi.fn();
    const gateway: ChatGateway = {
      async listConversations() {
        return isGatewayOperationSupported(
          unavailableCapabilities,
          "listConversations",
        )
          ? { ok: true, value: { conversations: [conversation] } }
          : unsupported;
      },
      async loadConversation(input) {
        if (
          input.previousCursor !== undefined &&
          !isGatewayOperationSupported(unavailableCapabilities, "loadHistory")
        ) {
          return unsupported;
        }
        return { ok: true, value: unavailableSnapshot };
      },
      subscribe() {
        return isGatewayOperationSupported(unavailableCapabilities, "subscribe")
          ? { ok: true, value: { dispose: vi.fn() } }
          : unsupported;
      },
      async sendText() {
        return isGatewayOperationSupported(unavailableCapabilities, "sendText")
          ? { ok: true, value: { runId: "run-1" } }
          : unsupported;
      },
      async interrupt() {
        return isGatewayOperationSupported(
          unavailableCapabilities,
          "interrupt",
          {
            id: "run-1",
            conversationId: conversation.id,
            status: "running",
            canInterrupt: true,
          },
        )
          ? { ok: true, value: { cancellationId: "cancel-1" } }
          : unsupported;
      },
      dispose: vi.fn(),
    };

    await expect(
      gateway.listConversations({ deadlineAt: requestDeadlineAt }),
    ).resolves.toEqual(unsupported);
    await expect(
      gateway.loadConversation({
        conversationId: conversation.id,
        deadlineAt: requestDeadlineAt,
      }),
    ).resolves.toEqual({ ok: true, value: unavailableSnapshot });
    await expect(
      gateway.loadConversation({
        conversationId: conversation.id,
        previousCursor: "previous-page",
        deadlineAt: requestDeadlineAt,
      }),
    ).resolves.toEqual(unsupported);
    expect(
      await gateway.subscribe(
        { conversationId: conversation.id, deadlineAt: requestDeadlineAt },
        { next },
      ),
    ).toEqual(unsupported);
    expect(next).not.toHaveBeenCalled();
    await expect(
      gateway.sendText({
        conversationId: conversation.id,
        text: "Hi",
        deadlineAt: requestDeadlineAt,
      }),
    ).resolves.toEqual(unsupported);
    await expect(
      gateway.interrupt({
        conversationId: conversation.id,
        runId: "run-1",
        deadlineAt: requestDeadlineAt,
      }),
    ).resolves.toEqual(unsupported);
  });

  it("requires both interrupt capability and an interruptible running run", () => {
    const interruptibleRun = {
      id: "run-1",
      conversationId: conversation.id,
      status: "running",
      canInterrupt: true,
    } as const;

    expect(
      isGatewayOperationSupported(capabilities, "interrupt", interruptibleRun),
    ).toBe(true);
    expect(
      isGatewayOperationSupported(capabilities, "interrupt", {
        ...interruptibleRun,
        canInterrupt: false,
      }),
    ).toBe(false);
    expect(
      isGatewayOperationSupported(capabilities, "interrupt", {
        ...interruptibleRun,
        status: "succeeded",
      }),
    ).toBe(false);
    expect(
      isGatewayOperationSupported(
        { ...capabilities, interrupt: false },
        "interrupt",
        interruptibleRun,
      ),
    ).toBe(false);
  });
});
