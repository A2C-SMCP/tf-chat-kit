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
  syntheticRunId,
} from "../packages/chat-gateway-tfrobot/src/mapper.js";
import {
  getTransportTaskId,
  interruptDtoSchema,
  sendTextDtoSchema,
  statusDtoSchema,
} from "../packages/chat-gateway-tfrobot/src/dto.js";
import type {
  ChatError,
  ChatUpdate,
  SessionProvider,
} from "../packages/chat-protocol/src/index.js";
import {
  createCurrentServerFixture,
  CURRENT_SERVER_HOLD_ACK,
} from "./support/current-server-fixture.js";

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

  emit(eventName: string, ...arguments_: unknown[]): void {
    this.emitted.push([eventName, arguments_[0]]);
    if (eventName === "join_conversation") {
      const acknowledgement = arguments_[1];
      if (typeof acknowledgement === "function") acknowledgement(true);
    }
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

const HOLD_JOIN_ACK = Symbol("hold-join-ack");

class PlannedAckSocket extends FakeSocket {
  readonly acknowledgements: Array<(value?: unknown) => void> = [];
  readonly plans: Array<unknown | typeof HOLD_JOIN_ACK>;

  constructor(...plans: Array<unknown | typeof HOLD_JOIN_ACK>) {
    super();
    this.plans = plans;
  }

  override emit(eventName: string, ...arguments_: unknown[]): void {
    if (eventName !== "join_conversation") {
      super.emit(eventName, ...arguments_);
      return;
    }
    this.emitted.push([eventName, arguments_[0]]);
    const acknowledgement = arguments_[1];
    if (typeof acknowledgement !== "function") return;
    const plan = this.plans.length === 0 ? HOLD_JOIN_ACK : this.plans.shift()!;
    if (plan === HOLD_JOIN_ACK) {
      this.acknowledgements.push(acknowledgement as (value?: unknown) => void);
      return;
    }
    (acknowledgement as (value?: unknown) => void)(plan);
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
  it.each([
    [{ taskId: "task-camel" }, "task-camel", true],
    [{ task_id: "task-snake" }, "task-snake", true],
    [{ taskId: "task-both", task_id: "task-both" }, "task-both", true],
    [{ taskId: "task-a", task_id: "task-b" }, undefined, false],
    [{}, undefined, true],
  ] as const)(
    "validates reusable task ID aliases %#",
    (fields, expected, valid) => {
      for (const schema of [sendTextDtoSchema, statusDtoSchema]) {
        const input =
          schema === statusDtoSchema ? { working: true, ...fields } : fields;
        const parsed = schema.safeParse(input);
        expect(parsed.success).toBe(valid);
        if (!parsed.success) continue;
        expect(getTransportTaskId(parsed.data)).toBe(expected);
        expect(schema.safeParse(parsed.data).success).toBe(true);
      }
      expect(interruptDtoSchema.safeParse(fields).success).toBe(
        valid && expected !== undefined,
      );
    },
  );

  it("renames and deletes a conversation through validated management endpoints", async () => {
    const requests: Request[] = [];
    const fetch = vi.fn(
      async (
        input: Parameters<typeof globalThis.fetch>[0],
        init?: Parameters<typeof globalThis.fetch>[1],
      ) => {
        const request = new Request(input, init);
        requests.push(request);
        if (request.method === "GET") {
          return envelope({ conversations: [conversationDto], cursor: null });
        }
        if (request.method === "PATCH") {
          return envelope({ ...conversationDto, title: "Renamed remotely" });
        }
        if (request.method === "DELETE") {
          return envelope({ conversationId: 42, message: "deleted" });
        }
        throw new Error(`Unexpected request: ${request.method}`);
      },
    );
    const gateway = createTFRobotChatGateway({
      baseUrl: "https://robot.example/api/",
      messageCreatorProvider,
      sessionProvider: sessionProvider(),
      fetch,
      socketFactory: createSocketFixture().factory,
    });
    await gateway.listConversations({ deadlineAt: deadline() });

    await expect(
      gateway.renameConversation!({
        conversationId: "42",
        deadlineAt: deadline(),
        title: "Renamed remotely",
      }),
    ).resolves.toMatchObject({
      ok: true,
      value: { id: "42", title: "Renamed remotely" },
    });
    await expect(
      gateway.deleteConversation!({
        conversationId: "42",
        deadlineAt: deadline(),
      }),
    ).resolves.toEqual({
      ok: true,
      value: { deletedConversationId: "42" },
    });

    const renameRequest = requests[1]!;
    expect(renameRequest.method).toBe("PATCH");
    expect(new URL(renameRequest.url).pathname).toBe(
      "/api/v1/chat/conversations/42",
    );
    expect(new URL(renameRequest.url).searchParams.get("title")).toBe(
      "Renamed remotely",
    );
    await expect(renameRequest.clone().json()).resolves.toEqual({
      title: "Renamed remotely",
    });
    expect(requests[2]?.method).toBe("DELETE");
    expect(new URL(requests[2]!.url).pathname).toBe(
      "/api/v1/chat/conversations/42",
    );
  });

  it("rebases a stale conversation list onto a completed rename before caching it", async () => {
    const staleListStarted = deferred<void>();
    const staleListResponse = deferred<Response>();
    const fetch = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        const path = new URL(request.url).pathname;
        if (request.method === "GET" && path.endsWith("/conversations")) {
          staleListStarted.resolve(undefined);
          return staleListResponse.promise;
        }
        if (request.method === "PATCH") {
          return envelope({ ...conversationDto, title: "Fresh title" });
        }
        if (path.endsWith("/messages")) {
          return envelope({ cursor: null, events: [], messages: [] });
        }
        if (path.endsWith("/status")) {
          return envelope({ taskId: null, working: false });
        }
        throw new Error(`Unexpected request: ${request.method} ${path}`);
      },
    );
    const gateway = createTFRobotChatGateway({
      baseUrl: "https://robot.example/api/",
      messageCreatorProvider,
      sessionProvider: sessionProvider(),
      fetch,
      socketFactory: createSocketFixture().factory,
    });
    const listing = gateway.listConversations({ deadlineAt: deadline() });
    await staleListStarted.promise;

    await expect(
      gateway.renameConversation!({
        conversationId: "42",
        deadlineAt: deadline(),
        title: "Fresh title",
      }),
    ).resolves.toMatchObject({
      ok: true,
      value: { id: "42", title: "Fresh title" },
    });
    staleListResponse.resolve(
      envelope({ conversations: [conversationDto], cursor: null }),
    );

    await expect(listing).resolves.toMatchObject({
      ok: true,
      value: { conversations: [{ id: "42", title: "Fresh title" }] },
    });
    await expect(
      gateway.loadConversation({
        conversationId: "42",
        deadlineAt: deadline(),
      }),
    ).resolves.toMatchObject({
      ok: true,
      value: { conversation: { id: "42", title: "Fresh title" } },
    });
    await gateway.dispose({ deadlineAt: deadline() });
  });

  it("filters a deleted conversation from a stale in-flight list response", async () => {
    const staleListStarted = deferred<void>();
    const staleListResponse = deferred<Response>();
    const gateway = createTFRobotChatGateway({
      baseUrl: "https://robot.example/api/",
      messageCreatorProvider,
      sessionProvider: sessionProvider(),
      fetch: vi.fn(async (input, init) => {
        const request = new Request(input, init);
        if (request.method === "DELETE") {
          return envelope({ conversationId: 42, message: "deleted" });
        }
        staleListStarted.resolve(undefined);
        return staleListResponse.promise;
      }),
      socketFactory: createSocketFixture().factory,
    });
    const listing = gateway.listConversations({ deadlineAt: deadline() });
    await staleListStarted.promise;

    await expect(
      gateway.deleteConversation!({
        conversationId: "42",
        deadlineAt: deadline(),
      }),
    ).resolves.toMatchObject({ ok: true });
    staleListResponse.resolve(
      envelope({ conversations: [conversationDto], cursor: null }),
    );

    await expect(listing).resolves.toMatchObject({
      ok: true,
      value: { conversations: [] },
    });
    await gateway.dispose({ deadlineAt: deadline() });
  });

  it("rejects a snapshot response that arrives after its conversation was deleted", async () => {
    const historyStarted = deferred<void>();
    const statusStarted = deferred<void>();
    const historyResponse = deferred<Response>();
    const statusResponse = deferred<Response>();
    const fetch = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        const path = new URL(request.url).pathname;
        if (request.method === "DELETE") {
          return envelope({ conversationId: 42, message: "deleted" });
        }
        if (request.method === "GET" && path.endsWith("/conversations")) {
          return envelope({ conversations: [conversationDto], cursor: null });
        }
        if (path.endsWith("/messages")) {
          historyStarted.resolve(undefined);
          return historyResponse.promise;
        }
        if (path.endsWith("/status")) {
          statusStarted.resolve(undefined);
          return statusResponse.promise;
        }
        throw new Error(`Unexpected request: ${request.method} ${path}`);
      },
    );
    const gateway = createTFRobotChatGateway({
      baseUrl: "https://robot.example/api/",
      messageCreatorProvider,
      sessionProvider: sessionProvider(),
      fetch,
      socketFactory: createSocketFixture().factory,
    });
    await gateway.listConversations({ deadlineAt: deadline() });
    const loading = gateway.loadConversation({
      conversationId: "42",
      deadlineAt: deadline(),
    });
    await Promise.all([historyStarted.promise, statusStarted.promise]);

    await expect(
      gateway.deleteConversation!({
        conversationId: "42",
        deadlineAt: deadline(),
      }),
    ).resolves.toMatchObject({ ok: true });
    historyResponse.resolve(
      envelope({ cursor: null, events: [], messages: [] }),
    );
    statusResponse.resolve(envelope({ taskId: null, working: false }));

    await expect(loading).resolves.toMatchObject({
      ok: false,
      error: { code: "conflict", conversationId: "42" },
    });
    await gateway.dispose({ deadlineAt: deadline() });
  });

  it("cancels a deleted conversation while Socket authentication is pending", async () => {
    const connectSessionStarted = deferred<void>();
    const connectSession = deferred<TFRobotSession>();
    const sockets = createSocketFixture();
    const gateway = createTFRobotChatGateway({
      baseUrl: "https://robot.example/api/",
      messageCreatorProvider,
      sessionProvider: {
        getSession(request) {
          if (request.purpose === "connect") {
            connectSessionStarted.resolve(undefined);
            return connectSession.promise;
          }
          return { kind: "bearer", token: "request-token" };
        },
      },
      fetch: vi.fn(async () =>
        envelope({ conversationId: 42, message: "deleted" }),
      ),
      socketFactory: sockets.factory,
    });
    const subscribing = gateway.subscribe(
      { conversationId: "42", deadlineAt: deadline() },
      { next: () => undefined },
    );
    await connectSessionStarted.promise;

    await expect(
      gateway.deleteConversation!({
        conversationId: "42",
        deadlineAt: deadline(),
      }),
    ).resolves.toEqual({
      ok: true,
      value: { deletedConversationId: "42" },
    });
    connectSession.resolve({ kind: "bearer", token: "late-token" });

    await expect(subscribing).resolves.toMatchObject({
      ok: false,
      error: { code: "conflict" },
    });
    expect(sockets.inputs).toHaveLength(0);
    await gateway.dispose({ deadlineAt: deadline() });
  });

  it("cancels a deleted conversation while current-server preflight is pending", async () => {
    const preflightStarted = deferred<void>();
    const preflightResponse = deferred<Response>();
    const sockets = createSocketFixture();
    const gateway = createTFRobotChatGateway({
      baseUrl: "https://robot.example/api/",
      messageCreatorProvider,
      serverProfile: { kind: "current-server" },
      sessionProvider: sessionProvider(),
      fetch: vi.fn(async (input, init) => {
        const request = new Request(input, init);
        if (request.method === "DELETE") {
          return envelope({ conversationId: 42, message: "deleted" });
        }
        if (new URL(request.url).pathname.endsWith("/status")) {
          preflightStarted.resolve(undefined);
          return preflightResponse.promise;
        }
        return envelope({ cursor: null, events: [], messages: [] });
      }),
      socketFactory: sockets.factory,
    });
    const subscribing = gateway.subscribe(
      { conversationId: "42", deadlineAt: deadline() },
      { next: () => undefined },
    );
    await preflightStarted.promise;

    await expect(
      gateway.deleteConversation!({
        conversationId: "42",
        deadlineAt: deadline(),
      }),
    ).resolves.toEqual({
      ok: true,
      value: { deletedConversationId: "42" },
    });
    preflightResponse.resolve(envelope({ taskId: null, working: false }));

    await expect(subscribing).resolves.toMatchObject({
      ok: false,
      error: { code: "conflict" },
    });
    expect(sockets.inputs).toHaveLength(0);
    await gateway.dispose({ deadlineAt: deadline() });
  });

  it.each([
    ["rename", "PATCH", { ...conversationDto, conversationId: 43 }],
    ["delete", "DELETE", { conversationId: 43, message: "deleted" }],
  ] as const)(
    "fails closed when a %s response identifies another conversation",
    async (operation, method, response) => {
      const gateway = createTFRobotChatGateway({
        baseUrl: "https://robot.example/api/",
        messageCreatorProvider,
        sessionProvider: sessionProvider(),
        fetch: vi.fn(async (_input, init) => {
          expect(init?.method).toBe(method);
          return envelope(response);
        }),
        socketFactory: createSocketFixture().factory,
      });
      const result =
        operation === "rename"
          ? await gateway.renameConversation!({
              conversationId: "42",
              deadlineAt: deadline(),
              title: "Wrong target",
            })
          : await gateway.deleteConversation!({
              conversationId: "42",
              deadlineAt: deadline(),
            });
      expect(result).toMatchObject({
        ok: false,
        error: { code: "validation" },
      });
    },
  );

  it("uses legacy snake task IDs for load, send and run-pinned interrupt", async () => {
    const requestBodies: unknown[] = [];
    const fetch = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        const path = new URL(request.url).pathname;
        if (path.endsWith("/conversations")) {
          return envelope({ conversations: [conversationDto], cursor: null });
        }
        if (request.method === "GET" && path.endsWith("/messages")) {
          return envelope({ messages: [], events: [], cursor: null });
        }
        if (path.endsWith("/status")) {
          return envelope({ working: true, task_id: "legacy-status-run" });
        }
        if (request.method === "POST" && path.endsWith("/messages")) {
          return envelope({ task_id: "legacy-send-run" });
        }
        requestBodies.push(await request.json());
        return envelope({ task_id: "legacy-cancellation" });
      },
    );
    const gateway = createTFRobotChatGateway({
      baseUrl: "https://robot.example/",
      messageCreatorProvider,
      sessionProvider: sessionProvider(),
      fetch,
      socketFactory: createSocketFixture().factory,
    });

    await expect(
      gateway.loadConversation({
        conversationId: "42",
        deadlineAt: deadline(),
      }),
    ).resolves.toMatchObject({
      ok: true,
      value: { run: { id: "legacy-status-run", canInterrupt: true } },
    });
    await expect(
      gateway.sendText({
        conversationId: "42",
        text: "legacy response",
        deadlineAt: deadline(),
      }),
    ).resolves.toEqual({ ok: true, value: { runId: "legacy-send-run" } });
    await expect(
      gateway.interrupt({
        conversationId: "42",
        runId: "legacy-send-run",
        deadlineAt: deadline(),
      }),
    ).resolves.toEqual({
      ok: true,
      value: {
        cancellationId: "legacy-cancellation",
        interruptedRunId: "legacy-send-run",
      },
    });
    expect(requestBodies).toEqual([{ taskId: "legacy-send-run" }]);
    await gateway.dispose({ deadlineAt: deadline() });
  });

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

describe("TFRobotChatGateway current-server profile", () => {
  const currentServerProfile = {
    kind: "current-server" as const,
    rebase: { deadlineMs: 1_000, maxItems: 10, maxPages: 2, pageSize: 5 },
  };

  it("preflights with the Socket session and treats an empty ACK as degraded", async () => {
    const fixture = createCurrentServerFixture();
    const updates: ChatUpdate[] = [];
    const gateway = createTFRobotChatGateway({
      baseUrl: "https://robot.example/",
      messageCreatorProvider,
      serverProfile: currentServerProfile,
      sessionProvider: fixture.sessionProvider,
      fetch: fixture.fetch,
      socketFactory: fixture.socketFactory,
    });

    await expect(
      gateway.subscribe(
        { conversationId: "42", deadlineAt: deadline() },
        { next: (update) => updates.push(update) },
      ),
    ).resolves.toMatchObject({ ok: true });

    expect(fixture.sessionRequests).toHaveLength(1);
    expect(fixture.requests).toHaveLength(2);
    expect(
      fixture.requests.every(
        (request) => request.authorization === "Bearer fixture-session-token",
      ),
    ).toBe(true);
    expect(fixture.socket.authentications).toEqual([
      { token: "fixture-session-token" },
    ]);
    expect(
      updates.filter((update) => update.kind === "lifecycle.changed").at(-1),
    ).toMatchObject({
      lifecycle: {
        status: "degraded",
        recovery: {
          assurance: "best-effort",
          complete: false,
          reason: "initial-rest-preflight",
          source: "rest-rebase",
        },
      },
    });
    expect(
      updates.some(
        (update) =>
          update.kind === "lifecycle.changed" &&
          update.lifecycle.status === "active",
      ),
    ).toBe(false);
    gateway.dispose({ deadlineAt: deadline() });
  });

  it.each([
    [401, "authentication"],
    [403, "authorization"],
    [404, "not-found"],
  ] as const)(
    "fails preflight closed for HTTP %i",
    async (status, expectedCode) => {
      const fixture = createCurrentServerFixture({
        status: [new Response("failure", { status })],
      });
      const gateway = createTFRobotChatGateway({
        baseUrl: "https://robot.example/",
        messageCreatorProvider,
        serverProfile: currentServerProfile,
        sessionProvider: fixture.sessionProvider,
        fetch: fixture.fetch,
        socketFactory: fixture.socketFactory,
      });

      await expect(
        gateway.subscribe(
          { conversationId: "42", deadlineAt: deadline() },
          { next: () => undefined },
        ),
      ).resolves.toMatchObject({
        ok: false,
        error: { code: expectedCode },
      });
      expect(() => fixture.socket).toThrow("Socket was not created");
      gateway.dispose({ deadlineAt: deadline() });
    },
  );

  it("fails preflight closed when REST history belongs to another conversation", async () => {
    const fixture = createCurrentServerFixture({
      history: [
        {
          messages: [{ ...messageDto, conversationId: 43 }],
          events: [],
          cursor: null,
        },
      ],
    });
    const gateway = createTFRobotChatGateway({
      baseUrl: "https://robot.example/",
      messageCreatorProvider,
      serverProfile: currentServerProfile,
      sessionProvider: fixture.sessionProvider,
      fetch: fixture.fetch,
      socketFactory: fixture.socketFactory,
    });

    await expect(
      gateway.subscribe(
        { conversationId: "42", deadlineAt: deadline() },
        { next: () => undefined },
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "validation" },
    });
    expect(() => fixture.socket).toThrow("Socket was not created");
    gateway.dispose({ deadlineAt: deadline() });
  });

  it("still fails closed for an explicit join rejection", async () => {
    const fixture = createCurrentServerFixture({
      acknowledgements: [{ statusCode: 403 }],
    });
    const gateway = createTFRobotChatGateway({
      baseUrl: "https://robot.example/",
      messageCreatorProvider,
      serverProfile: currentServerProfile,
      sessionProvider: fixture.sessionProvider,
      fetch: fixture.fetch,
      socketFactory: fixture.socketFactory,
    });

    await expect(
      gateway.subscribe(
        { conversationId: "42", deadlineAt: deadline() },
        { next: () => undefined },
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "authorization" },
    });
    expect(fixture.socket.connected).toBe(false);
    expect(fixture.invalidations).toHaveLength(1);
    gateway.dispose({ deadlineAt: deadline() });
  });

  it("rebases persisted offline items to a checkpoint without duplicates", async () => {
    const offlineMessage = {
      ...messageDto,
      msgId: "message-offline",
      content: "Persisted while offline",
      createTimestamp: 1_773_705_600_300,
      role: "assistant",
    };
    const fixture = createCurrentServerFixture({
      acknowledgements: [undefined, undefined],
      history: [
        { messages: [], events: [], cursor: null },
        {
          messages: [offlineMessage],
          events: [eventDto],
          cursor: "older-page",
        },
        { messages: [messageDto], events: [], cursor: null },
      ],
    });
    const updates: ChatUpdate[] = [];
    const gateway = createTFRobotChatGateway({
      baseUrl: "https://robot.example/",
      messageCreatorProvider,
      serverProfile: currentServerProfile,
      sessionProvider: fixture.sessionProvider,
      fetch: fixture.fetch,
      socketFactory: fixture.socketFactory,
    });
    const subscribed = await gateway.subscribe(
      { conversationId: "42", deadlineAt: deadline() },
      { next: (update) => updates.push(update) },
    );
    expect(subscribed.ok).toBe(true);
    fixture.socket.trigger("chat_message", messageDto);
    updates.length = 0;

    fixture.socket.forceDisconnect();
    fixture.socket.connect();

    await vi.waitFor(() =>
      expect(
        updates.filter((update) => update.kind === "lifecycle.changed").at(-1),
      ).toMatchObject({
        lifecycle: {
          status: "degraded",
          recovery: {
            assurance: "best-effort",
            complete: false,
            reason: "rest-rebase-reached-checkpoint",
            source: "rest-rebase",
          },
        },
      }),
    );
    expect(
      updates.filter(
        (update) =>
          update.kind === "timeline.upsert" &&
          update.item.kind === "message" &&
          update.item.id === "message-1",
      ),
    ).toHaveLength(0);
    expect(
      updates.filter(
        (update) =>
          update.kind === "timeline.upsert" &&
          update.item.kind === "message" &&
          update.item.id === "message-offline",
      ),
    ).toHaveLength(1);
    expect(
      updates.filter((update) => update.kind === "event.transition.upsert"),
    ).toHaveLength(1);
    expect(fixture.sessionRequests).toHaveLength(2);
    expect(fixture.requests).toHaveLength(5);
    expect(new URL(fixture.requests[4]!.url).searchParams.get("cursor")).toBe(
      "older-page",
    );
    gateway.dispose({ deadlineAt: deadline() });
  });

  it("does not let an older REST item overwrite a newer realtime revision", async () => {
    const historyResponse = deferred<Response>();
    let rebaseHistoryStarted = false;
    const oldMessage = {
      ...messageDto,
      content: "Older REST content",
      createTimestamp: 1_773_705_600_200,
    };
    const realtimeMessage = {
      ...messageDto,
      content: "Newer realtime content",
      createTimestamp: 1_773_705_600_400,
    };
    const fixture = createCurrentServerFixture({
      acknowledgements: [undefined, undefined],
      history: [
        { messages: [], events: [], cursor: null },
        () => {
          rebaseHistoryStarted = true;
          return historyResponse.promise;
        },
      ],
    });
    const updates: ChatUpdate[] = [];
    const gateway = createTFRobotChatGateway({
      baseUrl: "https://robot.example/",
      messageCreatorProvider,
      serverProfile: currentServerProfile,
      sessionProvider: fixture.sessionProvider,
      fetch: fixture.fetch,
      socketFactory: fixture.socketFactory,
    });
    await gateway.subscribe(
      { conversationId: "42", deadlineAt: deadline() },
      { next: (update) => updates.push(update) },
    );
    updates.length = 0;
    fixture.socket.forceDisconnect();
    fixture.socket.connect();
    await vi.waitFor(() => expect(rebaseHistoryStarted).toBe(true));
    fixture.socket.trigger("chat_message", realtimeMessage);
    historyResponse.resolve(
      envelope({ messages: [oldMessage], events: [], cursor: null }),
    );

    await vi.waitFor(() =>
      expect(
        updates.filter((update) => update.kind === "lifecycle.changed").at(-1),
      ).toMatchObject({ lifecycle: { status: "degraded" } }),
    );
    const messageUpdates = updates.filter(
      (update) =>
        update.kind === "timeline.upsert" &&
        update.item.kind === "message" &&
        update.item.id === "message-1",
    );
    expect(messageUpdates).toHaveLength(1);
    expect(messageUpdates[0]).toMatchObject({
      item: { content: { kind: "text", text: "Newer realtime content" } },
    });
    gateway.dispose({ deadlineAt: deadline() });
  });

  it("does not turn ACK-buffered realtime into a rebase stop checkpoint", async () => {
    const bufferedMessage = {
      ...messageDto,
      msgId: "message-buffered-after-reconnect",
      content: "Realtime after reconnect",
      createTimestamp: 1_773_705_600_500,
      role: "assistant",
    };
    const offlineMessage = {
      ...messageDto,
      msgId: "message-older-offline",
      content: "Older persisted offline message",
      createTimestamp: 1_773_705_600_300,
      role: "assistant",
    };
    const fixture = createCurrentServerFixture({
      acknowledgements: [undefined, CURRENT_SERVER_HOLD_ACK],
      history: [
        { messages: [], events: [], cursor: null },
        {
          messages: [bufferedMessage, offlineMessage],
          events: [],
          cursor: null,
        },
      ],
    });
    const updates: ChatUpdate[] = [];
    const gateway = createTFRobotChatGateway({
      baseUrl: "https://robot.example/",
      messageCreatorProvider,
      serverProfile: currentServerProfile,
      sessionProvider: fixture.sessionProvider,
      fetch: fixture.fetch,
      socketFactory: fixture.socketFactory,
    });
    await gateway.subscribe(
      { conversationId: "42", deadlineAt: deadline() },
      { next: (update) => updates.push(update) },
    );
    updates.length = 0;

    fixture.socket.forceDisconnect();
    fixture.socket.connect();
    await vi.waitFor(() =>
      expect(fixture.socket.pendingAcknowledgements).toHaveLength(1),
    );
    fixture.socket.trigger("chat_message", bufferedMessage);
    fixture.socket.acknowledgeNext();

    await vi.waitFor(() =>
      expect(
        updates.filter((update) => update.kind === "lifecycle.changed").at(-1),
      ).toMatchObject({ lifecycle: { status: "degraded" } }),
    );
    expect(
      updates.filter(
        (update) =>
          update.kind === "timeline.upsert" &&
          update.item.id === "message-buffered-after-reconnect",
      ),
    ).toHaveLength(1);
    expect(
      updates.filter(
        (update) =>
          update.kind === "timeline.upsert" &&
          update.item.id === "message-older-offline",
      ),
    ).toHaveLength(1);
    gateway.dispose({ deadlineAt: deadline() });
  });

  it("rejects foreign rebase data before checkpoint and identity bookkeeping", async () => {
    const foreignTransition = {
      ...eventDto,
      conversationId: 43,
      eventId: "shared-event",
      transitionId: "shared-transition",
      createTimestamp: 1_773_705_600_600,
    };
    const targetTransition = {
      ...foreignTransition,
      conversationId: 42,
      createTimestamp: 1_773_705_600_400,
    };
    const offlineMessage = {
      ...messageDto,
      msgId: "message-after-foreign-page",
      content: "Target history remains recoverable",
      createTimestamp: 1_773_705_600_300,
      role: "assistant",
    };
    const fixture = createCurrentServerFixture({
      acknowledgements: [undefined, undefined, undefined],
      history: [
        { messages: [], events: [], cursor: null },
        {
          messages: [
            {
              ...messageDto,
              conversationId: 43,
              createTimestamp: 1_773_705_600_500,
            },
          ],
          events: [foreignTransition],
          cursor: null,
        },
        {
          messages: [offlineMessage, messageDto],
          events: [targetTransition],
          cursor: null,
        },
      ],
    });
    const updates: ChatUpdate[] = [];
    const gateway = createTFRobotChatGateway({
      baseUrl: "https://robot.example/",
      messageCreatorProvider,
      serverProfile: currentServerProfile,
      sessionProvider: fixture.sessionProvider,
      fetch: fixture.fetch,
      socketFactory: fixture.socketFactory,
    });
    await gateway.subscribe(
      { conversationId: "42", deadlineAt: deadline() },
      { next: (update) => updates.push(update) },
    );
    fixture.socket.trigger("chat_message", messageDto);
    updates.length = 0;

    fixture.socket.forceDisconnect();
    fixture.socket.connect();
    await vi.waitFor(() =>
      expect(
        updates.some(
          (update) =>
            update.kind === "error.reported" && update.source === "recovery",
        ),
      ).toBe(true),
    );
    expect(
      updates.filter((update) => update.kind === "lifecycle.changed").at(-1),
    ).toMatchObject({ lifecycle: { status: "recovering" } });
    expect(
      updates.some(
        (update) =>
          update.kind === "event.transition.upsert" &&
          update.event.id === "shared-event",
      ),
    ).toBe(false);

    updates.length = 0;
    fixture.socket.forceDisconnect();
    fixture.socket.connect();
    await vi.waitFor(() =>
      expect(
        updates.filter((update) => update.kind === "lifecycle.changed").at(-1),
      ).toMatchObject({
        lifecycle: {
          status: "degraded",
          recovery: { reason: "rest-rebase-reached-checkpoint" },
        },
      }),
    );
    expect(
      updates.filter(
        (update) =>
          update.kind === "event.transition.upsert" &&
          update.event.id === "shared-event",
      ),
    ).toHaveLength(1);
    expect(
      updates.filter(
        (update) =>
          update.kind === "timeline.upsert" &&
          update.item.id === "message-after-foreign-page",
      ),
    ).toHaveLength(1);
    gateway.dispose({ deadlineAt: deadline() });
  });

  it.each([
    [
      { maxItems: 1, maxPages: 2, pageSize: 2 },
      {
        messages: [{ ...messageDto, msgId: "bounded-newest" }],
        events: [],
        cursor: "more-items",
      },
      "rest-rebase-max-items",
    ],
    [
      { maxItems: 10, maxPages: 1, pageSize: 2 },
      {
        messages: [{ ...messageDto, msgId: "page-one-message" }],
        events: [],
        cursor: "page-two",
      },
      "rest-rebase-max-pages",
    ],
  ] as const)(
    "reports a best-effort boundary when checkpoint search is bounded %#",
    async (rebase, history, reason) => {
      const fixture = createCurrentServerFixture({
        acknowledgements: [undefined, undefined],
        history: [{ messages: [], events: [], cursor: null }, history],
      });
      const updates: ChatUpdate[] = [];
      const gateway = createTFRobotChatGateway({
        baseUrl: "https://robot.example/",
        messageCreatorProvider,
        serverProfile: {
          kind: "current-server",
          rebase: { deadlineMs: 1_000, ...rebase },
        },
        sessionProvider: fixture.sessionProvider,
        fetch: fixture.fetch,
        socketFactory: fixture.socketFactory,
      });
      await gateway.subscribe(
        { conversationId: "42", deadlineAt: deadline() },
        { next: (update) => updates.push(update) },
      );
      updates.length = 0;
      fixture.socket.forceDisconnect();
      fixture.socket.connect();

      await vi.waitFor(() =>
        expect(
          updates
            .filter((update) => update.kind === "lifecycle.changed")
            .at(-1),
        ).toMatchObject({
          lifecycle: {
            status: "degraded",
            recovery: { complete: false, reason },
          },
        }),
      );
      if (reason === "rest-rebase-max-items") {
        expect(
          updates.filter((update) => update.kind === "timeline.upsert"),
        ).toHaveLength(1);
      }
      gateway.dispose({ deadlineAt: deadline() });
    },
  );

  it("bounds recovery when a history cursor repeats", async () => {
    const fixture = createCurrentServerFixture({
      acknowledgements: [undefined, undefined],
      history: [
        { messages: [], events: [], cursor: null },
        {
          messages: [
            {
              ...messageDto,
              msgId: "cursor-cycle-newer",
              createTimestamp: 1_773_705_600_300,
            },
          ],
          events: [],
          cursor: "repeated-cursor",
        },
        {
          messages: [
            {
              ...messageDto,
              msgId: "cursor-cycle-older",
              createTimestamp: 1_773_705_600_200,
            },
          ],
          events: [],
          cursor: "repeated-cursor",
        },
      ],
    });
    const updates: ChatUpdate[] = [];
    const gateway = createTFRobotChatGateway({
      baseUrl: "https://robot.example/",
      messageCreatorProvider,
      serverProfile: {
        kind: "current-server",
        rebase: { deadlineMs: 1_000, maxItems: 10, maxPages: 3, pageSize: 5 },
      },
      sessionProvider: fixture.sessionProvider,
      fetch: fixture.fetch,
      socketFactory: fixture.socketFactory,
    });
    await gateway.subscribe(
      { conversationId: "42", deadlineAt: deadline() },
      { next: (update) => updates.push(update) },
    );
    updates.length = 0;
    fixture.socket.forceDisconnect();
    fixture.socket.connect();

    await vi.waitFor(() =>
      expect(
        updates.filter((update) => update.kind === "lifecycle.changed").at(-1),
      ).toMatchObject({
        lifecycle: {
          status: "degraded",
          recovery: { reason: "rest-rebase-cursor-cycle" },
        },
      }),
    );
    expect(
      updates.filter((update) => update.kind === "timeline.upsert"),
    ).toHaveLength(2);
    expect(new URL(fixture.requests[4]!.url).searchParams.get("cursor")).toBe(
      "repeated-cursor",
    );
    gateway.dispose({ deadlineAt: deadline() });
  });

  it("keeps recovery non-operable when the REST rebase deadline expires", async () => {
    const fixture = createCurrentServerFixture({
      acknowledgements: [undefined, undefined],
      history: [
        { messages: [], events: [], cursor: null },
        () => new Promise<Response>(() => undefined),
      ],
    });
    const updates: ChatUpdate[] = [];
    const gateway = createTFRobotChatGateway({
      baseUrl: "https://robot.example/",
      messageCreatorProvider,
      serverProfile: {
        kind: "current-server",
        rebase: { deadlineMs: 10, maxItems: 10, maxPages: 2, pageSize: 5 },
      },
      sessionProvider: fixture.sessionProvider,
      fetch: fixture.fetch,
      socketFactory: fixture.socketFactory,
    });
    await gateway.subscribe(
      { conversationId: "42", deadlineAt: deadline() },
      { next: (update) => updates.push(update) },
    );
    updates.length = 0;
    fixture.socket.forceDisconnect();
    fixture.socket.connect();

    await vi.waitFor(() =>
      expect(
        updates.some(
          (update) =>
            update.kind === "error.reported" && update.source === "recovery",
        ),
      ).toBe(true),
    );
    expect(
      updates.filter((update) => update.kind === "lifecycle.changed").at(-1),
    ).toMatchObject({ lifecycle: { status: "recovering" } });
    gateway.dispose({ deadlineAt: deadline() });
  });

  it("ignores a late rebase after a conversation switch", async () => {
    const historyResponse = deferred<Response>();
    let rebaseHistoryStarted = false;
    const fixture = createCurrentServerFixture({
      acknowledgements: [undefined, undefined],
      history: [
        { messages: [], events: [], cursor: null },
        () => {
          rebaseHistoryStarted = true;
          return historyResponse.promise;
        },
        { messages: [], events: [], cursor: null },
      ],
    });
    const updates: ChatUpdate[] = [];
    const gateway = createTFRobotChatGateway({
      baseUrl: "https://robot.example/",
      messageCreatorProvider,
      serverProfile: {
        kind: "current-server",
        rebase: { deadlineMs: 1_000, maxItems: 1, maxPages: 1, pageSize: 1 },
      },
      sessionProvider: fixture.sessionProvider,
      fetch: fixture.fetch,
      socketFactory: fixture.socketFactory,
    });
    const subscribed = await gateway.subscribe(
      { conversationId: "42", deadlineAt: deadline() },
      { next: (update) => updates.push(update) },
    );
    if (!subscribed.ok) throw new Error("Expected subscription to succeed");
    updates.length = 0;
    fixture.socket.forceDisconnect();
    fixture.socket.connect();
    await vi.waitFor(() => expect(rebaseHistoryStarted).toBe(true));
    await subscribed.value.dispose({ deadlineAt: deadline() });
    const switchedUpdates: ChatUpdate[] = [];
    await expect(
      gateway.subscribe(
        { conversationId: "43", deadlineAt: deadline() },
        { next: (update) => switchedUpdates.push(update) },
      ),
    ).resolves.toMatchObject({ ok: true });
    historyResponse.resolve(
      envelope({
        messages: [{ ...messageDto, msgId: "late-message", role: "assistant" }],
        events: [],
        cursor: "bounded-cursor",
      }),
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(
      updates.some(
        (update) =>
          update.kind === "timeline.upsert" &&
          update.item.id === "late-message",
      ),
    ).toBe(false);
    expect(
      switchedUpdates
        .filter((update) => update.kind === "lifecycle.changed")
        .at(-1),
    ).toMatchObject({ lifecycle: { status: "degraded" } });
    expect(
      updates.some(
        (update) =>
          update.kind === "lifecycle.changed" &&
          update.lifecycle.status === "degraded",
      ),
    ).toBe(false);
    gateway.dispose({ deadlineAt: deadline() });
  });

  it("validates bounded rebase configuration", () => {
    expect(() =>
      createTFRobotChatGateway({
        baseUrl: "https://robot.example/",
        messageCreatorProvider,
        serverProfile: {
          kind: "current-server",
          rebase: { maxPages: 0 },
        },
        sessionProvider: sessionProvider(),
      }),
    ).toThrow("maxPages must be a positive integer");
    for (const serverProfile of [{}, { kind: "verfied" }]) {
      expect(() =>
        createTFRobotChatGateway({
          baseUrl: "https://robot.example/",
          messageCreatorProvider,
          serverProfile: serverProfile as never,
          sessionProvider: sessionProvider(),
        }),
      ).toThrow('serverProfile.kind must be "verified" or "current-server"');
    }
  });
});

describe("TFRobotChatGateway Socket boundary", () => {
  const cyclicJoinAcknowledgement: Record<string, unknown> = {};
  cyclicJoinAcknowledgement["self"] = cyclicJoinAcknowledgement;

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

  it("waits for join acknowledgement before publishing an active lifecycle", async () => {
    class DeferredJoinSocket extends FakeSocket {
      acknowledgement: ((value?: unknown) => void) | undefined;

      override emit(eventName: string, ...arguments_: unknown[]): void {
        if (eventName !== "join_conversation") {
          super.emit(eventName, ...arguments_);
          return;
        }
        this.emitted.push([eventName, arguments_[0]]);
        const acknowledgement = arguments_[1];
        if (typeof acknowledgement === "function") {
          this.acknowledgement = acknowledgement as (value?: unknown) => void;
        }
      }
    }

    const socket = new DeferredJoinSocket();
    const updates: ChatUpdate[] = [];
    const gateway = createTFRobotChatGateway({
      baseUrl: "https://robot.example/",
      messageCreatorProvider,
      sessionProvider: sessionProvider(),
      fetch: vi.fn(),
      socketFactory: () => socket,
    });
    let settled = false;
    const subscribing = Promise.resolve(
      gateway.subscribe(
        { conversationId: "42", deadlineAt: deadline() },
        { next: (update) => updates.push(update) },
      ),
    ).then((result) => {
      settled = true;
      return result;
    });

    await vi.waitFor(() =>
      expect(socket.acknowledgement).toBeTypeOf("function"),
    );
    expect(settled).toBe(false);
    expect(
      updates
        .filter((update) => update.kind === "lifecycle.changed")
        .map((update) => update.lifecycle.status),
    ).toEqual([]);

    socket.acknowledgement?.({ accepted: true });
    const subscribed = await subscribing;
    expect(subscribed.ok).toBe(true);
    expect(
      updates
        .filter((update) => update.kind === "lifecycle.changed")
        .map((update) => update.lifecycle.status),
    ).toEqual(["connecting", "joining", "active"]);
    await gateway.dispose({ deadlineAt: deadline() });
  });

  it.each([
    [{ status: "error", message: "forbidden" }, "validation"],
    [{ statusCode: "403" }, "authorization"],
    [{ error: "forbidden" }, "authorization"],
    [{ error: "unauthorized" }, "authentication"],
    [{ ok: true, code: "unauthorized" }, "authentication"],
    [{ accepted: true, success: false }, "validation"],
    [{ accepted: true, ok: "false" }, "validation"],
    [
      { accepted: true, cursor: "cursor-1", recoveryCursor: "cursor-2" },
      "validation",
    ],
    [{ accepted: true, recovered: false }, "validation"],
    [{ status: "ok", code: "unauthorized" }, "authentication"],
    [{ status: 200, statusCode: 403 }, "authorization"],
    [undefined, "validation"],
    [null, "validation"],
    ["403", "validation"],
    [403, "validation"],
    [cyclicJoinAcknowledgement, "validation"],
  ])(
    "fails closed for a rejected or unknown structured join ack %#",
    async (ack, expectedCode) => {
      const socket = new PlannedAckSocket(ack);
      const updates: ChatUpdate[] = [];
      const errors: ChatError[] = [];
      const provider = sessionProvider();
      const gateway = createTFRobotChatGateway({
        baseUrl: "https://robot.example/",
        messageCreatorProvider,
        sessionProvider: provider,
        fetch: vi.fn(),
        socketFactory: () => socket,
      });

      await expect(
        gateway.subscribe(
          { conversationId: "42", deadlineAt: deadline() },
          {
            next: (update) => updates.push(update),
            error: (error) => errors.push(error),
          },
        ),
      ).resolves.toMatchObject({
        ok: false,
        error: { code: expectedCode },
      });
      expect(updates).toEqual([]);
      expect(errors).toEqual([]);
      expect(socket.connected).toBe(false);
      if (
        expectedCode === "authentication" ||
        expectedCode === "authorization"
      ) {
        await vi.waitFor(() =>
          expect(provider.onSessionInvalid).toHaveBeenCalledOnce(),
        );
      } else {
        expect(provider.onSessionInvalid).not.toHaveBeenCalled();
      }
    },
  );

  it("consumes each join acknowledgement callback only once", async () => {
    const socket = new PlannedAckSocket(HOLD_JOIN_ACK);
    const updates: ChatUpdate[] = [];
    const provider = sessionProvider();
    const gateway = createTFRobotChatGateway({
      baseUrl: "https://robot.example/",
      messageCreatorProvider,
      sessionProvider: provider,
      fetch: vi.fn(),
      socketFactory: () => socket,
    });
    const subscribing = gateway.subscribe(
      { conversationId: "42", deadlineAt: deadline() },
      { next: (update) => updates.push(update) },
    );
    await vi.waitFor(() => expect(socket.acknowledgements).toHaveLength(1));
    socket.acknowledgements[0]!({ accepted: true });
    await expect(subscribing).resolves.toMatchObject({ ok: true });
    const settledUpdates = updates.length;

    socket.acknowledgements[0]!({ statusCode: 403 });
    await Promise.resolve();
    expect(updates).toHaveLength(settledUpdates);
    expect(provider.onSessionInvalid).not.toHaveBeenCalled();
    expect(socket.connected).toBe(true);
    await gateway.dispose({ deadlineAt: deadline() });
  });

  it("buffers realtime data until a reconnect join ack is accepted", async () => {
    const socket = new PlannedAckSocket(true, HOLD_JOIN_ACK);
    const updates: ChatUpdate[] = [];
    const gateway = createTFRobotChatGateway({
      baseUrl: "https://robot.example/",
      messageCreatorProvider,
      sessionProvider: sessionProvider(),
      fetch: vi.fn(async () => envelope({ working: false, taskId: null })),
      socketFactory: () => socket,
    });
    const subscribed = await gateway.subscribe(
      { conversationId: "42", deadlineAt: deadline() },
      { next: (update) => updates.push(update) },
    );
    expect(subscribed.ok).toBe(true);
    updates.length = 0;

    socket.connected = false;
    socket.trigger("disconnect", "transport close");
    socket.connect();
    await vi.waitFor(() => expect(socket.acknowledgements).toHaveLength(1));
    socket.trigger("chat_message", messageDto);
    expect(
      updates.filter((update) => update.kind === "timeline.upsert"),
    ).toEqual([]);

    socket.acknowledgements[0]!({
      accepted: true,
      recovered: true,
      cursor: "buffered-cursor",
    });
    await vi.waitFor(() =>
      expect(
        updates.filter((update) => update.kind === "timeline.upsert"),
      ).toHaveLength(1),
    );
    await gateway.dispose({ deadlineAt: deadline() });
  });

  it("discards buffered realtime data when a reconnect join is rejected", async () => {
    const socket = new PlannedAckSocket(true, HOLD_JOIN_ACK);
    const updates: ChatUpdate[] = [];
    const gateway = createTFRobotChatGateway({
      baseUrl: "https://robot.example/",
      messageCreatorProvider,
      sessionProvider: sessionProvider(),
      fetch: vi.fn(),
      socketFactory: () => socket,
    });
    const subscribed = await gateway.subscribe(
      { conversationId: "42", deadlineAt: deadline() },
      { next: (update) => updates.push(update) },
    );
    expect(subscribed.ok).toBe(true);
    updates.length = 0;

    socket.connected = false;
    socket.trigger("disconnect", "transport close");
    socket.connect();
    await vi.waitFor(() => expect(socket.acknowledgements).toHaveLength(1));
    socket.trigger("chat_message", messageDto);
    socket.acknowledgements[0]!({ statusCode: 403 });
    await Promise.resolve();
    expect(
      updates.filter((update) => update.kind === "timeline.upsert"),
    ).toEqual([]);
    await gateway.dispose({ deadlineAt: deadline() });
  });

  it("invalidates an interrupted join attempt and ignores its late ack", async () => {
    const socket = new PlannedAckSocket(HOLD_JOIN_ACK, { accepted: true });
    const updates: ChatUpdate[] = [];
    const gateway = createTFRobotChatGateway({
      baseUrl: "https://robot.example/",
      messageCreatorProvider,
      sessionProvider: sessionProvider(),
      fetch: vi.fn(),
      socketFactory: () => socket,
    });
    const subscribing = Promise.resolve(
      gateway.subscribe(
        { conversationId: "42", deadlineAt: deadline() },
        { next: (update) => updates.push(update) },
      ),
    );
    await vi.waitFor(() => expect(socket.acknowledgements).toHaveLength(1));

    socket.connected = false;
    socket.trigger("disconnect", "transport close");
    socket.connect();
    await expect(subscribing).resolves.toMatchObject({ ok: true });
    const statusCount = updates.filter(
      (update) => update.kind === "lifecycle.changed",
    ).length;
    socket.acknowledgements[0]!({ accepted: true });
    await Promise.resolve();
    expect(
      updates.filter((update) => update.kind === "lifecycle.changed"),
    ).toHaveLength(statusCount);
    expect(
      updates.some(
        (update) =>
          update.kind === "lifecycle.changed" &&
          update.lifecycle.status === "subscription-failed",
      ),
    ).toBe(false);
    await gateway.dispose({ deadlineAt: deadline() });
  });

  it("makes a reconnect join timeout terminal for late acknowledgements", async () => {
    vi.useFakeTimers();
    try {
      const socket = new PlannedAckSocket(true, HOLD_JOIN_ACK);
      const updates: ChatUpdate[] = [];
      const fetch = vi.fn();
      const gateway = createTFRobotChatGateway({
        baseUrl: "https://robot.example/",
        messageCreatorProvider,
        sessionProvider: sessionProvider(),
        fetch,
        socketFactory: () => socket,
      });
      const subscribed = await gateway.subscribe(
        { conversationId: "42", deadlineAt: deadline() },
        { next: (update) => updates.push(update) },
      );
      expect(subscribed.ok).toBe(true);
      updates.length = 0;

      socket.connected = false;
      socket.trigger("disconnect", "transport close");
      socket.connect();
      expect(socket.acknowledgements).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(
        updates.filter((update) => update.kind === "lifecycle.changed").at(-1),
      ).toMatchObject({ lifecycle: { status: "subscription-failed" } });
      const updateCount = updates.length;
      socket.acknowledgements[0]!({
        accepted: true,
        recovered: true,
        cursor: "late-cursor",
      });
      await Promise.resolve();
      expect(updates).toHaveLength(updateCount);
      expect(fetch).not.toHaveBeenCalled();
      await gateway.dispose({ deadlineAt: deadline() });
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the disconnect occurrence while a legacy reconnect ack remains unverified", async () => {
    const socket = new PlannedAckSocket(true, undefined);
    const updates: ChatUpdate[] = [];
    const gateway = createTFRobotChatGateway({
      baseUrl: "https://robot.example/",
      messageCreatorProvider,
      sessionProvider: sessionProvider(),
      fetch: vi.fn(async () => envelope({ working: false, taskId: null })),
      socketFactory: () => socket,
    });
    const subscribed = await gateway.subscribe(
      { conversationId: "42", deadlineAt: deadline() },
      { next: (update) => updates.push(update) },
    );
    expect(subscribed.ok).toBe(true);
    updates.length = 0;

    socket.connected = false;
    socket.trigger("disconnect", "ping timeout");
    const connectionError = updates.find(
      (update) =>
        update.kind === "error.reported" && update.source === "connection",
    );
    expect(connectionError?.kind).toBe("error.reported");
    socket.connect();

    await vi.waitFor(() =>
      expect(
        updates.filter((update) => update.kind === "lifecycle.changed").at(-1),
      ).toMatchObject({
        lifecycle: {
          status: "recovering",
          recovery: {
            complete: false,
            reason: "server-replay-contract-unavailable",
          },
        },
      }),
    );
    if (connectionError?.kind !== "error.reported") return;
    expect(
      updates.some(
        (update) =>
          update.kind === "error.resolved" &&
          update.errorId === connectionError.errorId,
      ),
    ).toBe(false);
    await gateway.dispose({ deadlineAt: deadline() });
  });

  it("fails closed when recovery acknowledgement aliases conflict", async () => {
    const socket = new PlannedAckSocket(true, {
      accepted: true,
      recovered: true,
      recoveryComplete: false,
      cursor: "conflicting-recovery-cursor",
    });
    const updates: ChatUpdate[] = [];
    const gateway = createTFRobotChatGateway({
      baseUrl: "https://robot.example/",
      messageCreatorProvider,
      sessionProvider: sessionProvider(),
      fetch: vi.fn(async () => envelope({ working: false, taskId: null })),
      socketFactory: () => socket,
    });
    const subscribed = await gateway.subscribe(
      { conversationId: "42", deadlineAt: deadline() },
      { next: (update) => updates.push(update) },
    );
    expect(subscribed.ok).toBe(true);
    updates.length = 0;

    socket.connected = false;
    socket.trigger("disconnect", "ping timeout");
    socket.connect();
    await vi.waitFor(() =>
      expect(
        updates.filter((update) => update.kind === "lifecycle.changed").at(-1),
      ).toMatchObject({
        lifecycle: { status: "subscription-failed" },
      }),
    );
    expect(
      updates.some(
        (update) =>
          update.kind === "lifecycle.changed" &&
          update.lifecycle.status === "active",
      ),
    ).toBe(false);
    expect(socket.connected).toBe(false);
    await gateway.dispose({ deadlineAt: deadline() });
  });

  it("does not grant a second forced-disconnect reconnect before recovery completes", async () => {
    const socket = new PlannedAckSocket(true, true);
    const provider = sessionProvider();
    const updates: ChatUpdate[] = [];
    const gateway = createTFRobotChatGateway({
      baseUrl: "https://robot.example/",
      messageCreatorProvider,
      sessionProvider: provider,
      fetch: vi.fn(async () => envelope({ working: false, taskId: null })),
      socketFactory: () => socket,
    });
    const subscribed = await gateway.subscribe(
      { conversationId: "42", deadlineAt: deadline() },
      { next: (update) => updates.push(update) },
    );
    expect(subscribed.ok).toBe(true);

    socket.connected = false;
    socket.trigger("disconnect", "io server disconnect");
    await vi.waitFor(() => expect(socket.emitted).toHaveLength(2));
    socket.connected = false;
    socket.trigger("disconnect", "io server disconnect");
    await Promise.resolve();
    expect(socket.emitted).toHaveLength(2);
    expect(provider.onSessionInvalid).toHaveBeenCalledOnce();
    expect(
      updates.filter((update) => update.kind === "lifecycle.changed").at(-1),
    ).toMatchObject({ lifecycle: { status: "auth-required" } });
    await gateway.dispose({ deadlineAt: deadline() });
  });

  it("does not let stale session invalidation reconnect past auth-required", async () => {
    const invalidation = deferred<void>();
    const socket = new PlannedAckSocket(true, true);
    const updates: ChatUpdate[] = [];
    const gateway = createTFRobotChatGateway({
      baseUrl: "https://robot.example/",
      messageCreatorProvider,
      sessionProvider: {
        getSession: () => ({
          kind: "bearer",
          token: "header.payload.signature",
        }),
        onSessionInvalid: vi.fn(() => invalidation.promise),
      },
      fetch: vi.fn(),
      socketFactory: () => socket,
    });
    const subscribed = await gateway.subscribe(
      { conversationId: "42", deadlineAt: deadline() },
      { next: (update) => updates.push(update) },
    );
    expect(subscribed.ok).toBe(true);

    socket.connected = false;
    socket.trigger("disconnect", "io server disconnect");
    socket.trigger("disconnect", "io server disconnect");
    expect(
      updates.filter((update) => update.kind === "lifecycle.changed").at(-1),
    ).toMatchObject({ lifecycle: { status: "auth-required" } });
    invalidation.resolve(undefined);
    await Promise.resolve();
    await Promise.resolve();
    expect(socket.emitted).toHaveLength(1);
    expect(socket.connected).toBe(false);
    await gateway.dispose({ deadlineAt: deadline() });
  });

  it("stops a forced-disconnect episode when the manual reconnect fails asynchronously", async () => {
    class AsyncReconnectFailureSocket extends PlannedAckSocket {
      connectAttempts = 0;

      override connect(): void {
        this.connectAttempts += 1;
        if (this.connectAttempts === 1) {
          super.connect();
          return;
        }
        this.connected = false;
        queueMicrotask(() => {
          this.trigger("connect_error", new Error("manual reconnect failed"));
        });
      }
    }

    const socket = new AsyncReconnectFailureSocket(true);
    const provider = sessionProvider();
    const updates: ChatUpdate[] = [];
    const gateway = createTFRobotChatGateway({
      baseUrl: "https://robot.example/",
      messageCreatorProvider,
      sessionProvider: provider,
      fetch: vi.fn(),
      socketFactory: () => socket,
    });
    const subscribed = await gateway.subscribe(
      { conversationId: "42", deadlineAt: deadline() },
      { next: (update) => updates.push(update) },
    );
    expect(subscribed.ok).toBe(true);

    socket.connected = false;
    socket.trigger("disconnect", "io server disconnect");
    await vi.waitFor(() =>
      expect(
        updates.filter((update) => update.kind === "lifecycle.changed").at(-1),
      ).toMatchObject({ lifecycle: { status: "auth-required" } }),
    );
    expect(socket.connectAttempts).toBe(2);
    expect(socket.connected).toBe(false);
    expect(provider.onSessionInvalid).toHaveBeenCalledOnce();
    await Promise.resolve();
    expect(socket.connectAttempts).toBe(2);
    await gateway.dispose({ deadlineAt: deadline() });
  });

  it.each([
    [
      "throws",
      () => {
        throw new Error("invalidation failed");
      },
    ],
    ["rejects", () => Promise.reject(new Error("invalidation failed"))],
  ])(
    "does not reconnect when session invalidation %s",
    async (_label, onSessionInvalid) => {
      const socket = new PlannedAckSocket(true, true);
      const updates: ChatUpdate[] = [];
      const gateway = createTFRobotChatGateway({
        baseUrl: "https://robot.example/",
        messageCreatorProvider,
        sessionProvider: {
          getSession: () => ({
            kind: "bearer",
            token: "header.payload.signature",
          }),
          onSessionInvalid: vi.fn(onSessionInvalid),
        },
        fetch: vi.fn(),
        socketFactory: () => socket,
      });
      const subscribed = await gateway.subscribe(
        { conversationId: "42", deadlineAt: deadline() },
        { next: (update) => updates.push(update) },
      );
      expect(subscribed.ok).toBe(true);

      socket.connected = false;
      socket.trigger("disconnect", "io server disconnect");
      await vi.waitFor(() =>
        expect(
          updates
            .filter((update) => update.kind === "lifecycle.changed")
            .at(-1),
        ).toMatchObject({ lifecycle: { status: "auth-required" } }),
      );
      expect(socket.emitted).toHaveLength(1);
      expect(socket.connected).toBe(false);
      await gateway.dispose({ deadlineAt: deadline() });
    },
  );

  it("bounds a hanging session invalidation before requiring authentication", async () => {
    vi.useFakeTimers();
    try {
      const socket = new PlannedAckSocket(true, true);
      const updates: ChatUpdate[] = [];
      const gateway = createTFRobotChatGateway({
        baseUrl: "https://robot.example/",
        messageCreatorProvider,
        sessionProvider: {
          getSession: () => ({
            kind: "bearer",
            token: "header.payload.signature",
          }),
          onSessionInvalid: vi.fn(() => new Promise<void>(() => undefined)),
        },
        fetch: vi.fn(),
        socketFactory: () => socket,
        now: () => Date.now(),
      });
      const subscribed = await gateway.subscribe(
        { conversationId: "42", deadlineAt: deadline() },
        { next: (update) => updates.push(update) },
      );
      expect(subscribed.ok).toBe(true);

      socket.connected = false;
      socket.trigger("disconnect", "io server disconnect");
      await vi.advanceTimersByTimeAsync(9_999);
      expect(socket.emitted).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(
        updates.filter((update) => update.kind === "lifecycle.changed").at(-1),
      ).toMatchObject({ lifecycle: { status: "auth-required" } });
      expect(socket.emitted).toHaveLength(1);
      expect(socket.connected).toBe(false);
      await gateway.dispose({ deadlineAt: deadline() });
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops realtime delivery after a reconnect join is rejected", async () => {
    const socket = new PlannedAckSocket(true, { statusCode: 403 });
    const updates: ChatUpdate[] = [];
    const provider = sessionProvider();
    const gateway = createTFRobotChatGateway({
      baseUrl: "https://robot.example/",
      messageCreatorProvider,
      sessionProvider: provider,
      fetch: vi.fn(),
      socketFactory: () => socket,
    });
    const subscribed = await gateway.subscribe(
      { conversationId: "42", deadlineAt: deadline() },
      { next: (update) => updates.push(update) },
    );
    expect(subscribed.ok).toBe(true);
    updates.length = 0;

    socket.connected = false;
    socket.trigger("disconnect", "transport close");
    socket.connect();
    await vi.waitFor(() =>
      expect(
        updates.filter((update) => update.kind === "lifecycle.changed").at(-1),
      ).toMatchObject({ lifecycle: { status: "auth-required" } }),
    );
    expect(socket.connected).toBe(false);
    const timelineCount = updates.filter(
      (update) => update.kind === "timeline.upsert",
    ).length;
    socket.trigger("chat_message", messageDto);
    expect(
      updates.filter((update) => update.kind === "timeline.upsert"),
    ).toHaveLength(timelineCount);
    expect(provider.onSessionInvalid).toHaveBeenCalledOnce();
    const terminalUpdateCount = updates.length;
    socket.trigger("connect_error", new Error("late connect failure"));
    await Promise.resolve();
    expect(updates).toHaveLength(terminalUpdateCount);
    expect(provider.onSessionInvalid).toHaveBeenCalledOnce();
    await gateway.dispose({ deadlineAt: deadline() });
  });

  it("keeps domain errors as independent conversation occurrences", async () => {
    const socket = new PlannedAckSocket(true);
    const updates: ChatUpdate[] = [];
    const gateway = createTFRobotChatGateway({
      baseUrl: "https://robot.example/",
      messageCreatorProvider,
      sessionProvider: sessionProvider(),
      fetch: vi.fn(),
      socketFactory: () => socket,
    });
    const subscribed = await gateway.subscribe(
      { conversationId: "42", deadlineAt: deadline() },
      { next: (update) => updates.push(update) },
    );
    expect(subscribed.ok).toBe(true);
    updates.length = 0;

    socket.trigger("chat_error", {
      conversationId: 42,
      error: "First domain failure",
    });
    socket.trigger("chat_error", {
      conversationId: 42,
      error: "Second domain failure",
    });
    const reported = updates.filter(
      (update) => update.kind === "error.reported",
    );
    expect(reported).toHaveLength(2);
    expect(reported).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "domain",
          scope: { kind: "conversation", id: "42" },
        }),
        expect.objectContaining({
          source: "domain",
          scope: { kind: "conversation", id: "42" },
        }),
      ]),
    );
    expect(
      updates.filter((update) => update.kind === "error.resolved"),
    ).toEqual([]);
    await gateway.dispose({ deadlineAt: deadline() });
  });

  it("activates verified recovery when realtime state supersedes the REST snapshot", async () => {
    const response = deferred<Response>();
    const socket = new PlannedAckSocket(true, {
      accepted: true,
      recovered: true,
      cursor: "cursor-realtime",
    });
    const updates: ChatUpdate[] = [];
    const gateway = createTFRobotChatGateway({
      baseUrl: "https://robot.example/",
      messageCreatorProvider,
      sessionProvider: sessionProvider(),
      fetch: vi.fn(() => response.promise),
      socketFactory: () => socket,
    });
    const subscribed = await gateway.subscribe(
      { conversationId: "42", deadlineAt: deadline() },
      { next: (update) => updates.push(update) },
    );
    expect(subscribed.ok).toBe(true);
    updates.length = 0;

    socket.connected = false;
    socket.trigger("disconnect", "transport close");
    socket.connect();
    await vi.waitFor(() =>
      expect(
        updates.some(
          (update) =>
            update.kind === "lifecycle.changed" &&
            update.lifecycle.status === "recovering",
        ),
      ).toBe(true),
    );
    socket.trigger("conversation_state_changed", {
      conversationId: 42,
      state: "working",
      taskId: "run-from-realtime",
    });
    response.resolve(envelope({ working: false, taskId: null }));

    await vi.waitFor(() =>
      expect(
        updates.filter((update) => update.kind === "lifecycle.changed").at(-1),
      ).toMatchObject({
        lifecycle: {
          status: "active",
          recovery: { complete: true, cursor: "cursor-realtime" },
        },
      }),
    );
    expect(
      updates.filter((update) => update.kind === "run.replace").at(-1),
    ).toMatchObject({ run: { id: "run-from-realtime" } });
    await gateway.dispose({ deadlineAt: deadline() });
  });

  it("resolves a failed recovery occurrence after a later verified recovery", async () => {
    const socket = new PlannedAckSocket(
      true,
      { accepted: true, recovered: true, cursor: "cursor-1" },
      { accepted: true, recovered: true, cursor: "cursor-2" },
    );
    const updates: ChatUpdate[] = [];
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response("failure", { status: 500 }))
      .mockResolvedValueOnce(envelope({ working: false, taskId: null }));
    const gateway = createTFRobotChatGateway({
      baseUrl: "https://robot.example/",
      messageCreatorProvider,
      sessionProvider: sessionProvider(),
      fetch,
      socketFactory: () => socket,
    });
    const subscribed = await gateway.subscribe(
      { conversationId: "42", deadlineAt: deadline() },
      { next: (update) => updates.push(update) },
    );
    expect(subscribed.ok).toBe(true);

    socket.connected = false;
    socket.trigger("disconnect", "transport close");
    socket.connect();
    await vi.waitFor(() =>
      expect(
        updates.find(
          (update) =>
            update.kind === "error.reported" && update.source === "recovery",
        ),
      ).toBeDefined(),
    );
    const recoveryError = updates.find(
      (update) =>
        update.kind === "error.reported" && update.source === "recovery",
    );
    if (recoveryError?.kind !== "error.reported") {
      throw new Error("Recovery error occurrence was not reported");
    }

    socket.connected = false;
    socket.trigger("disconnect", "transport close");
    socket.connect();
    await vi.waitFor(() =>
      expect(
        updates.filter((update) => update.kind === "lifecycle.changed").at(-1),
      ).toMatchObject({
        lifecycle: {
          status: "active",
          recovery: { complete: true, cursor: "cursor-2" },
        },
      }),
    );
    expect(
      updates.some(
        (update) =>
          update.kind === "error.resolved" &&
          update.errorId === recoveryError.errorId,
      ),
    ).toBe(true);
    await gateway.dispose({ deadlineAt: deadline() });
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
    expect(
      updates
        .filter(({ kind }) => kind !== "lifecycle.changed")
        .map(({ kind }) => kind),
    ).toEqual([
      "timeline.upsert",
      "event.transition.upsert",
      "timeline.upsert",
    ]);
    expect(JSON.stringify(updates)).not.toContain("sensitive");
    expect(JSON.stringify(updates)).not.toContain("event-name-secret");
    expect(JSON.stringify(updates)).not.toContain("summary-secret");
    expect(
      updates.filter((update) => update.kind === "timeline.upsert").at(-1),
    ).toMatchObject({
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
    expect(
      updates.filter((update) => update.kind === "run.replace").at(-1),
    ).toMatchObject({
      kind: "run.replace",
      run: { id: "run-live", status: "running" },
    });
    expect(errors.at(-1)).toMatchObject({ code: "server" });
    expect(JSON.stringify(errors)).not.toContain("secret-value");

    await subscribed.value.dispose({ deadlineAt: deadline() });
    socket.trigger("chat_message", messageDto);
    expect(
      updates.filter(
        (update) =>
          update.kind === "timeline.upsert" ||
          update.kind === "event.transition.upsert" ||
          update.kind === "run.replace",
      ),
    ).toHaveLength(4);
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
      expect(
        updates.filter(
          (update) =>
            update.kind === "timeline.upsert" ||
            update.kind === "event.transition.upsert",
        ),
      ).toHaveLength(3);
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

      const timelineUpdates = updates.filter(
        (update) => update.kind === "timeline.upsert",
      );
      expect(timelineUpdates).toHaveLength(1);
      expect(timelineUpdates[0]).toMatchObject({
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
    expect(
      updates.filter((update) => update.kind === "timeline.upsert"),
    ).toEqual([]);
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
      expect(updates.filter((update) => update.kind === "run.replace")).toEqual(
        [
          {
            kind: "run.replace",
            conversationId: "42",
            run: null,
          },
        ],
      );
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
      expect(updates.filter((update) => update.kind === "run.replace")).toEqual(
        [
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
        ],
      );
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
    expect(
      updates.filter((update) => update.kind === "run.replace"),
    ).toHaveLength(1);
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
    expect(
      updates.filter(
        (update) =>
          update.kind !== "error.reported" && update.kind !== "error.resolved",
      ),
    ).toEqual([]);
    expect(
      updates.filter((update) => update.kind === "error.reported"),
    ).toHaveLength(3);
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
    diagnostics.length = 0;

    expect(() => {
      socket.trigger("chat_message", messageDto);
      socket.trigger("chat_message", { ...messageDto, conversationId: "" });
    }).not.toThrow();
    await vi.waitFor(() => expect(diagnostics).toHaveLength(3));
    expect(diagnostics.map(({ code }) => code)).toEqual([
      "unknown",
      "unknown",
      "validation",
    ]);
  });

  it("keeps committed subscriptions active while isolating Gateway instances", async () => {
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
    expect(
      firstUpdates.filter((update) => update.kind === "timeline.upsert"),
    ).toHaveLength(1);
    expect(
      replacementUpdates.filter((update) => update.kind === "timeline.upsert"),
    ).toHaveLength(1);
    expect(
      secondUpdates.filter((update) => update.kind === "timeline.upsert"),
    ).toHaveLength(1);

    await firstGateway.dispose({ deadlineAt: deadline() });
    secondSockets.sockets[0]!.trigger("chat_message", messageDto);
    expect(
      secondUpdates.filter((update) => update.kind === "timeline.upsert"),
    ).toHaveLength(2);
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

  it("succeeds when sendText response data omits taskId", async () => {
    const fetch = vi.fn(
      async (
        input: Parameters<typeof globalThis.fetch>[0],
        init?: Parameters<typeof globalThis.fetch>[1],
      ) => {
        const request = new Request(input, init);
        const path = new URL(request.url).pathname;
        if (request.method === "POST" && path.endsWith("/messages")) {
          return envelope({});
        }
        throw new Error(`Unexpected request: ${request.method} ${path}`);
      },
    );
    const gateway = createTFRobotChatGateway({
      baseUrl: "https://robot.example/",
      messageCreatorProvider,
      sessionProvider: sessionProvider(),
      fetch,
      socketFactory: createSocketFixture().factory,
    });

    const result = await gateway.sendText({
      conversationId: "c-1",
      text: "Hello",
      deadlineAt: deadline(),
    });

    expect(result).toEqual({
      ok: true,
      value: { runId: syntheticRunId("c-1") },
    });
  });

  it("preserves taskId when sendText response data includes it", async () => {
    const fetch = vi.fn(
      async (
        input: Parameters<typeof globalThis.fetch>[0],
        init?: Parameters<typeof globalThis.fetch>[1],
      ) => {
        const request = new Request(input, init);
        const path = new URL(request.url).pathname;
        if (request.method === "POST" && path.endsWith("/messages")) {
          return envelope({ taskId: "real-task-99" });
        }
        throw new Error(`Unexpected request: ${request.method} ${path}`);
      },
    );
    const gateway = createTFRobotChatGateway({
      baseUrl: "https://robot.example/",
      messageCreatorProvider,
      sessionProvider: sessionProvider(),
      fetch,
      socketFactory: createSocketFixture().factory,
    });

    const result = await gateway.sendText({
      conversationId: "c-1",
      text: "Hello",
      deadlineAt: deadline(),
    });

    expect(result).toEqual({
      ok: true,
      value: { runId: "real-task-99" },
    });
  });

  it("still propagates a failed sendText response when taskId is missing", async () => {
    const fetch = vi.fn(
      async (
        input: Parameters<typeof globalThis.fetch>[0],
        init?: Parameters<typeof globalThis.fetch>[1],
      ) => {
        const request = new Request(input, init);
        const path = new URL(request.url).pathname;
        if (request.method === "POST" && path.endsWith("/messages")) {
          return new Response(
            JSON.stringify({ code: 500, message: "server down", data: null }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        throw new Error(`Unexpected request: ${request.method} ${path}`);
      },
    );
    const gateway = createTFRobotChatGateway({
      baseUrl: "https://robot.example/",
      messageCreatorProvider,
      sessionProvider: sessionProvider(),
      fetch,
      socketFactory: createSocketFixture().factory,
    });

    const result = await gateway.sendText({
      conversationId: "c-1",
      text: "Hello",
      deadlineAt: deadline(),
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "validation", message: "server down" },
    });
  });
});
