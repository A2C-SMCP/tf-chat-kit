import { describe, expect, it, vi } from "vitest";

import {
  createTFRobotChatGateway,
  type TFRobotSession,
  type TFRobotSocket,
  type TFRobotSocketAnyListener,
  type TFRobotSocketFactoryInput,
  type TFRobotSocketListener,
} from "../packages/chat-gateway-tfrobot/src/index.js";
import {
  mapEvent,
  mapEventUpdate,
} from "../packages/chat-gateway-tfrobot/src/mapper.js";
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
  it("invokes the browser global fetch with its required Window receiver", async () => {
    const browserFetch = vi.fn(function (this: typeof globalThis) {
      if (this !== globalThis) {
        throw new TypeError("Failed to execute 'fetch': Illegal invocation");
      }
      return Promise.resolve(
        envelope({ conversations: [conversationDto], cursor: null }),
      );
    });
    vi.stubGlobal("fetch", browserFetch);
    const gateway = createTFRobotChatGateway({
      baseUrl: "https://robot.example/api/",
      messageCreatorProvider,
      sessionProvider: sessionProvider(),
    });
    try {
      await expect(
        gateway.listConversations({ deadlineAt: deadline() }),
      ).resolves.toMatchObject({
        ok: true,
        value: { conversations: [{ id: "42" }] },
      });
      expect(browserFetch).toHaveBeenCalledOnce();
    } finally {
      gateway.dispose({ deadlineAt: deadline() });
      vi.unstubAllGlobals();
    }
  });

  it.each([
    {
      credentialHeader: "Authorization",
      credentialValue: "Bearer header.payload.signature",
      label: "Bearer token",
      missingHeader: "admin_key",
      session: {
        kind: "bearer" as const,
        token: "header.payload.signature",
      },
    },
    {
      credentialHeader: "admin_key",
      credentialValue: "admin-secret",
      label: "admin key",
      missingHeader: "Authorization",
      session: { kind: "admin" as const, adminKey: "admin-secret" },
    },
  ])(
    "creates and maps a conversation with $label authentication",
    async ({ credentialHeader, credentialValue, missingHeader, session }) => {
      const provider = sessionProvider(session);
      let request: Request | undefined;
      const fetch = vi.fn(
        async (
          input: Parameters<typeof globalThis.fetch>[0],
          init?: Parameters<typeof globalThis.fetch>[1],
        ) => {
          request = new Request(input, init);
          return envelope({
            ...conversationDto,
            futureField: "preserved",
            token: "created-conversation-secret",
          });
        },
      );
      const gateway = createTFRobotChatGateway({
        baseUrl: "https://robot.example/api/",
        messageCreatorProvider,
        sessionProvider: provider,
        platformId: "platform/7",
        fetch,
        socketFactory: createSocketFixture().factory,
      });

      const result = await gateway.createConversation!({
        title: "Created & mapped",
        deadlineAt: deadline(),
      });

      expect(result).toMatchObject({
        ok: true,
        value: {
          id: "42",
          title: "Gateway conversation",
          updatedAt: 1_773_705_600_000,
          raw: {
            futureField: "preserved",
            token: "[REDACTED]",
          },
        },
      });
      expect(request?.method).toBe("POST");
      expect(new URL(request!.url).pathname).toBe("/api/v1/chat/conversations");
      expect(new URL(request!.url).searchParams.get("title")).toBe(
        "Created & mapped",
      );
      expect(new URL(request!.url).searchParams.get("platformId")).toBe(
        "platform/7",
      );
      expect(request?.headers.get(credentialHeader)).toBe(credentialValue);
      expect(request?.headers.get(missingHeader)).toBeNull();
      expect(provider.getSession).toHaveBeenCalledWith({
        purpose: "request",
        operation: "send",
      });
      expect(JSON.stringify(result)).not.toContain(
        "created-conversation-secret",
      );
    },
  );

  it.each([
    {
      credential: { kind: "bearer" as const, token: "cobalt-dawn-47" },
      label: "Bearer token",
      secret: "cobalt-dawn-47",
    },
    {
      credential: { adminKey: "violet-ridge-84", kind: "admin" as const },
      label: "Admin key",
      secret: "violet-ridge-84",
    },
  ])(
    "redacts an opaque exact $label from successful list, create and history payloads",
    async ({ credential, secret }) => {
      const fetch = vi.fn(
        async (
          input: Parameters<typeof globalThis.fetch>[0],
          init?: Parameters<typeof globalThis.fetch>[1],
        ) => {
          const request = new Request(input, init);
          const path = new URL(request.url).pathname;
          if (request.method === "GET" && path.endsWith("/conversations")) {
            return envelope({
              conversations: [
                {
                  ...conversationDto,
                  description: `Description ${secret}`,
                  title: `List ${secret}`,
                },
              ],
              cursor: null,
            });
          }
          if (request.method === "POST" && path.endsWith("/conversations")) {
            return envelope({
              ...conversationDto,
              conversationId: 43,
              title: `Created ${secret}`,
            });
          }
          if (request.method === "GET" && path.endsWith("/messages")) {
            return envelope({
              cursor: null,
              events: [{ ...eventDto, content: `Event ${secret}` }],
              messages: [{ ...messageDto, content: `History ${secret}` }],
            });
          }
          if (request.method === "GET" && path.endsWith("/status")) {
            return envelope({ taskId: null, working: false });
          }
          throw new Error(`Unexpected request: ${request.method} ${path}`);
        },
      );
      const gateway = createTFRobotChatGateway({
        baseUrl: "https://robot.example/",
        messageCreatorProvider,
        sessionProvider: sessionProvider(credential),
        fetch,
        socketFactory: createSocketFixture().factory,
      });

      const listed = await gateway.listConversations({
        deadlineAt: deadline(),
      });
      const created = await gateway.createConversation!({
        deadlineAt: deadline(),
        title: "Created safely",
      });
      const loaded = await gateway.loadConversation({
        conversationId: "42",
        deadlineAt: deadline(),
      });

      expect({ listed, created, loaded }).toMatchObject({
        listed: {
          ok: true,
          value: {
            conversations: [
              {
                description: "Description [REDACTED]",
                title: "List [REDACTED]",
              },
            ],
          },
        },
        created: {
          ok: true,
          value: { title: "Created [REDACTED]" },
        },
        loaded: { ok: true },
      });
      expect(JSON.stringify({ listed, created, loaded })).not.toContain(secret);
      expect(JSON.stringify(loaded)).toContain("[REDACTED]");
    },
  );

  it("caches a created conversation for immediate loading", async () => {
    const requests: Request[] = [];
    let sentBody: unknown;
    const fetch = vi.fn(
      async (
        input: Parameters<typeof globalThis.fetch>[0],
        init?: Parameters<typeof globalThis.fetch>[1],
      ) => {
        const request = new Request(input, init);
        requests.push(request);
        const path = new URL(request.url).pathname;
        if (request.method === "POST" && path.endsWith("/conversations")) {
          return envelope(conversationDto);
        }
        if (request.method === "POST" && path.endsWith("/messages")) {
          sentBody = (await request.json()) as unknown;
          return envelope({ taskId: "run-created" });
        }
        if (path.endsWith("/messages")) {
          return envelope({ messages: [], events: [], cursor: null });
        }
        if (path.endsWith("/status")) {
          return envelope({ working: false, taskId: null });
        }
        throw new Error(`Unexpected request: ${request.method} ${path}`);
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

    const created = await gateway.createConversation!({
      title: "Cached conversation",
      deadlineAt: deadline(),
    });
    expect(created).toMatchObject({ ok: true, value: { id: "42" } });
    await expect(
      gateway.loadConversation({
        conversationId: "42",
        deadlineAt: deadline(),
      }),
    ).resolves.toMatchObject({
      ok: true,
      value: { conversation: { id: "42" } },
    });
    await expect(
      gateway.sendText({
        conversationId: "42",
        text: "Hello",
        deadlineAt: deadline(),
      }),
    ).resolves.toEqual({
      ok: true,
      value: { runId: "run-created" },
    });
    expect(sentBody).toMatchObject({ conversationId: 42 });
    expect(
      requests.filter(
        (request) =>
          request.method === "GET" &&
          new URL(request.url).pathname.endsWith("/conversations"),
      ),
    ).toHaveLength(0);
  });

  it.each([
    ["a missing session", undefined],
    ["an empty bearer token", { kind: "bearer", token: "" }],
    ["an empty admin key", { kind: "admin", adminKey: "" }],
  ])("rejects %s before conversation creation", async (_label, session) => {
    const fetch = vi.fn();
    const gateway = createTFRobotChatGateway({
      baseUrl: "https://robot.example/",
      messageCreatorProvider,
      sessionProvider: {
        getSession: vi.fn(() => session as TFRobotSession),
      },
      fetch,
      socketFactory: createSocketFixture().factory,
    });

    await expect(
      gateway.createConversation!({
        title: "Rejected conversation",
        deadlineAt: deadline(),
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "authentication" },
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    [401, "authentication", "expired"],
    [403, "authorization", "forbidden"],
  ] as const)(
    "maps HTTP %i creation failures without leaking credentials",
    async (status, code, reason) => {
      const provider = sessionProvider({
        kind: "admin",
        adminKey: "admin-secret",
      });
      const fetch = vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              detail:
                "Rejected Authorization: Bearer header.payload.signature admin_key=admin-secret",
            }),
            {
              status,
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

      const result = await gateway.createConversation!({
        title: "Unauthorized conversation",
        deadlineAt: deadline(),
      });
      expect(result).toMatchObject({
        ok: false,
        error: { code, retryable: false },
      });
      expect(provider.onSessionInvalid).toHaveBeenCalledWith(
        expect.objectContaining({ reason }),
      );
      expect(JSON.stringify(result)).not.toContain("header.payload.signature");
      expect(JSON.stringify(result)).not.toContain("admin-secret");
    },
  );

  it("rejects malformed creation DTOs and creation after disposal", async () => {
    const malformedFetch = vi.fn(async () =>
      envelope({ conversationId: null, title: "Malformed" }),
    );
    const malformedGateway = createTFRobotChatGateway({
      baseUrl: "https://robot.example/",
      messageCreatorProvider,
      sessionProvider: sessionProvider(),
      fetch: malformedFetch,
      socketFactory: createSocketFixture().factory,
    });
    await expect(
      malformedGateway.createConversation!({
        title: "Malformed response",
        deadlineAt: deadline(),
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "validation" },
    });

    const disposedFetch = vi.fn();
    const disposedGateway = createTFRobotChatGateway({
      baseUrl: "https://robot.example/",
      messageCreatorProvider,
      sessionProvider: sessionProvider(),
      fetch: disposedFetch,
      socketFactory: createSocketFixture().factory,
    });
    disposedGateway.dispose({ deadlineAt: deadline() });
    await expect(
      disposedGateway.createConversation!({
        title: "Disposed",
        deadlineAt: deadline(),
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "conflict" },
    });
    expect(disposedFetch).not.toHaveBeenCalled();
  });

  it("bounds creation deadlines and aborts in-flight creation on disposal", async () => {
    vi.useFakeTimers();
    try {
      const hangingSessionGateway = createTFRobotChatGateway({
        baseUrl: "https://robot.example/",
        messageCreatorProvider,
        sessionProvider: {
          getSession: () => new Promise<TFRobotSession>(() => undefined),
        },
        fetch: vi.fn(),
        socketFactory: createSocketFixture().factory,
        now: () => Date.now(),
      });
      const timedOut = hangingSessionGateway.createConversation!({
        title: "Timed out",
        deadlineAt: Date.now() + 100,
      });
      await vi.advanceTimersByTimeAsync(100);
      await expect(timedOut).resolves.toMatchObject({
        ok: false,
        error: { code: "timeout" },
      });

      const response = deferred<Response>();
      const fetch = vi.fn(() => response.promise);
      const disposedGateway = createTFRobotChatGateway({
        baseUrl: "https://robot.example/",
        messageCreatorProvider,
        sessionProvider: sessionProvider(),
        fetch,
        socketFactory: createSocketFixture().factory,
        now: () => Date.now(),
      });
      const pending = disposedGateway.createConversation!({
        title: "Disposed in flight",
        deadlineAt: Date.now() + 1_000,
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(fetch).toHaveBeenCalledOnce();
      disposedGateway.dispose({ deadlineAt: Date.now() + 1_000 });
      response.resolve(envelope(conversationDto));
      await expect(pending).resolves.toMatchObject({
        ok: false,
        error: { code: "conflict" },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects creation when disposal lands after HTTP parsing", async () => {
    const holder: {
      gateway?: ReturnType<typeof createTFRobotChatGateway>;
    } = {};
    const parsedConversation = Object.defineProperty(
      {
        title: "Disposed after parsing",
        description: null,
        updateTimestamp: 1_773_705_600_000,
      },
      "conversationId",
      {
        enumerable: true,
        get: () => {
          queueMicrotask(() =>
            holder.gateway?.dispose({ deadlineAt: deadline() }),
          );
          return 42;
        },
      },
    );
    const response = envelope({});
    vi.spyOn(response, "json").mockResolvedValue({
      code: 200,
      message: "Success",
      data: parsedConversation,
    });
    const gateway = createTFRobotChatGateway({
      baseUrl: "https://robot.example/",
      messageCreatorProvider,
      sessionProvider: sessionProvider(),
      fetch: vi.fn(async () => response),
      socketFactory: createSocketFixture().factory,
    });
    holder.gateway = gateway;

    await expect(
      gateway.createConversation!({
        title: "Disposed after parsing",
        deadlineAt: deadline(),
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "conflict" },
    });
    await expect(
      gateway.createConversation!({
        title: "Still disposed",
        deadlineAt: deadline(),
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "conflict" },
    });
  });

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

  it("does not expose transition timestamps as immutable event creation metadata", () => {
    const running = mapEventUpdate({
      ...eventDto,
      eventId: "event-with-transition-timestamps",
      status: "running",
      createTimestamp: 1_773_705_600_100,
    });
    const success = mapEventUpdate({
      ...eventDto,
      eventId: "event-with-transition-timestamps",
      status: "success",
      createTimestamp: 1_773_705_600_200,
    });

    expect(running).toMatchObject({
      kind: "event.transition.upsert",
      event: { transition: { occurredAt: 1_773_705_600_100 } },
    });
    expect(success).toMatchObject({
      kind: "event.transition.upsert",
      event: { transition: { occurredAt: 1_773_705_600_200 } },
    });
    if (
      running.kind !== "event.transition.upsert" ||
      success.kind !== "event.transition.upsert"
    ) {
      throw new TypeError("expected event transition updates");
    }
    expect(running.event).not.toHaveProperty("createdAt");
    expect(success.event).not.toHaveProperty("createdAt");

    const withStableCreationTime = mapEventUpdate({
      ...eventDto,
      eventId: "event-with-stable-creation-time",
      eventCreateTimestamp: 1_773_705_600_000,
    });
    expect(withStableCreationTime).toMatchObject({
      kind: "event.transition.upsert",
      event: { createdAt: 1_773_705_600_000 },
    });
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

  it("preserves a numeric TFRobot conversation id when sending a normalized conversation", async () => {
    let sentBody: unknown;
    const fetch = vi.fn(
      async (
        input: Parameters<typeof globalThis.fetch>[0],
        init?: Parameters<typeof globalThis.fetch>[1],
      ) => {
        const url = new URL(input instanceof Request ? input.url : input);
        if (url.pathname.endsWith("/conversations") && init?.method === "GET") {
          return envelope({ conversations: [conversationDto], cursor: null });
        }
        if (
          url.pathname.endsWith("/conversations/42/messages") &&
          init?.method === "POST"
        ) {
          sentBody = JSON.parse(init.body as string) as unknown;
          return envelope({ taskId: "run-accepted" });
        }
        throw new Error(`Unexpected request: ${url.pathname}`);
      },
    );
    const gateway = createTFRobotChatGateway({
      baseUrl: "https://robot.example/",
      messageCreatorProvider,
      sessionProvider: sessionProvider(),
      fetch,
      socketFactory: createSocketFixture().factory,
    });

    const listed = await gateway.listConversations({
      deadlineAt: deadline(),
    });
    expect(listed).toMatchObject({
      ok: true,
      value: { conversations: [{ id: "42" }] },
    });
    if (!listed.ok) return;

    await expect(
      gateway.sendText({
        conversationId: listed.value.conversations[0]!.id,
        text: "Hello",
        deadlineAt: deadline(),
      }),
    ).resolves.toEqual({
      ok: true,
      value: { runId: "run-accepted" },
    });
    expect(sentBody).toMatchObject({ conversationId: 42 });
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

  it("omits an unknown credential-shaped conversation context from local creator errors", async () => {
    const secret = "actual-credential";
    const getSession = vi.fn(() => ({
      kind: "bearer" as const,
      token: secret,
    }));
    const gateway = createTFRobotChatGateway({
      baseUrl: "https://robot.example/",
      messageCreatorProvider: () => {
        throw new Error(`Creator failed with ${secret}`);
      },
      sessionProvider: { getSession },
      fetch: vi.fn(),
      socketFactory: createSocketFixture().factory,
    });

    const result = await gateway.sendText({
      conversationId: secret,
      text: "Hello",
      deadlineAt: deadline(),
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "validation",
        message: "Unable to obtain the current TFRobot message creator",
      },
    });
    expect(result.ok ? undefined : result.error.conversationId).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(getSession).not.toHaveBeenCalled();
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

  it.each([
    {
      credential: { kind: "bearer" as const, token: "cobalt-dawn-47" },
      label: "Bearer token",
      secret: "cobalt-dawn-47",
    },
    {
      credential: { adminKey: "violet-ridge-84", kind: "admin" as const },
      label: "Admin key",
      secret: "violet-ridge-84",
    },
  ])(
    "redacts an opaque exact $label from create and send HTTP failures",
    async ({ credential, secret }) => {
      const fetch = vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              detail: `RobotServer echoed ${secret} without a label`,
              nested: {
                [secret]: "opaque key",
                "[REDACTED]": "colliding safe key",
                echoed: secret,
                embedded: `before-${secret}-after`,
              },
            }),
            {
              status: 500,
              headers: { "Content-Type": "application/json" },
            },
          ),
      );
      const gateway = createTFRobotChatGateway({
        baseUrl: "https://robot.example/",
        messageCreatorProvider,
        sessionProvider: sessionProvider(credential),
        fetch,
        socketFactory: createSocketFixture().factory,
      });

      const createResult = await gateway.createConversation!({
        deadlineAt: deadline(),
        title: "Will fail safely",
      });
      const sendResult = await gateway.sendText({
        conversationId: secret,
        deadlineAt: deadline(),
        text: "Will also fail safely",
      });

      expect(createResult).toMatchObject({
        ok: false,
        error: {
          code: "server",
          details: {
            payload: {
              nested: {
                echoed: "[REDACTED]",
                embedded: "before-[REDACTED]-after",
              },
            },
          },
          message: "RobotServer echoed [REDACTED] without a label",
        },
      });
      expect(sendResult).toMatchObject({
        ok: false,
        error: {
          code: "server",
          conversationId: "[REDACTED]",
          message: expect.stringContaining("[REDACTED]"),
        },
      });
      expect(JSON.stringify({ createResult, sendResult })).not.toContain(
        secret,
      );
    },
  );

  it.each([
    {
      credential: { kind: "bearer" as const, token: "cobalt-dawn-47" },
      label: "Bearer token",
      secret: "cobalt-dawn-47",
    },
    {
      credential: { adminKey: "violet-ridge-84", kind: "admin" as const },
      label: "Admin key",
      secret: "violet-ridge-84",
    },
  ])(
    "redacts an opaque exact $label from an injected structured HTTP error",
    async ({ credential, secret }) => {
      const gateway = createTFRobotChatGateway({
        baseUrl: "https://robot.example/",
        messageCreatorProvider,
        sessionProvider: sessionProvider(credential),
        fetch: vi.fn(async () => {
          throw {
            code: "network",
            conversationId: secret,
            details: { echoed: secret },
            message: `Injected ${secret}`,
            retryable: true,
          } satisfies ChatError;
        }),
        socketFactory: createSocketFixture().factory,
      });

      const result = await gateway.listConversations({
        deadlineAt: deadline(),
      });

      expect(result).toMatchObject({
        ok: false,
        error: {
          conversationId: "[REDACTED]",
          details: { echoed: "[REDACTED]" },
          message: "Injected [REDACTED]",
        },
      });
      expect(JSON.stringify(result)).not.toContain(secret);
    },
  );

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

  it("does not expose an unavailable SessionProvider credential in HTTP errors", async () => {
    const secret = "provider-only-credential";
    const gateway = createTFRobotChatGateway({
      baseUrl: "https://robot.example/",
      messageCreatorProvider,
      sessionProvider: {
        getSession: () => {
          throw new Error(`Provider failed with ${secret}`);
        },
      },
      fetch: vi.fn(),
      socketFactory: createSocketFixture().factory,
    });

    const result = await gateway.listConversations({
      deadlineAt: deadline(),
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "authentication",
        message: "Unable to obtain a TFRobot session",
      },
    });
    expect(JSON.stringify(result)).not.toContain(secret);
  });
});

describe("TFRobotChatGateway Socket boundary", () => {
  it("does not expose an unavailable SessionProvider credential in Socket errors", async () => {
    const secret = "provider-only-credential";
    const gateway = createTFRobotChatGateway({
      baseUrl: "https://robot.example/",
      messageCreatorProvider,
      sessionProvider: {
        getSession: () => {
          throw new Error(`Provider failed with ${secret}`);
        },
      },
      fetch: vi.fn(),
      socketFactory: createSocketFixture().factory,
    });

    const result = await gateway.subscribe(
      { conversationId: secret, deadlineAt: deadline() },
      { next: () => undefined },
    );

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "authentication",
        message: "Unable to obtain a TFRobot Socket session",
      },
    });
    expect(result.ok ? undefined : result.error.conversationId).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain(secret);
  });

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

  it.each([
    {
      credential: { kind: "bearer" as const, token: "cobalt-dawn-47" },
      label: "Bearer token",
      secret: "cobalt-dawn-47",
    },
    {
      credential: { adminKey: "violet-ridge-84", kind: "admin" as const },
      label: "Admin key",
      secret: "violet-ridge-84",
    },
  ])(
    "redacts an opaque exact $label from realtime Socket diagnostics",
    async ({ credential, secret }) => {
      const socketFixture = createSocketFixture();
      const updates: ChatUpdate[] = [];
      const errors: ChatError[] = [];
      const diagnostics: ChatError[] = [];
      const gateway = createTFRobotChatGateway({
        baseUrl: "https://robot.example/",
        messageCreatorProvider,
        sessionProvider: sessionProvider(credential),
        fetch: vi.fn(),
        socketFactory: socketFixture.factory,
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

      socket.trigger("chat_message", {
        ...messageDto,
        content: `Realtime ${secret}`,
      });
      socket.trigger("chat_event", {
        ...eventDto,
        content: `Event ${secret}`,
      });
      socket.trigger(`future_${secret}`, {
        conversationId: 42,
        summary: `Unknown ${secret}`,
      });
      socket.trigger("chat_error", {
        conversationId: 42,
        error: `Realtime echoed ${secret} without a label`,
        nested: { echoed: secret, embedded: `before-${secret}-after` },
      });
      socket.trigger("error", {
        message: `Protocol echoed ${secret} without a label`,
      });
      socket.trigger("connect_error", {
        code: "network",
        conversationId: secret,
        details: { echoed: secret },
        message: `Injected connect ${secret}`,
        retryable: true,
      } satisfies ChatError);
      socket.trigger("disconnect", {
        code: "network",
        conversationId: secret,
        details: { echoed: secret },
        message: `Injected disconnect ${secret}`,
        retryable: true,
      } satisfies ChatError);

      expect(errors[0]).toMatchObject({
        code: "server",
        details: {
          nested: {
            echoed: "[REDACTED]",
            embedded: "before-[REDACTED]-after",
          },
        },
        message: "Realtime echoed [REDACTED] without a label",
      });
      expect(errors[1]).toMatchObject({
        code: "validation",
        message: "Protocol echoed [REDACTED] without a label",
      });
      expect(errors.slice(2)).toMatchObject([
        {
          conversationId: "[REDACTED]",
          message: "Injected connect [REDACTED]",
        },
        {
          conversationId: "[REDACTED]",
          message: "Injected disconnect [REDACTED]",
        },
      ]);
      expect(updates).toHaveLength(3);
      expect(JSON.stringify(updates)).toContain("[REDACTED]");
      expect(JSON.stringify({ diagnostics, errors, updates })).not.toContain(
        secret,
      );

      await subscribed.value.dispose({ deadlineAt: deadline() });
    },
  );

  it.each([
    {
      credential: { kind: "bearer" as const, token: "cobalt-dawn-47" },
      label: "Bearer token",
      secret: "cobalt-dawn-47",
    },
    {
      credential: { adminKey: "violet-ridge-84", kind: "admin" as const },
      label: "Admin key",
      secret: "violet-ridge-84",
    },
  ])(
    "redacts an opaque exact $label from a generated Socket transport error",
    async ({ credential, secret }) => {
      const gateway = createTFRobotChatGateway({
        baseUrl: "https://robot.example/",
        messageCreatorProvider,
        sessionProvider: sessionProvider(credential),
        fetch: vi.fn(),
        socketFactory: () => {
          throw new Error("Socket factory failed safely");
        },
      });

      const result = await gateway.subscribe(
        { conversationId: secret, deadlineAt: deadline() },
        { next: () => undefined },
      );

      expect(result).toMatchObject({
        ok: false,
        error: {
          code: "network",
          conversationId: "[REDACTED]",
          message: "Socket factory failed safely",
        },
      });
      expect(JSON.stringify(result)).not.toContain(secret);
    },
  );

  it("uses the live credential set when redacting generated errors after Socket auth rotation", async () => {
    const conversationId = "rotated-credential";
    const socketFixture = createSocketFixture();
    const getSession = vi
      .fn()
      .mockReturnValueOnce({
        kind: "bearer" as const,
        token: "initial-credential",
      })
      .mockReturnValueOnce({
        kind: "bearer" as const,
        token: conversationId,
      });
    const errors: ChatError[] = [];
    const gateway = createTFRobotChatGateway({
      baseUrl: "https://robot.example/",
      messageCreatorProvider,
      sessionProvider: { getSession },
      fetch: vi.fn(),
      socketFactory: socketFixture.factory,
    });
    const subscribed = await gateway.subscribe(
      { conversationId, deadlineAt: deadline() },
      {
        next: () => undefined,
        error: (error) => errors.push(error),
      },
    );
    expect(subscribed.ok).toBe(true);
    if (!subscribed.ok) return;

    await expect(socketFixture.inputs[0]!.getAuth()).resolves.toEqual({
      token: "initial-credential",
    });
    await expect(socketFixture.inputs[0]!.getAuth()).resolves.toEqual({
      token: conversationId,
    });
    socketFixture.sockets[0]!.trigger("chat_message", { conversationId });

    expect(errors.at(-1)).toMatchObject({
      code: "validation",
      conversationId: "[REDACTED]",
    });
    expect(JSON.stringify(errors)).not.toContain(conversationId);
    await subscribed.value.dispose({ deadlineAt: deadline() });
  });

  it.each([
    {
      credential: { kind: "bearer" as const, token: "cobalt-dawn-47" },
      label: "Bearer token",
      secret: "cobalt-dawn-47",
    },
    {
      credential: { adminKey: "violet-ridge-84", kind: "admin" as const },
      label: "Admin key",
      secret: "violet-ridge-84",
    },
  ])(
    "redacts an opaque exact $label from an unknown-event fallback conversation",
    async ({ credential, secret }) => {
      const socketFixture = createSocketFixture();
      const updates: ChatUpdate[] = [];
      const gateway = createTFRobotChatGateway({
        baseUrl: "https://robot.example/",
        messageCreatorProvider,
        sessionProvider: sessionProvider(credential),
        fetch: vi.fn(),
        socketFactory: socketFixture.factory,
      });
      const subscribed = await gateway.subscribe(
        { conversationId: secret, deadlineAt: deadline() },
        { next: (update) => updates.push(update) },
      );
      expect(subscribed.ok).toBe(true);
      if (!subscribed.ok) return;

      socketFixture.sockets[0]!.trigger("future_event", { summary: "safe" });

      expect(updates).toHaveLength(1);
      expect(updates[0]).toMatchObject({
        conversationId: "[REDACTED]",
        item: { conversationId: "[REDACTED]" },
        kind: "timeline.upsert",
      });
      expect(JSON.stringify(updates)).not.toContain(secret);
      await subscribed.value.dispose({ deadlineAt: deadline() });
    },
  );

  it("redacts the opaque active credential from a Socket handshake rejection", async () => {
    const secret = "ember-field-29";
    const socket = new FakeSocket();
    socket.connect = () => {
      socket.trigger(
        "connect_error",
        new Error(`Connection rejected by server: ${secret}`),
      );
    };
    const diagnostics: ChatError[] = [];
    const gateway = createTFRobotChatGateway({
      baseUrl: "https://robot.example/",
      messageCreatorProvider,
      sessionProvider: sessionProvider({ kind: "bearer", token: secret }),
      fetch: vi.fn(),
      socketFactory: () => socket,
      onDiagnostic: (error) => {
        diagnostics.push(error);
      },
    });

    const result = await gateway.subscribe(
      { conversationId: "42", deadlineAt: deadline() },
      { next: () => undefined },
    );

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "authentication",
        message: "Connection rejected by server: [REDACTED]",
      },
    });
    expect(JSON.stringify({ diagnostics, result })).not.toContain(secret);
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

  it("redacts a rotated credential from reconnect reconciliation updates", async () => {
    const conversationId = "rotated-credential";
    const socketFixture = createSocketFixture();
    const updates: ChatUpdate[] = [];
    const getSession = vi
      .fn()
      .mockReturnValueOnce({
        kind: "bearer" as const,
        token: "initial-credential",
      })
      .mockReturnValue({
        kind: "bearer" as const,
        token: conversationId,
      });
    const gateway = createTFRobotChatGateway({
      baseUrl: "https://robot.example/",
      messageCreatorProvider,
      sessionProvider: { getSession },
      fetch: vi.fn(async () =>
        envelope({
          working: true,
          taskId: "task-initial-credential",
        }),
      ),
      socketFactory: socketFixture.factory,
    });
    const subscribed = await gateway.subscribe(
      { conversationId, deadlineAt: deadline() },
      { next: (update) => updates.push(update) },
    );
    expect(subscribed.ok).toBe(true);
    if (!subscribed.ok) return;

    await expect(socketFixture.inputs[0]!.getAuth()).resolves.toEqual({
      token: "initial-credential",
    });
    await expect(socketFixture.inputs[0]!.getAuth()).resolves.toEqual({
      token: conversationId,
    });
    const socket = socketFixture.sockets[0]!;
    socket.trigger("conversation_state_changed", {
      conversationId,
      state: "working",
      taskId: "run-before-disconnect",
    });
    updates.length = 0;
    socket.trigger("disconnect", "transport close");
    socket.connect();

    await vi.waitFor(() => {
      expect(updates).toEqual([
        {
          kind: "run.replace",
          conversationId: "[REDACTED]",
          run: {
            id: "task-[REDACTED]",
            conversationId: "[REDACTED]",
            status: "running",
            canInterrupt: true,
          },
        },
      ]);
    });
    expect(JSON.stringify(updates)).not.toContain("initial-credential");
    expect(JSON.stringify(updates)).not.toContain(conversationId);
    await subscribed.value.dispose({ deadlineAt: deadline() });
  });

  it("redacts historical Socket credentials from reconnect REST errors", async () => {
    const previousCredential = "previous-opaque-credential";
    const currentCredential = "current-opaque-credential";
    const socketFixture = createSocketFixture();
    const errors: ChatError[] = [];
    const getSession = vi
      .fn()
      .mockReturnValueOnce({
        kind: "bearer" as const,
        token: previousCredential,
      })
      .mockReturnValue({
        kind: "bearer" as const,
        token: currentCredential,
      });
    const gateway = createTFRobotChatGateway({
      baseUrl: "https://robot.example/",
      messageCreatorProvider,
      sessionProvider: { getSession },
      fetch: vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              detail: previousCredential,
              nested: { current: currentCredential },
            }),
            {
              status: 500,
              headers: { "Content-Type": "application/json" },
            },
          ),
      ),
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
      token: previousCredential,
    });
    await expect(socketFixture.inputs[0]!.getAuth()).resolves.toEqual({
      token: currentCredential,
    });
    const socket = socketFixture.sockets[0]!;
    socket.trigger("disconnect", "transport close");
    socket.connect();

    await vi.waitFor(() => {
      expect(errors.some((error) => error.code === "server")).toBe(true);
    });
    const serverError = errors.find((error) => error.code === "server");
    expect(serverError).toMatchObject({
      message: "[REDACTED]",
      details: {
        payload: {
          detail: "[REDACTED]",
          nested: { current: "[REDACTED]" },
        },
      },
    });
    expect(JSON.stringify(errors)).not.toContain(previousCredential);
    expect(JSON.stringify(errors)).not.toContain(currentCredential);
    await subscribed.value.dispose({ deadlineAt: deadline() });
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
      .mockRejectedValueOnce(new Error("opaque-provider-reason-do-not-expose"));
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
      "opaque-provider-reason-do-not-expose",
    );
    socketFixture.sockets[0]!.trigger(
      "connect_error",
      new Error("transport rejected"),
    );
    await vi.waitFor(() => expect(onSessionInvalid).toHaveBeenCalledOnce());
    expect(errors.at(-1)).toMatchObject({
      code: "authentication",
      message: "Unable to refresh the TFRobot Socket session",
      retryable: true,
    });
    expect(JSON.stringify(errors)).not.toContain(
      "opaque-provider-reason-do-not-expose",
    );
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
