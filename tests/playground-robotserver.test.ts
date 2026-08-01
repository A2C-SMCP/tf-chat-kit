// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { beforeAll, describe, expect, it, vi } from "vitest";

import type {
  TFRobotSocket,
  TFRobotSocketAnyListener,
  TFRobotSocketFactoryInput,
  TFRobotSocketListener,
} from "../packages/chat-gateway-tfrobot/src/index.js";
import { PlaygroundApp } from "../playground/src/app.js";
import {
  createMockPlaygroundSession,
  type PlaygroundSession,
} from "../playground/src/playground-session.js";
import {
  createRobotServerPlaygroundSession,
  robotServerTestConversationTitle,
  validateRobotServerConnection,
  type RobotServerConnectionConfig,
  type RobotServerConnectionDraft,
} from "../playground/src/robotserver-session.js";

beforeAll(() => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (query: string): MediaQueryList =>
      ({
        addEventListener: () => undefined,
        addListener: () => undefined,
        dispatchEvent: () => false,
        matches: false,
        media: query,
        onchange: null,
        removeEventListener: () => undefined,
        removeListener: () => undefined,
      }) as MediaQueryList,
  });
});

const validDraft = (
  overrides: Partial<RobotServerConnectionDraft> = {},
): RobotServerConnectionDraft => ({
  authKind: "bearer",
  credential: "memory-only-secret",
  creatorName: "Playground developer",
  creatorUid: "developer-1",
  httpBaseUrl: "https://robot.example/api/",
  platformId: "platform-7",
  socketNamespaceUrl: "wss://robot.example/chat",
  socketPath: "/socket.io",
  ...overrides,
});

const validConfig = (
  auth: "admin" | "bearer" = "bearer",
): RobotServerConnectionConfig => {
  const result = validateRobotServerConnection({
    ...validDraft(),
    authKind: auth,
    credential: auth === "bearer" ? "bearer-secret" : "admin-secret",
  });
  if (!result.ok) throw new Error(result.message);
  return result.value;
};

const envelope = (data: unknown): Response =>
  new Response(JSON.stringify({ code: 200, message: "Success", data }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
};

const conversationDto = (conversationId: number, title: string) => ({
  conversationId,
  description: null,
  title,
  updateTimestamp: 1_773_705_600_000,
});

class FakeSocket implements TFRobotSocket {
  connected = false;
  disconnectCalls = 0;
  readonly emitted: Array<readonly [string, unknown]> = [];
  readonly #anyListeners = new Set<TFRobotSocketAnyListener>();
  readonly #listeners = new Map<string, Set<TFRobotSocketListener>>();

  connect(): void {
    this.connected = true;
    this.trigger("connect");
  }

  disconnect(): void {
    this.connected = false;
    this.disconnectCalls += 1;
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
    for (const listener of this.#anyListeners) listener(eventName, payload);
  }
}

const socketFixture = () => {
  const inputs: TFRobotSocketFactoryInput[] = [];
  const sockets: FakeSocket[] = [];
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

const createRobotServerFixture = (auth: "admin" | "bearer") => {
  const config = validConfig(auth);
  const sockets = socketFixture();
  const requests: Request[] = [];
  let createdTitle: string | undefined;
  const fetch = vi.fn(
    async (
      input: Parameters<typeof globalThis.fetch>[0],
      init?: Parameters<typeof globalThis.fetch>[1],
    ) => {
      const request = new Request(input, init);
      requests.push(request);
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname.endsWith("/conversations")) {
        return envelope({
          conversations: [
            conversationDto(42, "Existing conversation"),
            ...(createdTitle === undefined
              ? []
              : [conversationDto(43, createdTitle)]),
          ],
          cursor: null,
        });
      }
      if (
        request.method === "POST" &&
        url.pathname.endsWith("/conversations")
      ) {
        createdTitle = url.searchParams.get("title") ?? undefined;
        return envelope(conversationDto(43, createdTitle ?? "Missing title"));
      }
      if (request.method === "GET" && url.pathname.endsWith("/messages")) {
        return envelope({ cursor: null, events: [], messages: [] });
      }
      if (request.method === "GET" && url.pathname.endsWith("/status")) {
        return envelope({ taskId: null, working: false });
      }
      if (request.method === "POST" && url.pathname.endsWith("/messages")) {
        return envelope({ taskId: "run-accepted" });
      }
      if (request.method === "POST" && url.pathname.endsWith("/interrupt")) {
        return envelope({ taskId: "cancel-accepted" });
      }
      throw new Error(`Unexpected request: ${request.method} ${url.pathname}`);
    },
  );
  const now = Date.now();
  return {
    config,
    fetch,
    now,
    requests,
    session: createRobotServerPlaygroundSession(config, {
      fetch,
      now: () => now,
      socketFactory: sockets.factory,
    }),
    sockets,
    title: () => createdTitle,
  };
};

describe("RobotServer Playground configuration", () => {
  it.each([
    ["missing credentials", { credential: "" }],
    ["credentials in URL", { httpBaseUrl: "https://u:p@robot.example" }],
    ["query-bearing Socket URL", { socketNamespaceUrl: "wss://x/chat?t=1" }],
    ["invalid Socket path", { socketPath: "socket io" }],
    ["missing creator", { creatorUid: "" }],
  ])("rejects %s before a Gateway is created", (_label, override) => {
    const result = validateRobotServerConnection({
      ...validDraft(),
      ...override,
    });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain("memory-only-secret");
  });

  it("normalizes safe endpoints and creates the required retained title", () => {
    const result = validateRobotServerConnection(validDraft());
    expect(result).toMatchObject({
      ok: true,
      value: {
        credential: { kind: "bearer", token: "memory-only-secret" },
        httpBaseUrl: "https://robot.example/api",
        socketNamespaceUrl: "wss://robot.example/chat",
      },
    });
    expect(robotServerTestConversationTitle(1_773_705_600_000)).toBe(
      "[tf-chat-kit playground] 2026-03-17T00:00:00",
    );
  });
});

describe("RobotServer Playground authenticated lifecycle", () => {
  it.each([
    {
      auth: "bearer" as const,
      expectedAuth: { token: "bearer-secret" },
      header: "Authorization",
      missing: "admin_key",
      value: "Bearer bearer-secret",
    },
    {
      auth: "admin" as const,
      expectedAuth: { admin_key: "admin-secret" },
      header: "admin_key",
      missing: "Authorization",
      value: "admin-secret",
    },
  ])(
    "uses $auth authentication for every REST and Socket operation",
    async ({ auth, expectedAuth, header, missing, value }) => {
      const fixture = createRobotServerFixture(auth);
      await fixture.session.start();
      expect(fixture.session.getState()).toMatchObject({
        connected: true,
        contentState: { kind: "ready" },
        selectedConversationId: "42",
      });
      expect(await fixture.sockets.inputs[0]!.getAuth()).toEqual(expectedAuth);

      await fixture.session.reconnect();
      expect(fixture.sockets.sockets).toHaveLength(2);
      expect(fixture.sockets.sockets[0]!.disconnectCalls).toBe(1);
      expect(await fixture.sockets.inputs[1]!.getAuth()).toEqual(expectedAuth);
      expect(fixture.session.getState()).toMatchObject({
        connected: true,
        contentState: { kind: "ready" },
        selectedConversationId: "42",
      });

      await fixture.session.createConversation("ignored-host-title");
      expect(fixture.title()).toBe(
        robotServerTestConversationTitle(fixture.now),
      );
      expect(fixture.session.getState().selectedConversationId).toBe("43");
      expect(await fixture.sockets.inputs.at(-1)!.getAuth()).toEqual(
        expectedAuth,
      );
      expect(await fixture.sockets.inputs.at(-1)!.getAuth()).toEqual(
        expectedAuth,
      );

      fixture.sockets.sockets.at(-1)!.trigger("error", {
        message: "A non-fatal Socket protocol diagnostic",
      });
      expect(fixture.session.getState()).toMatchObject({
        connected: true,
        contentState: { kind: "error" },
        status: "RobotServer reported a sanitized validation diagnostic.",
      });

      const sent = await fixture.session.client.sendText({
        conversationId: "43",
        deadlineAt: fixture.now + 10_000,
        text: "Exercise the real write path",
      });
      expect(sent).toEqual({ ok: true, value: { runId: "run-accepted" } });
      fixture.sockets.sockets.at(-1)!.trigger("conversation_state_changed", {
        conversationId: 43,
        state: "working",
        taskId: "run-accepted",
      });
      expect(fixture.session.client.getSnapshot()?.run).toMatchObject({
        id: "run-accepted",
        status: "running",
      });
      expect(fixture.session.getState()).toMatchObject({
        connected: true,
        contentState: { kind: "ready" },
        status: "RobotServer resumed with a valid realtime update.",
      });

      fixture.sockets.sockets
        .at(-1)!
        .trigger("connect_error", new Error("Socket transport dropped"));
      expect(fixture.session.getState()).toMatchObject({
        connected: false,
        contentState: { kind: "disconnected" },
      });
      fixture.sockets.sockets.at(-1)!.trigger("conversation_state_changed", {
        conversationId: 43,
        state: "working",
        taskId: "run-recovered",
      });
      expect(fixture.session.client.getSnapshot()?.run?.id).toBe(
        "run-recovered",
      );
      expect(fixture.session.getState()).toMatchObject({
        connected: true,
        contentState: { kind: "ready" },
        status: "RobotServer resumed with a valid realtime update.",
      });
      fixture.sockets.sockets.at(-1)!.trigger("chat_message", {
        additionalKwargs: {},
        attachments: null,
        content: "Streamed from RobotServer",
        conversationId: 43,
        createTimestamp: fixture.now + 1,
        creator: { avatar: null, name: "Robot", uid: "robot" },
        msgId: "assistant-1",
        msgType: "text",
        role: "assistant",
      });
      expect(
        fixture.session.client
          .getSnapshot()
          ?.timeline.some(
            (item) =>
              item.kind === "message" &&
              item.content.kind === "text" &&
              item.content.text === "Streamed from RobotServer",
          ),
      ).toBe(true);
      await fixture.session.interrupt();

      expect(fixture.requests.length).toBeGreaterThanOrEqual(8);
      for (const request of fixture.requests) {
        expect(request.headers.get(header)).toBe(value);
        expect(request.headers.get(missing)).toBeNull();
        if (
          request.method === "POST" &&
          !new URL(request.url).pathname.endsWith("/conversations")
        ) {
          expect(request.headers.get("Content-Type")).toBe("application/json");
        }
      }
      expect(
        fixture.requests.some((request) => request.url.endsWith("/interrupt")),
      ).toBe(true);
      expect(fixture.sockets.inputs).not.toHaveLength(0);
      for (const socketInput of fixture.sockets.inputs) {
        expect(socketInput).toMatchObject({
          namespaceUrl: "wss://robot.example/chat",
          path: "/socket.io",
        });
      }
      const listRequests = fixture.requests.filter(
        (request) =>
          request.method === "GET" &&
          new URL(request.url).pathname.endsWith("/conversations"),
      );
      expect(listRequests).not.toHaveLength(0);
      expect(
        listRequests.every(
          (request) =>
            new URL(request.url).searchParams.get("platformId") ===
            "platform-7",
        ),
      ).toBe(true);
      const sendRequest = fixture.requests.find(
        (request) =>
          request.method === "POST" &&
          new URL(request.url).pathname.endsWith("/messages"),
      );
      expect(sendRequest).toBeDefined();
      await expect(sendRequest!.clone().json()).resolves.toMatchObject({
        content: "Exercise the real write path",
        creator: {
          name: "Playground developer",
          uid: "developer-1",
        },
      });
      expect(JSON.stringify(fixture.requests)).not.toContain(value);

      await fixture.session.dispose();
      expect(fixture.session.client.disposed).toBe(true);
      expect(
        fixture.sockets.sockets.every((socket) => socket.disconnectCalls === 1),
      ).toBe(true);
    },
  );

  it.each([
    [401, "authentication", "RobotServer authentication failed."],
    [403, "authorization", "RobotServer authorization failed."],
  ] as const)(
    "presents a safe %i connection failure",
    async (status, code, message) => {
      const secret = "must-not-reach-diagnostics";
      const config = validConfig("bearer");
      const session = createRobotServerPlaygroundSession(
        {
          ...config,
          credential: { kind: "bearer", token: secret },
        },
        {
          fetch: vi.fn(
            async () =>
              new Response(
                JSON.stringify({ detail: `Rejected token=${secret}` }),
                {
                  status,
                  headers: { "Content-Type": "application/json" },
                },
              ),
          ),
          socketFactory: socketFixture().factory,
        },
      );
      await session.start();
      expect(session.getState()).toMatchObject({
        connected: false,
        contentState: { kind: "error" },
        status: message,
      });
      expect(session.client.getSnapshot()).toBeNull();
      expect(JSON.stringify(session.getState())).not.toContain(secret);
      expect(JSON.stringify(session.getState())).toContain(
        code === "authentication" ? "401" : "403",
      );
      await session.dispose();
    },
  );

  it.each([
    {
      expectedKind: "disconnected",
      expectedStatus: "RobotServer network or CORS connection failed.",
      fetch: vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
      label: "network or CORS",
    },
    {
      expectedKind: "error",
      expectedStatus: "RobotServer validation error.",
      fetch: vi.fn(async () => envelope({ conversations: "invalid" })),
      label: "protocol",
    },
  ])(
    "presents a safe $label failure",
    async ({ expectedKind, expectedStatus, fetch }) => {
      const session = createRobotServerPlaygroundSession(validConfig(), {
        fetch,
        socketFactory: socketFixture().factory,
      });
      await session.start();
      expect(session.getState()).toMatchObject({
        connected: false,
        contentState: { kind: expectedKind },
        status: expectedStatus,
      });
      await session.dispose();
    },
  );

  it("presents a Socket establishment failure without losing REST context", async () => {
    const fetch = vi.fn(
      async (input: Parameters<typeof globalThis.fetch>[0]) => {
        const path = new URL(input instanceof Request ? input.url : input)
          .pathname;
        if (path.endsWith("/conversations")) {
          return envelope({
            conversations: [conversationDto(42, "Socket target")],
            cursor: null,
          });
        }
        if (path.endsWith("/messages")) {
          return envelope({ cursor: null, events: [], messages: [] });
        }
        if (path.endsWith("/status")) {
          return envelope({ taskId: null, working: false });
        }
        throw new Error(`Unexpected path: ${path}`);
      },
    );
    const session = createRobotServerPlaygroundSession(validConfig(), {
      fetch,
      socketFactory: () => {
        const socket = new FakeSocket();
        socket.connect = () =>
          socket.trigger("connect_error", new Error("Socket unreachable"));
        return socket;
      },
    });
    await session.start();
    expect(session.getState()).toMatchObject({
      connected: false,
      contentState: { kind: "disconnected" },
      conversations: [{ id: "42" }],
      status: "RobotServer network or CORS connection failed.",
    });
    await session.dispose();
  });

  it("keeps the latest conversation refresh when requests settle out of order", async () => {
    const requests = [deferred<Response>(), deferred<Response>()];
    let requestIndex = 0;
    const session = createRobotServerPlaygroundSession(validConfig(), {
      fetch: vi.fn(async (input: Parameters<typeof globalThis.fetch>[0]) => {
        const path = new URL(input instanceof Request ? input.url : input)
          .pathname;
        if (path.endsWith("/conversations")) {
          return requests[requestIndex++]!.promise;
        }
        if (path.endsWith("/messages")) {
          return envelope({ cursor: null, events: [], messages: [] });
        }
        if (path.endsWith("/status")) {
          return envelope({ taskId: null, working: false });
        }
        throw new Error(`Unexpected path: ${path}`);
      }),
      socketFactory: socketFixture().factory,
    });

    const older = session.refresh();
    const latest = session.refresh();
    await vi.waitFor(() => expect(requestIndex).toBe(2));
    requests[1]!.resolve(
      envelope({
        conversations: [conversationDto(43, "Latest conversations")],
        cursor: null,
      }),
    );
    await latest;
    requests[0]!.resolve(
      new Response(JSON.stringify({ detail: "Stale unauthorized response" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await older;

    expect(session.getState()).toMatchObject({
      connected: true,
      conversations: [{ id: "43", title: "Latest conversations" }],
      listError: undefined,
      listLoading: false,
    });
    await session.dispose();
  });

  it("keeps the latest rapid conversation selection", async () => {
    const olderHistory = deferred<Response>();
    const olderStatus = deferred<Response>();
    const fetch = vi.fn(
      async (input: Parameters<typeof globalThis.fetch>[0]) => {
        const path = new URL(input instanceof Request ? input.url : input)
          .pathname;
        if (path.endsWith("/conversations")) {
          return envelope({
            conversations: [
              conversationDto(44, "Initial selection"),
              conversationDto(42, "Older selection"),
              conversationDto(43, "Latest selection"),
            ],
            cursor: null,
          });
        }
        if (path.includes("/42/") && path.endsWith("/messages")) {
          return olderHistory.promise;
        }
        if (path.includes("/42/") && path.endsWith("/status")) {
          return olderStatus.promise;
        }
        if (path.includes("/43/") && path.endsWith("/messages")) {
          return envelope({ cursor: null, events: [], messages: [] });
        }
        if (path.includes("/43/") && path.endsWith("/status")) {
          return envelope({ taskId: null, working: false });
        }
        if (path.includes("/44/") && path.endsWith("/messages")) {
          return envelope({ cursor: null, events: [], messages: [] });
        }
        if (path.includes("/44/") && path.endsWith("/status")) {
          return envelope({ taskId: null, working: false });
        }
        throw new Error(`Unexpected path: ${path}`);
      },
    );
    const session = createRobotServerPlaygroundSession(validConfig(), {
      fetch,
      socketFactory: socketFixture().factory,
    });
    await session.refresh();

    const older = session.selectConversation("42");
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(5));
    const latest = session.selectConversation("43");
    await latest;
    olderHistory.resolve(envelope({ cursor: null, events: [], messages: [] }));
    olderStatus.resolve(envelope({ taskId: null, working: false }));
    await older;

    expect(session.getState()).toMatchObject({
      connected: true,
      contentState: { kind: "ready" },
      pendingConversationId: undefined,
      selectedConversationId: "43",
      status: "Viewing Latest selection.",
    });
    expect(session.client.getSnapshot()?.conversation.id).toBe("43");
    await session.dispose();
  });

  it("reconciles an older selection with a newer conversation refresh", async () => {
    const olderHistory = deferred<Response>();
    const olderStatus = deferred<Response>();
    let listCount = 0;
    const fetch = vi.fn(
      async (input: Parameters<typeof globalThis.fetch>[0]) => {
        const path = new URL(input instanceof Request ? input.url : input)
          .pathname;
        if (path.endsWith("/conversations")) {
          listCount += 1;
          return envelope({
            conversations:
              listCount === 1
                ? [conversationDto(42, "Older selection")]
                : [conversationDto(43, "Latest conversations")],
            cursor: null,
          });
        }
        if (path.includes("/42/") && path.endsWith("/messages")) {
          return olderHistory.promise;
        }
        if (path.includes("/42/") && path.endsWith("/status")) {
          return olderStatus.promise;
        }
        if (path.includes("/43/") && path.endsWith("/messages")) {
          return envelope({ cursor: null, events: [], messages: [] });
        }
        if (path.includes("/43/") && path.endsWith("/status")) {
          return envelope({ taskId: null, working: false });
        }
        throw new Error(`Unexpected path: ${path}`);
      },
    );
    const session = createRobotServerPlaygroundSession(validConfig(), {
      fetch,
      socketFactory: socketFixture().factory,
    });

    const older = session.start();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
    const latest = session.refresh();
    await latest;
    olderHistory.resolve(envelope({ cursor: null, events: [], messages: [] }));
    olderStatus.resolve(envelope({ taskId: null, working: false }));
    await older;

    expect(session.getState()).toMatchObject({
      connected: true,
      conversations: [{ id: "43", title: "Latest conversations" }],
      listError: undefined,
      listLoading: false,
      pendingConversationId: undefined,
      selectedConversationId: "43",
      status: "Viewing Latest conversations.",
    });
    expect(session.client.getSnapshot()?.conversation.id).toBe("43");
    await session.dispose();
  });
});

const setInput = (input: HTMLInputElement, value: string): void => {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
};

const setTextArea = (input: HTMLTextAreaElement, value: string): void => {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    "value",
  )?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
};

describe("RobotServer Playground page security boundary", () => {
  it("drops form credentials and disposes sessions across mode changes", async () => {
    const mockSessions = [createMockPlaygroundSession()];
    vi.spyOn(mockSessions[0]!, "dispose");
    const robotSessions: PlaygroundSession[] = [];
    const configs: RobotServerConnectionConfig[] = [];
    const createRobotServerSession = (config: RobotServerConnectionConfig) => {
      configs.push(config);
      const session = createMockPlaygroundSession();
      Object.defineProperty(session, "kind", { value: "robotserver" });
      vi.spyOn(session, "dispose");
      robotSessions.push(session as PlaygroundSession);
      return session as PlaygroundSession;
    };
    const storage = vi.spyOn(Storage.prototype, "setItem");
    const historyPush = vi.spyOn(history, "pushState");
    const historyReplace = vi.spyOn(history, "replaceState");
    const consoleSpies = [
      vi.spyOn(console, "debug").mockImplementation(() => undefined),
      vi.spyOn(console, "error").mockImplementation(() => undefined),
      vi.spyOn(console, "info").mockImplementation(() => undefined),
      vi.spyOn(console, "log").mockImplementation(() => undefined),
      vi.spyOn(console, "warn").mockImplementation(() => undefined),
    ];
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const previous = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

    try {
      await act(async () => {
        root.render(
          createElement(PlaygroundApp, {
            createRobotServerSession,
            createSession: () => mockSessions[0]!,
          }),
        );
        await Promise.resolve();
      });
      const robotMode = [...container.querySelectorAll("button")].find(
        (button) => button.textContent === "RobotServer mode",
      );
      await act(async () => robotMode!.click());
      await vi.waitFor(() => {
        expect(container.textContent).toContain("Connect to RobotServer");
        expect(mockSessions[0]!.client.disposed).toBe(true);
        expect(mockSessions[0]!.dispose).toHaveBeenCalledOnce();
      });

      const values: Record<string, string> = {
        "HTTP base URL": "https://robot.example/api",
        "Socket namespace URL": "wss://robot.example/chat",
        "Socket path": "/socket.io",
        platformId: "platform-7",
        "Creator ID": "developer-1",
        "Creator name": "Playground developer",
        "Bearer Token": "dom-memory-only-secret",
      };
      await act(async () => {
        for (const [label, value] of Object.entries(values)) {
          const input = container.querySelector<HTMLInputElement>(
            `input[aria-label="${label}"]`,
          );
          expect(input).not.toBeNull();
          setInput(input!, value);
        }
      });
      const connect = [...container.querySelectorAll("button")].find(
        (button) => button.textContent === "Connect in real mode",
      );
      await act(async () => {
        connect!.click();
        await Promise.resolve();
      });
      await vi.waitFor(() => {
        expect(configs).toHaveLength(1);
        expect(container.textContent).toContain("RobotServer operations");
      });
      expect(configs[0]?.credential).toEqual({
        kind: "bearer",
        token: "dom-memory-only-secret",
      });
      expect(container.innerHTML).not.toContain("dom-memory-only-secret");
      expect(document.cookie).not.toContain("dom-memory-only-secret");
      expect(location.href).not.toContain("dom-memory-only-secret");
      expect(storage).not.toHaveBeenCalled();
      expect(historyPush).not.toHaveBeenCalled();
      expect(historyReplace).not.toHaveBeenCalled();
      for (const consoleSpy of consoleSpies) {
        expect(consoleSpy).not.toHaveBeenCalled();
      }

      const reconfigure = [...container.querySelectorAll("button")].find(
        (button) => button.textContent === "Reconfigure RobotServer",
      );
      await act(async () => reconfigure!.click());
      await vi.waitFor(() => {
        expect(robotSessions[0]?.client.disposed).toBe(true);
        expect(robotSessions[0]?.dispose).toHaveBeenCalledOnce();
        expect(container.textContent).toContain("Connect to RobotServer");
      });
    } finally {
      await act(async () => root.unmount());
      storage.mockRestore();
      historyPush.mockRestore();
      historyReplace.mockRestore();
      for (const consoleSpy of consoleSpies) consoleSpy.mockRestore();
      container.remove();
      if (previous === undefined) {
        Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
      } else {
        Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previous);
      }
    }
  });

  it("keeps an opaque credential out of successful and failed server DOM data", async () => {
    const secret = "cobalt-dawn-47";
    const sockets = socketFixture();
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
              conversationDto(42, `Server echoed ${secret} in its title`),
            ],
            cursor: null,
          });
        }
        if (request.method === "GET" && path.endsWith("/messages")) {
          return envelope({ cursor: null, events: [], messages: [] });
        }
        if (request.method === "GET" && path.endsWith("/status")) {
          return envelope({ taskId: null, working: false });
        }
        if (request.method === "POST" && path.endsWith("/messages")) {
          return new Response(
            JSON.stringify({
              detail: `RobotServer echoed ${secret} without a label`,
              nested: { echoed: secret },
            }),
            {
              status: 500,
              headers: { "Content-Type": "application/json" },
            },
          );
        }
        throw new Error(`Unexpected request: ${request.method} ${path}`);
      },
    );
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const previous = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

    try {
      await act(async () => {
        root.render(
          createElement(PlaygroundApp, {
            createRobotServerSession: (config) =>
              createRobotServerPlaygroundSession(config, {
                fetch,
                socketFactory: sockets.factory,
              }),
          }),
        );
        await Promise.resolve();
      });
      const robotMode = [...container.querySelectorAll("button")].find(
        (button) => button.textContent === "RobotServer mode",
      );
      await act(async () => robotMode!.click());
      await vi.waitFor(() =>
        expect(container.textContent).toContain("Connect to RobotServer"),
      );

      const values: Record<string, string> = {
        "HTTP base URL": "https://robot.example/api",
        "Socket namespace URL": "wss://robot.example/chat",
        "Socket path": "/socket.io",
        platformId: "platform-7",
        "Creator ID": "developer-1",
        "Creator name": "Playground developer",
        "Bearer Token": secret,
      };
      await act(async () => {
        for (const [label, value] of Object.entries(values)) {
          const input = container.querySelector<HTMLInputElement>(
            `input[aria-label="${label}"]`,
          );
          setInput(input!, value);
        }
      });
      const connect = [...container.querySelectorAll("button")].find(
        (button) => button.textContent === "Connect in real mode",
      );
      await act(async () => {
        connect!.click();
        await Promise.resolve();
      });
      await vi.waitFor(() => {
        expect(container.textContent).toContain(
          "Server echoed [REDACTED] in its title",
        );
        expect(
          container.querySelector('textarea[aria-label="Message"]'),
        ).not.toBeNull();
      });
      expect(container.innerHTML).not.toContain(secret);

      await act(async () => {
        sockets.sockets.at(-1)!.trigger("chat_message", {
          additionalKwargs: {},
          attachments: null,
          content: `Realtime echo ${secret}`,
          conversationId: 42,
          createTimestamp: 1_773_705_600_002,
          creator: { avatar: null, name: "Robot", uid: "robot" },
          msgId: "realtime-secret-echo",
          msgType: "text",
          role: "assistant",
        });
        await Promise.resolve();
      });
      await vi.waitFor(() =>
        expect(container.textContent).toContain("Realtime echo [REDACTED]"),
      );
      expect(container.innerHTML).not.toContain(secret);

      const composer = container.querySelector<HTMLTextAreaElement>(
        'textarea[aria-label="Message"]',
      );
      await act(async () => setTextArea(composer!, "Trigger safe failure"));
      const send = [...container.querySelectorAll("button")].find(
        (button) => button.textContent === "Send",
      );
      await act(async () => {
        send!.click();
        await Promise.resolve();
      });

      await vi.waitFor(() =>
        expect(container.textContent).toContain(
          "RobotServer reported an internal chat failure.",
        ),
      );
      expect(container.innerHTML).not.toContain(secret);
      expect(document.cookie).not.toContain(secret);
      expect(location.href).not.toContain(secret);
    } finally {
      await act(async () => root.unmount());
      container.remove();
      if (previous === undefined) {
        Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
      } else {
        Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previous);
      }
    }
  });
});
