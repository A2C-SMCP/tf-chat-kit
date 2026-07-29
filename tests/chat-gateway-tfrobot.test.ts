import { describe, expect, it, vi } from "vitest";

import {
  createTFRobotChatGateway,
  type TFRobotSession,
  type TFRobotSocket,
  type TFRobotSocketAnyListener,
  type TFRobotSocketFactoryInput,
  type TFRobotSocketListener,
} from "../packages/chat-gateway-tfrobot/src/index.js";
import { mapEvent } from "../packages/chat-gateway-tfrobot/src/mapper.js";
import type {
  ChatError,
  ChatUpdate,
  SessionProvider,
} from "../packages/chat-protocol/src/index.js";

const deadline = (): number => Date.now() + 60_000;

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
};

const messageCreatorProvider = () => ({
  uid: "current-user",
  name: "Current user",
});

const envelope = (data: unknown): Response =>
  new Response(JSON.stringify({ code: 200, message: "Success", data }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

const conversationDto = {
  conversationId: 42,
  title: "Gateway conversation",
  description: null,
  updateTimestamp: 1_773_705_600_000,
};

const messageDto = {
  msgId: "message-1",
  content: "Hello from TFRobot",
  additionalKwargs: { accessToken: "message-secret", safe: true },
  attachments: null,
  createTimestamp: 1_773_705_600_000,
  creator: {
    uid: "user-1",
    name: "Example user",
    avatar: null,
  },
  conversationId: 42,
  role: "user",
  msgType: "text",
};

const eventDto = {
  eventId: "event-1",
  status: "success",
  eventScene: "Chain",
  conversationId: 42,
  createTimestamp: 1_773_705_600_100,
  exception: null,
  content: "Completed",
};

const sessionProvider = (
  session: TFRobotSession = {
    kind: "bearer",
    token: "header.payload.signature",
  },
): SessionProvider<TFRobotSession> => ({
  getSession: vi.fn(() => session),
  onSessionInvalid: vi.fn(),
});

class FakeSocket implements TFRobotSocket {
  connected = false;
  readonly emitted: Array<readonly [string, unknown]> = [];
  readonly #anyListeners = new Set<TFRobotSocketAnyListener>();
  readonly #listeners = new Map<string, Set<TFRobotSocketListener>>();

  connect(): void {
    this.connected = true;
    this.trigger("connect");
  }

  disconnect(): void {
    this.connected = false;
  }

  emit(eventName: string, payload?: unknown): void {
    this.emitted.push([eventName, payload]);
  }

  off(eventName: string, listener: TFRobotSocketListener): void {
    this.#listeners.get(eventName)?.delete(listener);
  }

  offAny(listener: TFRobotSocketAnyListener): void {
    this.#anyListeners.delete(listener);
  }

  on(eventName: string, listener: TFRobotSocketListener): void {
    const listeners =
      this.#listeners.get(eventName) ?? new Set<TFRobotSocketListener>();
    listeners.add(listener);
    this.#listeners.set(eventName, listeners);
  }

  onAny(listener: TFRobotSocketAnyListener): void {
    this.#anyListeners.add(listener);
  }

  trigger(eventName: string, payload?: unknown): void {
    for (const listener of this.#listeners.get(eventName) ?? []) {
      listener(payload);
    }
    for (const listener of this.#anyListeners) {
      listener(eventName, payload);
    }
  }
}

const createSocketFixture = () => {
  const sockets: FakeSocket[] = [];
  const inputs: TFRobotSocketFactoryInput[] = [];
  return {
    inputs,
    sockets,
    factory(input: TFRobotSocketFactoryInput): TFRobotSocket {
      inputs.push(input);
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
  };
};

describe("TFRobotChatGateway REST boundary", () => {
  it("normalizes historical Ask User tool results without enabling live answers", async () => {
    const askUserEvent = {
      ...eventDto,
      eventId: "ask-user-event",
      eventScene: "Tool",
      content: {
        toolCall: {
          toolId: "ask-request-1",
          functionCall: {
            name: "ask_user",
            parameters: JSON.stringify({
              title: "Need input",
              questions: [
                {
                  id: "choice",
                  question: "Choose a release channel",
                  multiSelect: false,
                  options: [
                    {
                      label: "Stable",
                      value: "stable",
                      description: "Production channel",
                    },
                  ],
                },
              ],
            }),
          },
        },
        toolReturn: {
          origin: {
            type: "askUser",
            requestId: "ask-request-1",
            status: "answered",
            questions: [
              {
                question: "Choose a release channel",
                header: "Release channel",
                multiSelect: true,
                default: ["Stable, canary", "Beta"],
                options: [
                  { label: "Stable", description: "Production channel" },
                ],
              },
            ],
            response: {
              requestId: "ask-request-1",
              answers: { "0": ["Stable, canary", "Beta"] },
              cancelled: false,
              chatAboutThis: false,
              timedOut: false,
            },
          },
          meta: { success: true, done: true },
        },
      },
    };
    const fetch = vi.fn(
      async (input: Parameters<typeof globalThis.fetch>[0]) => {
        const path = new URL(input instanceof Request ? input.url : input)
          .pathname;
        if (path.endsWith("/conversations")) {
          return envelope({ conversations: [conversationDto], cursor: null });
        }
        if (path.endsWith("/messages")) {
          return envelope({
            messages: [],
            events: [askUserEvent],
            cursor: null,
          });
        }
        if (path.endsWith("/status")) return envelope({ working: false });
        throw new Error(`Unexpected request: ${path}`);
      },
    );
    const gateway = createTFRobotChatGateway({
      baseUrl: "https://robot.example/",
      messageCreatorProvider,
      sessionProvider: sessionProvider(),
      fetch,
      socketFactory: createSocketFixture().factory,
    });
    const loaded = await gateway.loadConversation({
      conversationId: "42",
      deadlineAt: deadline(),
    });

    expect(loaded).toMatchObject({
      ok: true,
      value: {
        timeline: [
          {
            eventCategory: "tool",
            transitions: [
              {
                interaction: {
                  kind: "ask-user",
                  requestId: "ask-request-1",
                  status: "answered",
                  answers: { "0": ["Stable, canary", "Beta"] },
                  questions: [
                    {
                      prompt: "Choose a release channel",
                      title: "Release channel",
                      defaultValue: ["Stable, canary", "Beta"],
                    },
                  ],
                },
              },
            ],
          },
        ],
      },
    });
    if (!loaded.ok) return;
    expect(loaded.value.capabilities.answerInteraction).not.toBe(true);
    expect(gateway.answerInteraction).toBeUndefined();
    await gateway.dispose({ deadlineAt: deadline() });
  });

  it("filters malformed Ask User options without losing the Tool event", () => {
    const event = mapEvent({
      ...eventDto,
      eventId: "malformed-ask-user-event",
      eventScene: "Tool",
      content: {
        toolCall: {
          toolId: "malformed-request",
          functionCall: {
            name: "ask_user",
            parameters: JSON.stringify({
              questions: [
                {
                  question: "Choose safely",
                  options: [""],
                },
              ],
            }),
          },
        },
        toolReturn: {
          origin: {
            type: "askUser",
            requestId: "malformed-request",
            status: "answered",
            questions: [
              {
                question: "Choose safely",
                options: [""],
              },
            ],
            response: {
              requestId: "malformed-request",
              answers: { "0": "" },
            },
          },
          meta: { success: true, done: true },
        },
      },
    });

    expect(event.eventCategory).toBe("tool");
    if (event.eventCategory !== "tool") return;
    expect(event.transitions[0]?.toolCall?.name).toBe("ask_user");
    expect(event.transitions[0]?.toolReturn?.success).toBe(true);
    expect(event.transitions[0]?.interaction?.questions[0]?.options).toEqual(
      [],
    );
  });

  it("maps Ask User origin and Tool metadata failures to a failed interaction", () => {
    const event = mapEvent({
      ...eventDto,
      eventId: "failed-ask-user-event",
      eventScene: "Tool",
      status: "success",
      content: {
        toolCall: {
          toolId: "failed-request",
          functionCall: {
            name: "ask_user",
            parameters: JSON.stringify({
              questions: [{ id: "choice", question: "Choose safely" }],
            }),
          },
        },
        toolReturn: {
          origin: {
            type: "askUser",
            requestId: "failed-request",
            error: "backend exploded",
            questions: [{ id: "choice", question: "Choose safely" }],
          },
          meta: { success: false, done: true },
        },
      },
    });

    expect(event.eventCategory).toBe("tool");
    if (event.eventCategory !== "tool") return;
    expect(event.transitions[0]?.interaction).toMatchObject({
      requestId: "failed-request",
      status: "failed",
      error: "backend exploded",
    });
  });

  it.each([
    {
      name: "timeout",
      origin: { status: "timeout" },
      expected: "timeout",
    },
    {
      name: "cancelled",
      origin: { response: { cancelled: true } },
      expected: "cancelled",
    },
    {
      name: "chat-about-this",
      origin: { response: { chatAboutThis: true } },
      expected: "chat-about-this",
    },
  ])(
    "preserves the explicit Ask User $name terminal when Tool success is false",
    ({ origin, expected }) => {
      const event = mapEvent({
        ...eventDto,
        eventId: `ask-user-${expected}`,
        eventScene: "Tool",
        status: "success",
        content: {
          toolCall: {
            toolId: `request-${expected}`,
            functionCall: {
              name: "ask_user",
              parameters: JSON.stringify({
                questions: [{ id: "choice", question: "Choose safely" }],
              }),
            },
          },
          toolReturn: {
            origin: {
              type: "askUser",
              requestId: `request-${expected}`,
              questions: [{ id: "choice", question: "Choose safely" }],
              ...origin,
            },
            meta: { success: false, done: true },
          },
        },
      });

      expect(event.eventCategory).toBe("tool");
      if (event.eventCategory !== "tool") return;
      expect(event.transitions[0]?.interaction?.status).toBe(expected);
    },
  );

  it("normalizes reserved historical Ask User IDs to stable safe indexes", () => {
    const event = mapEvent({
      ...eventDto,
      eventId: "ask-user-reserved-id",
      eventScene: "Tool",
      status: "success",
      content: {
        toolCall: {
          toolId: "request-reserved-id",
          functionCall: { name: "ask_user", parameters: "{}" },
        },
        toolReturn: {
          origin: {
            type: "askUser",
            requestId: "request-reserved-id",
            status: "answered",
            questions: [
              {
                id: "__proto__",
                question: "Choose safely",
                options: [],
              },
            ],
            response: {
              answers: JSON.parse('{"__proto__":"visible answer"}'),
            },
          },
          meta: { success: true, done: true },
        },
      },
    });

    expect(event.eventCategory).toBe("tool");
    if (event.eventCategory !== "tool") return;
    expect(event.transitions[0]?.interaction).toMatchObject({
      questions: [{ id: "0" }],
      answers: { "0": "visible answer" },
    });
  });

  it("sanitizes and bounds string Ask User option values", () => {
    const secret = `api_key=sk-${"a".repeat(60)}`;
    const event = mapEvent({
      ...eventDto,
      eventId: "ask-user-string-option",
      eventScene: "Tool",
      status: "success",
      content: {
        toolCall: {
          toolId: "request-string-option",
          functionCall: { name: "ask_user", parameters: "{}" },
        },
        toolReturn: {
          origin: {
            type: "askUser",
            requestId: "request-string-option",
            status: "answered",
            questions: [
              {
                question: "Choose safely",
                options: [secret, "x".repeat(5_000)],
              },
            ],
          },
          meta: { success: true, done: true },
        },
      },
    });

    expect(event.eventCategory).toBe("tool");
    if (event.eventCategory !== "tool") return;
    const options =
      event.transitions[0]?.interaction?.questions[0]?.options ?? [];
    expect(options[0]).toEqual({ label: "[REDACTED]", value: "[REDACTED]" });
    expect(options[1]?.label).toHaveLength(2_000);
    expect(options[1]?.value).toHaveLength(2_000);
  });

  it("loads conversations, history and status through validated DTOs", async () => {
    const requests: Request[] = [];
    const fetch = vi.fn(
      async (
        input: Parameters<typeof globalThis.fetch>[0],
        init?: Parameters<typeof globalThis.fetch>[1],
      ) => {
        const request = new Request(input, init);
        requests.push(request);
        const url = new URL(request.url);
        if (url.pathname.endsWith("/conversations")) {
          return envelope({
            conversations: [
              {
                ...conversationDto,
                futureOptionalField: "tolerated",
                token: "conversation-secret",
              },
            ],
            cursor: "next-page",
          });
        }
        if (url.pathname.endsWith("/messages")) {
          return envelope({
            messages: [messageDto],
            events: [eventDto],
            cursor: "previous-page",
          });
        }
        if (url.pathname.endsWith("/status")) {
          return envelope({ working: true, taskId: "run-1" });
        }
        throw new Error(`Unexpected request: ${url.pathname}`);
      },
    );
    const gateway = createTFRobotChatGateway({
      baseUrl: "https://robot.example/",
      messageCreatorProvider,
      sessionProvider: sessionProvider(),
      platformId: 7,
      fetch,
      socketFactory: createSocketFixture().factory,
    });

    const listed = await gateway.listConversations({
      limit: 10,
      deadlineAt: deadline(),
    });
    expect(listed).toMatchObject({
      ok: true,
      value: {
        nextCursor: "next-page",
        conversations: [
          {
            id: "42",
            title: "Gateway conversation",
            updatedAt: 1_773_705_600_000,
          },
        ],
      },
    });
    if (!listed.ok) return;
    expect(listed.value.conversations[0]?.raw).toMatchObject({
      futureOptionalField: "tolerated",
      token: "[REDACTED]",
    });

    const loaded = await gateway.loadConversation({
      conversationId: "42",
      limit: 20,
      deadlineAt: deadline(),
    });
    expect(loaded).toMatchObject({
      ok: true,
      value: {
        conversation: { id: "42", title: "Gateway conversation" },
        pageInfo: {
          hasPreviousPage: true,
          previousCursor: "previous-page",
        },
        run: {
          id: "run-1",
          status: "running",
          canInterrupt: true,
        },
      },
    });
    if (!loaded.ok) return;
    expect(loaded.value.timeline.map(({ kind }) => kind)).toEqual([
      "message",
      "agent-event",
    ]);
    expect(JSON.stringify(loaded.value)).not.toContain("message-secret");
    expect(
      requests.every(
        (request) =>
          request.headers.get("Authorization") ===
          "Bearer header.payload.signature",
      ),
    ).toBe(true);
    expect(requests[0]?.url).toContain("platformId=7");
    expect(requests[0]?.url).toContain("count=10");
    expect(requests[1]?.url).toContain("count=-20");
  });

  it("maps structured reasoning text and redacts opaque entries", async () => {
    const fetch = vi.fn(
      async (input: Parameters<typeof globalThis.fetch>[0]) => {
        const path = new URL(input instanceof Request ? input.url : input)
          .pathname;
        if (path.endsWith("/conversations")) {
          return envelope({ conversations: [conversationDto], cursor: null });
        }
        if (path.endsWith("/messages")) {
          return envelope({
            messages: [
              {
                ...messageDto,
                role: "assistant",
                reasoningContent: [
                  {
                    reasoningContent: "Frozen baseline thought",
                  },
                  {
                    kind: "thinking",
                    text: "First thought",
                    signature: "reasoning-signature-secret",
                  },
                  {
                    kind: "encrypted_content",
                    provider: "example",
                    token: "opaque-reasoning-secret",
                  },
                ],
              },
            ],
            events: [],
            cursor: null,
          });
        }
        return envelope({ working: false, taskId: null });
      },
    );
    const gateway = createTFRobotChatGateway({
      baseUrl: "https://robot.example/",
      messageCreatorProvider,
      sessionProvider: sessionProvider(),
      fetch,
      socketFactory: createSocketFixture().factory,
    });

    const result = await gateway.loadConversation({
      conversationId: "42",
      deadlineAt: deadline(),
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        timeline: [
          {
            kind: "message",
            reasoning: "Frozen baseline thought\n\nFirst thought",
            raw: {
              reasoningContent: [
                {
                  reasoningContent: "Frozen baseline thought",
                },
                {
                  kind: "thinking",
                  signature: "[REDACTED]",
                },
                {
                  kind: "encrypted_content",
                  token: "[REDACTED]",
                },
              ],
            },
          },
        ],
      },
    });
    expect(JSON.stringify(result)).not.toContain("reasoning-secret");
  });

  it("fails closed when Server reports working without a transport taskId", async () => {
    const fetch = vi.fn(
      async (input: Parameters<typeof globalThis.fetch>[0]) => {
        const path = new URL(input instanceof Request ? input.url : input)
          .pathname;
        if (path.endsWith("/conversations")) {
          return envelope({ conversations: [conversationDto], cursor: null });
        }
        if (path.endsWith("/messages")) {
          return envelope({ messages: [], events: [], cursor: null });
        }
        return envelope({ working: true, taskId: null });
      },
    );
    const gateway = createTFRobotChatGateway({
      baseUrl: "https://robot.example/",
      messageCreatorProvider,
      sessionProvider: sessionProvider(),
      fetch,
      socketFactory: createSocketFixture().factory,
    });

    const result = await gateway.loadConversation({
      conversationId: "42",
      deadlineAt: deadline(),
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        run: {
          id: "run:42:active",
          status: "running",
          canInterrupt: false,
        },
      },
    });
    const requestCount = fetch.mock.calls.length;
    await expect(
      gateway.interrupt({
        conversationId: "42",
        runId: "run:42:active",
        deadlineAt: deadline(),
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "conflict" },
    });
    await expect(
      gateway.interrupt({
        conversationId: "42",
        deadlineAt: deadline(),
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "conflict" },
    });
    expect(fetch).toHaveBeenCalledTimes(requestCount);
  });

  it("maps send and stale-safe interrupt results without leaking DTOs", async () => {
    const bodies: unknown[] = [];
    const fetch = vi.fn(
      async (
        input: Parameters<typeof globalThis.fetch>[0],
        init?: Parameters<typeof globalThis.fetch>[1],
      ) => {
        bodies.push(
          init?.body === undefined
            ? undefined
            : JSON.parse(init.body as string),
        );
        const path = new URL(input instanceof Request ? input.url : input)
          .pathname;
        return path.endsWith("/interrupt")
          ? envelope({ taskId: "cancel-1" })
          : envelope({ taskId: "run-accepted" });
      },
    );
    const gateway = createTFRobotChatGateway({
      baseUrl: "https://robot.example/",
      messageCreatorProvider,
      sessionProvider: sessionProvider({
        kind: "admin",
        adminKey: "admin-secret",
      }),
      fetch,
      socketFactory: createSocketFixture().factory,
    });

    await expect(
      gateway.sendText({
        conversationId: "42",
        text: "Hello",
        clientMessageId: "client-1",
        deadlineAt: deadline(),
      }),
    ).resolves.toEqual({
      ok: true,
      value: { runId: "run-accepted" },
    });
    await expect(
      gateway.interrupt({
        conversationId: "42",
        runId: "run-accepted",
        deadlineAt: deadline(),
      }),
    ).resolves.toEqual({
      ok: true,
      value: {
        cancellationId: "cancel-1",
        interruptedRunId: "run-accepted",
      },
    });
    expect(bodies).toEqual([
      expect.objectContaining({
        msgId: "client-1",
        conversationId: "42",
        content: "Hello",
        creator: {
          uid: "current-user",
          name: "Current user",
        },
      }),
      { taskId: "run-accepted" },
    ]);
    expect(JSON.stringify(bodies)).not.toContain("admin-secret");
  });

  it("rejects an invalid current-user creator before sending", async () => {
    const fetch = vi.fn();
    const gateway = createTFRobotChatGateway({
      baseUrl: "https://robot.example/",
      messageCreatorProvider: () => ({ uid: "", name: "" }),
      sessionProvider: sessionProvider(),
      fetch,
      socketFactory: createSocketFixture().factory,
    });

    await expect(
      gateway.sendText({
        conversationId: "42",
        text: "Hello",
        deadlineAt: deadline(),
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: "validation",
        message: "messageCreatorProvider returned an invalid creator",
      },
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("classifies authentication failures and invalidates the host session", async () => {
    const provider = sessionProvider();
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            detail: "Expired Authorization: Bearer header.payload.signature",
          }),
          {
            status: 401,
            headers: { "Content-Type": "application/json" },
          },
        ),
    );
    const gateway = createTFRobotChatGateway({
      baseUrl: "https://robot.example/",
      messageCreatorProvider,
      sessionProvider: provider,
      fetch,
      socketFactory: createSocketFixture().factory,
    });

    const result = await gateway.listConversations({
      deadlineAt: deadline(),
    });
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "authentication",
        retryable: false,
      },
    });
    expect(JSON.stringify(result)).not.toContain("header.payload.signature");
    expect(provider.onSessionInvalid).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "expired" }),
    );
  });

  it("bounds host hooks and transport work while isolating invalidation callbacks", async () => {
    vi.useFakeTimers();
    try {
      const hangingGateway = createTFRobotChatGateway({
        baseUrl: "https://robot.example/",
        messageCreatorProvider,
        sessionProvider: {
          getSession: () => new Promise<TFRobotSession>(() => undefined),
        },
        fetch: vi.fn(),
        socketFactory: createSocketFixture().factory,
        now: () => Date.now(),
      });
      const pending = hangingGateway.listConversations({
        deadlineAt: Date.now() + 100,
      });
      await vi.advanceTimersByTimeAsync(100);
      await expect(pending).resolves.toMatchObject({
        ok: false,
        error: { code: "timeout" },
      });

      const hangingFetchGateway = createTFRobotChatGateway({
        baseUrl: "https://robot.example/",
        messageCreatorProvider,
        sessionProvider: sessionProvider(),
        fetch: vi.fn(() => new Promise<Response>(() => undefined)),
        socketFactory: createSocketFixture().factory,
        now: () => Date.now(),
      });
      const pendingFetch = hangingFetchGateway.listConversations({
        deadlineAt: Date.now() + 100,
      });
      await vi.advanceTimersByTimeAsync(100);
      await expect(pendingFetch).resolves.toMatchObject({
        ok: false,
        error: { code: "timeout" },
      });

      const hangingCreatorGateway = createTFRobotChatGateway({
        baseUrl: "https://robot.example/",
        messageCreatorProvider: () => new Promise<never>(() => undefined),
        sessionProvider: sessionProvider(),
        fetch: vi.fn(),
        socketFactory: createSocketFixture().factory,
        now: () => Date.now(),
      });
      const pendingCreator = hangingCreatorGateway.sendText({
        conversationId: "42",
        text: "Hello",
        deadlineAt: Date.now() + 100,
      });
      await vi.advanceTimersByTimeAsync(100);
      await expect(pendingCreator).resolves.toMatchObject({
        ok: false,
        error: { code: "timeout" },
      });

      const onSessionInvalid = vi.fn(() => new Promise<void>(() => undefined));
      const rejectedGateway = createTFRobotChatGateway({
        baseUrl: "https://robot.example/",
        messageCreatorProvider,
        sessionProvider: {
          getSession: () => ({
            kind: "bearer",
            token: "header.payload.signature",
          }),
          onSessionInvalid,
        },
        fetch: vi.fn(
          async () =>
            new Response("Unauthorized", {
              status: 401,
            }),
        ),
        socketFactory: createSocketFixture().factory,
      });
      const rejected = rejectedGateway.listConversations({
        deadlineAt: Date.now() + 100,
      });
      await vi.advanceTimersByTimeAsync(0);
      await expect(rejected).resolves.toMatchObject({
        ok: false,
        error: { code: "authentication" },
      });
      expect(onSessionInvalid).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects response parsing that synchronously crosses its deadline", async () => {
    let now = 0;
    const response = envelope({ conversations: [], cursor: null });
    vi.spyOn(response, "json").mockImplementation(async () => {
      now = 100;
      return { code: 200, message: "Success", data: { conversations: [] } };
    });
    const gateway = createTFRobotChatGateway({
      baseUrl: "https://robot.example/",
      messageCreatorProvider,
      sessionProvider: sessionProvider(),
      fetch: vi.fn(async () => response),
      socketFactory: createSocketFixture().factory,
      now: () => now,
    });

    await expect(
      gateway.listConversations({ deadlineAt: 50 }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "timeout" },
    });
  });

  it("rejects malformed DTOs and expired deadlines", async () => {
    const fetch = vi.fn(async () =>
      envelope({ conversations: [{ conversationId: 42 }], cursor: null }),
    );
    const gateway = createTFRobotChatGateway({
      baseUrl: "https://robot.example/",
      messageCreatorProvider,
      sessionProvider: sessionProvider(),
      fetch,
      socketFactory: createSocketFixture().factory,
    });

    await expect(
      gateway.listConversations({ deadlineAt: deadline() }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "validation" },
    });
    await expect(
      gateway.listConversations({ deadlineAt: 0 }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "timeout" },
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed sessions and credential-bearing endpoints", async () => {
    const fetch = vi.fn();
    const gateway = createTFRobotChatGateway({
      baseUrl: "https://robot.example/",
      messageCreatorProvider,
      sessionProvider: {
        getSession: () => ({ kind: "bearer", token: "" }) as TFRobotSession,
      },
      fetch,
      socketFactory: createSocketFixture().factory,
    });
    await expect(
      gateway.listConversations({ deadlineAt: deadline() }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "authentication" },
    });
    expect(fetch).not.toHaveBeenCalled();

    expect(() =>
      createTFRobotChatGateway({
        baseUrl: "https://user:password@robot.example/",
        messageCreatorProvider,
        sessionProvider: sessionProvider(),
        fetch,
        socketFactory: createSocketFixture().factory,
      }),
    ).toThrow("must not contain URL credentials");
  });
});

describe("TFRobotChatGateway Socket boundary", () => {
  it("joins, maps realtime updates, filters foreign data and falls back safely", async () => {
    const socketFixture = createSocketFixture();
    const updates: ChatUpdate[] = [];
    const errors: ChatError[] = [];
    const diagnostics: ChatError[] = [];
    const gateway = createTFRobotChatGateway({
      baseUrl: "https://robot.example/api/",
      messageCreatorProvider,
      sessionProvider: sessionProvider(),
      fetch: vi.fn(),
      socketFactory: socketFixture.factory,
      now: () => 1_773_705_600_500,
      onDiagnostic: (error) => {
        diagnostics.push(error);
      },
    });
    const subscribed = await gateway.subscribe(
      { conversationId: "42", deadlineAt: deadline() },
      {
        next: (update) => updates.push(update),
        error: (error) => errors.push(error),
      },
    );
    expect(subscribed.ok).toBe(true);
    if (!subscribed.ok) return;
    const socket = socketFixture.sockets[0]!;
    expect(socketFixture.inputs[0]).toMatchObject({
      namespaceUrl: "https://robot.example/chat",
      path: "/socket.io",
    });
    expect(socket.emitted).toEqual([
      ["join_conversation", { conversation_id: "42" }],
    ]);

    socket.trigger("chat_message", messageDto);
    socket.trigger("chat_message", { ...messageDto, conversationId: 99 });
    socket.trigger("chat_event", eventDto);
    socket.trigger("chat_message", { conversationId: 99 });
    socket.trigger("chat_event", { conversationId: 99 });
    socket.trigger("conversation_state_changed", { conversationId: 99 });
    socket.trigger("chat_error", { conversationId: 99 });
    socket.trigger("future_event", {
      conversationId: 99,
      safe: false,
    });
    expect(errors).toEqual([]);
    expect(diagnostics).toEqual([]);
    socket.trigger("future_event token=event-name-secret", {
      conversationId: 42,
      cookie: "sensitive",
      safe: true,
      summary: "Failure token=summary-secret",
    });
    expect(updates.map(({ kind }) => kind)).toEqual([
      "timeline.upsert",
      "event.transition.upsert",
      "timeline.upsert",
    ]);
    expect(JSON.stringify(updates)).not.toContain("sensitive");
    expect(JSON.stringify(updates)).not.toContain("event-name-secret");
    expect(JSON.stringify(updates)).not.toContain("summary-secret");
    expect(updates.at(-1)).toMatchObject({
      kind: "timeline.upsert",
      item: {
        kind: "unknown-event",
        originalType: "future_event token=[REDACTED]",
        summary: "Failure token=[REDACTED]",
      },
    });

    socket.trigger("conversation_state_changed", {
      conversationId: 42,
      state: "working",
      taskId: "run-live",
    });
    socket.trigger("chat_error", {
      conversationId: 99,
      error: "Foreign failure",
    });
    socket.trigger("chat_error", {
      conversationId: 42,
      error: "Run failed token=secret-value",
    });
    expect(updates.at(-1)).toMatchObject({
      kind: "run.replace",
      run: { id: "run-live", status: "running" },
    });
    expect(errors.at(-1)).toMatchObject({ code: "server" });
    expect(JSON.stringify(errors)).not.toContain("secret-value");

    await subscribed.value.dispose({ deadlineAt: deadline() });
    socket.trigger("chat_message", messageDto);
    expect(updates).toHaveLength(4);
    expect(socket.connected).toBe(false);
  });

  it("bounds initial Socket authentication and prevents late creation after dispose", async () => {
    vi.useFakeTimers();
    try {
      const deadlineSockets = createSocketFixture();
      const deadlineGateway = createTFRobotChatGateway({
        baseUrl: "https://robot.example/",
        messageCreatorProvider,
        sessionProvider: {
          getSession: () => new Promise<TFRobotSession>(() => undefined),
        },
        fetch: vi.fn(),
        socketFactory: deadlineSockets.factory,
        now: () => Date.now(),
      });
      const timedSubscription = deadlineGateway.subscribe(
        { conversationId: "42", deadlineAt: Date.now() + 100 },
        { next: () => undefined },
      );
      await vi.advanceTimersByTimeAsync(100);
      await expect(timedSubscription).resolves.toMatchObject({
        ok: false,
        error: { code: "timeout" },
      });
      expect(deadlineSockets.sockets).toHaveLength(0);

      const disposeSockets = createSocketFixture();
      const disposeGateway = createTFRobotChatGateway({
        baseUrl: "https://robot.example/",
        messageCreatorProvider,
        sessionProvider: {
          getSession: () => new Promise<TFRobotSession>(() => undefined),
        },
        fetch: vi.fn(),
        socketFactory: disposeSockets.factory,
      });
      const disposedSubscription = disposeGateway.subscribe(
        { conversationId: "42", deadlineAt: Date.now() + 1_000 },
        { next: () => undefined },
      );
      await disposeGateway.dispose({ deadlineAt: Date.now() + 1_000 });
      await expect(disposedSubscription).resolves.toMatchObject({
        ok: false,
        error: { code: "conflict" },
      });
      expect(disposeSockets.sockets).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("contains synchronous Socket transport failures and cleans up best-effort", async () => {
    const createGateway = (socketFactory: () => TFRobotSocket) =>
      createTFRobotChatGateway({
        baseUrl: "https://robot.example/",
        messageCreatorProvider,
        sessionProvider: sessionProvider(),
        fetch: vi.fn(),
        socketFactory,
      });
    const input = { conversationId: "42", deadlineAt: deadline() };
    const observer = { next: () => undefined };

    const factoryFailure = createGateway(() => {
      throw new Error("factory token=factory-secret");
    });
    await expect(
      factoryFailure.subscribe(input, observer),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "network" },
    });

    class SetupFailureSocket extends FakeSocket {
      override on(): void {
        throw new Error("listener setup failed");
      }
    }
    await expect(
      createGateway(() => new SetupFailureSocket()).subscribe(input, observer),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "network" },
    });

    class ConnectFailureSocket extends FakeSocket {
      override connect(): void {
        throw new Error("connect failed");
      }
      override disconnect(): void {
        throw new Error("cleanup disconnect failed");
      }
    }
    await expect(
      createGateway(() => new ConnectFailureSocket()).subscribe(
        input,
        observer,
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "network" },
    });

    class JoinFailureSocket extends FakeSocket {
      override emit(): void {
        throw new Error("join failed");
      }
    }
    await expect(
      createGateway(() => new JoinFailureSocket()).subscribe(input, observer),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "network" },
    });

    class CleanupFailureSocket extends FakeSocket {
      override disconnect(): void {
        throw new Error("disconnect failed");
      }
      override off(): void {
        throw new Error("listener cleanup failed");
      }
      override offAny(): void {
        throw new Error("catch-all cleanup failed");
      }
    }
    const cleanupSocket = new CleanupFailureSocket();
    const cleanupGateway = createGateway(() => cleanupSocket);
    const subscribed = await cleanupGateway.subscribe(input, observer);
    expect(subscribed.ok).toBe(true);
    if (!subscribed.ok) return;
    expect(() =>
      subscribed.value.dispose({ deadlineAt: deadline() }),
    ).not.toThrow();
    expect(() =>
      cleanupSocket.trigger("chat_message", messageDto),
    ).not.toThrow();
  });

  it("rejects a synchronous connection that crosses its establishment deadline", async () => {
    let now = 0;
    class DeadlineCrossingSocket extends FakeSocket {
      override connect(): void {
        now = 100;
        super.connect();
      }
    }
    const socket = new DeadlineCrossingSocket();
    const gateway = createTFRobotChatGateway({
      baseUrl: "https://robot.example/",
      messageCreatorProvider,
      sessionProvider: sessionProvider(),
      fetch: vi.fn(),
      socketFactory: () => socket,
      now: () => now,
    });

    await expect(
      gateway.subscribe(
        { conversationId: "42", deadlineAt: 50 },
        { next: () => undefined },
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "timeout" },
    });
    expect(socket.emitted).toEqual([]);
    expect(socket.connected).toBe(false);
  });

  it("rejects a synchronous join that crosses its establishment deadline", async () => {
    let now = 0;
    class DeadlineCrossingJoinSocket extends FakeSocket {
      override emit(eventName: string, payload?: unknown): void {
        super.emit(eventName, payload);
        now = 100;
      }
    }
    const socket = new DeadlineCrossingJoinSocket();
    const updates: ChatUpdate[] = [];
    const errors: ChatError[] = [];
    const gateway = createTFRobotChatGateway({
      baseUrl: "https://robot.example/",
      messageCreatorProvider,
      sessionProvider: sessionProvider(),
      fetch: vi.fn(),
      socketFactory: () => socket,
      now: () => now,
    });

    await expect(
      gateway.subscribe(
        { conversationId: "42", deadlineAt: 50 },
        {
          next: (update) => updates.push(update),
          error: (error) => errors.push(error),
        },
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "timeout" },
    });
    expect(socket.emitted).toEqual([
      ["join_conversation", { conversation_id: "42" }],
    ]);
    expect(socket.connected).toBe(false);
    socket.trigger("chat_message", messageDto);
    expect(updates).toEqual([]);
    expect(errors).toEqual([]);
  });

  it("reconciles the run status through REST after reconnect", async () => {
    const socketFixture = createSocketFixture();
    const updates: ChatUpdate[] = [];
    const fetch = vi.fn(async () => envelope({ working: false, taskId: null }));
    const gateway = createTFRobotChatGateway({
      baseUrl: "https://robot.example/",
      messageCreatorProvider,
      sessionProvider: sessionProvider(),
      fetch,
      socketFactory: socketFixture.factory,
    });
    const subscribed = await gateway.subscribe(
      { conversationId: "42", deadlineAt: deadline() },
      { next: (update) => updates.push(update) },
    );
    expect(subscribed.ok).toBe(true);
    if (!subscribed.ok) return;
    const socket = socketFixture.sockets[0]!;
    socket.trigger("conversation_state_changed", {
      conversationId: 42,
      state: "working",
      taskId: "run-before-disconnect",
    });
    updates.length = 0;

    socket.trigger("disconnect", "transport close");
    socket.connect();

    await vi.waitFor(() => {
      expect(fetch).toHaveBeenCalledOnce();
      expect(updates).toEqual([
        {
          kind: "run.replace",
          conversationId: "42",
          run: null,
        },
      ]);
    });
    expect(socket.emitted).toEqual([
      ["join_conversation", { conversation_id: "42" }],
      ["join_conversation", { conversation_id: "42" }],
    ]);
  });

  it("discards stale reconnect status after realtime updates or a newer reconnect", async () => {
    const socketFixture = createSocketFixture();
    const responses: Array<ReturnType<typeof deferred<Response>>> = [];
    const updates: ChatUpdate[] = [];
    const fetch = vi.fn(() => {
      const response = deferred<Response>();
      responses.push(response);
      return response.promise;
    });
    const gateway = createTFRobotChatGateway({
      baseUrl: "https://robot.example/",
      messageCreatorProvider,
      sessionProvider: sessionProvider(),
      fetch,
      socketFactory: socketFixture.factory,
    });
    const subscribed = await gateway.subscribe(
      { conversationId: "42", deadlineAt: deadline() },
      { next: (update) => updates.push(update) },
    );
    expect(subscribed.ok).toBe(true);
    if (!subscribed.ok) return;
    const socket = socketFixture.sockets[0]!;

    socket.connected = false;
    socket.trigger("disconnect", "transport close");
    socket.connect();
    await vi.waitFor(() => expect(responses).toHaveLength(1));
    socket.trigger("conversation_state_changed", {
      conversationId: 42,
      state: "working",
      taskId: "run-from-realtime",
    });
    responses[0]!.resolve(envelope({ working: false, taskId: null }));
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    expect(updates.at(-1)).toMatchObject({
      kind: "run.replace",
      run: { id: "run-from-realtime" },
    });

    updates.length = 0;
    socket.connected = false;
    socket.trigger("disconnect", "transport close");
    socket.connect();
    await vi.waitFor(() => expect(responses).toHaveLength(2));
    socket.connected = false;
    socket.trigger("disconnect", "transport close");
    socket.connect();
    await vi.waitFor(() => expect(responses).toHaveLength(3));

    responses[2]!.resolve(
      envelope({ working: true, taskId: "run-from-newest-reconnect" }),
    );
    await vi.waitFor(() =>
      expect(updates.at(-1)).toMatchObject({
        kind: "run.replace",
        run: { id: "run-from-newest-reconnect" },
      }),
    );
    responses[1]!.resolve(envelope({ working: false, taskId: null }));
    await Promise.resolve();
    await Promise.resolve();
    expect(updates).toHaveLength(1);
  });

  it("reports malformed realtime DTOs without throwing or clearing run state", async () => {
    const socketFixture = createSocketFixture();
    const updates: ChatUpdate[] = [];
    const errors: ChatError[] = [];
    const gateway = createTFRobotChatGateway({
      baseUrl: "https://robot.example/",
      messageCreatorProvider,
      sessionProvider: sessionProvider(),
      fetch: vi.fn(),
      socketFactory: socketFixture.factory,
    });
    const subscribed = await gateway.subscribe(
      { conversationId: "42", deadlineAt: deadline() },
      {
        next: (update) => updates.push(update),
        error: (error) => errors.push(error),
      },
    );
    expect(subscribed.ok).toBe(true);
    if (!subscribed.ok) return;
    const socket = socketFixture.sockets[0]!;

    socket.trigger("chat_message", {
      ...messageDto,
      role: "assistant",
      reasoningContent: [{ reasoningContent: "Frozen realtime thought" }],
    });
    expect(updates.at(-1)).toMatchObject({
      kind: "timeline.upsert",
      item: {
        reasoning: "Frozen realtime thought",
      },
    });
    updates.length = 0;

    expect(() => {
      socket.trigger("chat_message", { ...messageDto, conversationId: "" });
      socket.trigger("conversation_state_changed", {
        conversationId: 42,
        state: "bogus",
        taskId: "run-1",
      });
      socket.trigger("chat_error", {
        error: "Missing conversation",
      });
    }).not.toThrow();
    expect(updates).toEqual([]);
    expect(errors).toHaveLength(3);
    expect(errors.every(({ code }) => code === "validation")).toBe(true);
  });

  it("isolates throwing observers from Socket listeners and diagnostics", async () => {
    const socketFixture = createSocketFixture();
    const diagnostics: ChatError[] = [];
    const gateway = createTFRobotChatGateway({
      baseUrl: "https://robot.example/",
      messageCreatorProvider,
      sessionProvider: sessionProvider(),
      fetch: vi.fn(),
      socketFactory: socketFixture.factory,
      onDiagnostic: (error) => {
        diagnostics.push(error);
      },
    });
    const subscribed = await gateway.subscribe(
      { conversationId: "42", deadlineAt: deadline() },
      {
        next: () => {
          throw new Error("observer next failed");
        },
        error: () => {
          throw new Error("observer error failed");
        },
      },
    );
    expect(subscribed.ok).toBe(true);
    if (!subscribed.ok) return;
    const socket = socketFixture.sockets[0]!;

    expect(() => {
      socket.trigger("chat_message", messageDto);
      socket.trigger("chat_message", { ...messageDto, conversationId: "" });
    }).not.toThrow();
    await vi.waitFor(() => expect(diagnostics).toHaveLength(2));
    expect(diagnostics.map(({ code }) => code)).toEqual([
      "unknown",
      "validation",
    ]);
  });

  it("isolates replacement subscriptions and Gateway instances", async () => {
    const firstSockets = createSocketFixture();
    const secondSockets = createSocketFixture();
    const firstUpdates: ChatUpdate[] = [];
    const replacementUpdates: ChatUpdate[] = [];
    const secondUpdates: ChatUpdate[] = [];
    const firstGateway = createTFRobotChatGateway({
      baseUrl: "https://first.example/",
      messageCreatorProvider,
      sessionProvider: sessionProvider(),
      fetch: vi.fn(),
      socketFactory: firstSockets.factory,
    });
    const secondGateway = createTFRobotChatGateway({
      baseUrl: "https://second.example/",
      messageCreatorProvider,
      sessionProvider: sessionProvider(),
      fetch: vi.fn(),
      socketFactory: secondSockets.factory,
    });
    const firstSubscription = await firstGateway.subscribe(
      { conversationId: "42", deadlineAt: deadline() },
      { next: (update) => firstUpdates.push(update) },
    );
    const replacementSubscription = await firstGateway.subscribe(
      { conversationId: "99", deadlineAt: deadline() },
      { next: (update) => replacementUpdates.push(update) },
    );
    const secondSubscription = await secondGateway.subscribe(
      { conversationId: "42", deadlineAt: deadline() },
      { next: (update) => secondUpdates.push(update) },
    );
    expect(firstSubscription.ok).toBe(true);
    expect(replacementSubscription.ok).toBe(true);
    expect(secondSubscription.ok).toBe(true);

    firstSockets.sockets[0]!.trigger("chat_message", messageDto);
    firstSockets.sockets[1]!.trigger("chat_message", {
      ...messageDto,
      conversationId: 99,
    });
    secondSockets.sockets[0]!.trigger("chat_message", messageDto);
    expect(firstUpdates).toEqual([]);
    expect(replacementUpdates).toHaveLength(1);
    expect(secondUpdates).toHaveLength(1);

    await firstGateway.dispose({ deadlineAt: deadline() });
    secondSockets.sockets[0]!.trigger("chat_message", messageDto);
    expect(secondUpdates).toHaveLength(2);
    await secondGateway.dispose({ deadlineAt: deadline() });
  });

  it("refreshes Socket authentication and reports sanitized expiry", async () => {
    const socketFixture = createSocketFixture();
    const getSession = vi
      .fn()
      .mockReturnValueOnce({
        kind: "bearer",
        token: "initial.header.signature",
      })
      .mockRejectedValueOnce(
        new Error("Refresh failed token=reconnect-secret"),
      );
    const onSessionInvalid = vi.fn();
    const errors: ChatError[] = [];
    const gateway = createTFRobotChatGateway({
      baseUrl: "https://robot.example/",
      messageCreatorProvider,
      sessionProvider: { getSession, onSessionInvalid },
      fetch: vi.fn(),
      socketFactory: socketFixture.factory,
    });
    const subscribed = await gateway.subscribe(
      { conversationId: "42", deadlineAt: deadline() },
      {
        next: () => undefined,
        error: (error) => errors.push(error),
      },
    );
    expect(subscribed.ok).toBe(true);
    if (!subscribed.ok) return;

    await expect(socketFixture.inputs[0]!.getAuth()).resolves.toEqual({
      token: "initial.header.signature",
    });
    await expect(socketFixture.inputs[0]!.getAuth()).rejects.toThrow(
      "Refresh failed",
    );
    socketFixture.sockets[0]!.trigger(
      "connect_error",
      new Error("transport rejected"),
    );
    await vi.waitFor(() => expect(onSessionInvalid).toHaveBeenCalledOnce());
    expect(errors.at(-1)).toMatchObject({
      code: "authentication",
      retryable: true,
    });
    expect(JSON.stringify(errors)).not.toContain("reconnect-secret");
    await subscribed.value.dispose({ deadlineAt: deadline() });
  });

  it("classifies an explicit Socket handshake rejection and invalidates the session", async () => {
    const socketFixture = createSocketFixture();
    const onSessionInvalid = vi.fn();
    const errors: ChatError[] = [];
    const gateway = createTFRobotChatGateway({
      baseUrl: "https://robot.example/",
      messageCreatorProvider,
      sessionProvider: {
        getSession: () => ({
          kind: "bearer",
          token: "header.payload.signature",
        }),
        onSessionInvalid,
      },
      fetch: vi.fn(),
      socketFactory: socketFixture.factory,
    });
    const subscribed = await gateway.subscribe(
      { conversationId: "42", deadlineAt: deadline() },
      {
        next: () => undefined,
        error: (error) => errors.push(error),
      },
    );
    expect(subscribed.ok).toBe(true);
    if (!subscribed.ok) return;
    const rejection = new Error("Connection rejected by server");

    socketFixture.sockets[0]!.trigger("connect_error", rejection);

    await vi.waitFor(() =>
      expect(onSessionInvalid).toHaveBeenCalledWith(
        expect.objectContaining({ reason: "rejected" }),
      ),
    );
    expect(errors.at(-1)).toMatchObject({
      code: "authentication",
      retryable: false,
    });
  });
});
