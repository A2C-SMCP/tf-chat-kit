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
  parseRobotServerDebugPrefill,
  type RobotServerDebugPrefillResult,
} from "../playground/src/robotserver-debug-prefill.js";
import { RobotServerConnectionPanel } from "../playground/src/robotserver-panel.js";
import {
  createRobotServerPlaygroundSession,
  robotServerTestConversationTitle,
  validateRobotServerConnection,
  type RobotServerConnectionConfig,
  type RobotServerConnectionDraft,
} from "../playground/src/robotserver-session.js";
import { loginRobotServerWithPassword } from "../playground/src/robotserver-login.js";
import { parseTFRobotTarget } from "../playground/src/robotserver-target.js";

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
  allowedServerOrigins: [],
  authKind: "bearer",
  connectionKind: "direct",
  credential: "memory-only-secret",
  creatorName: "Playground developer",
  creatorUid: "developer-1",
  httpBaseUrl: "https://robot.example/api/",
  namespace: "",
  platformId: "platform-7",
  proxyOrigin: "http://localhost:3000",
  robotId: "",
  serverOrigin: "",
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

const createRobotServerFixture = (
  auth: "admin" | "bearer",
  options: { readonly createResponse?: Promise<void> | undefined } = {},
) => {
  const config = validConfig(auth);
  const sockets = socketFixture();
  const requests: Request[] = [];
  let createdTitle: string | undefined;
  let uploadedFormData: FormData | undefined;
  const fetch = vi.fn(
    async (
      input: Parameters<typeof globalThis.fetch>[0],
      init?: Parameters<typeof globalThis.fetch>[1],
    ) => {
      const inputUrl =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      if (
        init?.method === "POST" &&
        new URL(inputUrl).pathname.endsWith(
          "/v1/dashboard/remote/source/cos/upload",
        )
      ) {
        uploadedFormData = init.body as FormData;
        requests.push(new Request(input, { ...init, body: null }));
        return envelope({ uri: "s3://playground/acceptance.txt" });
      }
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
        await options.createResponse;
        return envelope(conversationDto(43, createdTitle ?? "Missing title"));
      }
      if (
        request.method === "PATCH" &&
        url.pathname.endsWith("/conversations/43")
      ) {
        const body = (await request.json()) as { title?: unknown };
        createdTitle =
          typeof body.title === "string" ? body.title : createdTitle;
        return envelope(conversationDto(43, createdTitle ?? "Missing title"));
      }
      if (
        request.method === "DELETE" &&
        url.pathname.endsWith("/conversations/43")
      ) {
        createdTitle = undefined;
        return envelope({ conversationId: 43, message: "deleted" });
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
    uploadedFormData: () => uploadedFormData,
  };
};

describe("RobotServer Playground configuration", () => {
  it.each([
    ["missing credentials", { credential: "" }],
    ["credentials in URL", { httpBaseUrl: "https://u:p@robot.example" }],
    ["query-bearing Socket URL", { socketNamespaceUrl: "wss://x/chat?t=1" }],
    ["invalid Socket path", { socketPath: "socket io" }],
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

  it("derives routed HTTP and Socket settings from explicit robot fields", () => {
    const result = parseTFRobotTarget(
      {
        namespace: "tfrs-org-18",
        robotId: "de-eed9dc12a94b492ea8e7",
        serverOrigin: "https://staging.turingfocus.cn",
      },
      "http://localhost:3000",
    );
    expect(result).toEqual({
      ok: true,
      value: {
        apiOrigin: "https://api.staging.turingfocus.cn",
        httpBaseUrl:
          "http://localhost:3000/__tfrobot_proxy/https%3A%2F%2Fapi.staging.turingfocus.cn/tfrobot/tfrs-org-18/de-eed9dc12a94b492ea8e7",
        namespace: "tfrs-org-18",
        robotId: "de-eed9dc12a94b492ea8e7",
        robotType: "tfrobot",
        serverOrigin: "https://staging.turingfocus.cn",
        socketNamespaceUrl: "https://staging.turingfocus.cn/chat",
        socketPath: "/c/tfrobot/tfrs-org-18/de-eed9dc12a94b492ea8e7/socket.io",
      },
    });
  });

  it.each(["https://attacker.example", "http://staging.turingfocus.cn"])(
    "rejects an untrusted service origin before creating a Gateway",
    (url) => {
      const result = validateRobotServerConnection({
        ...validDraft(),
        connectionKind: "standard",
        namespace: "example-ns",
        robotId: "example-robot",
        serverOrigin: url,
      });
      expect(result).toMatchObject({ ok: false });
      expect(JSON.stringify(result)).not.toContain("memory-only-secret");
    },
  );

  it("accepts an explicitly allowlisted local service origin for testing", () => {
    const result = parseTFRobotTarget(
      {
        namespace: "e2e-ns",
        robotId: "e2e-robot",
        serverOrigin: "http://localhost:4310",
      },
      "http://localhost:3000",
      ["http://localhost:4310"],
    );
    expect(result).toMatchObject({
      ok: true,
      value: {
        apiOrigin: "http://localhost:4310",
        socketNamespaceUrl: "http://localhost:4310/chat",
      },
    });
  });

  it("omits platformId on the real request when the standard field is blank", async () => {
    const result = validateRobotServerConnection({
      ...validDraft(),
      connectionKind: "standard",
      namespace: "tfrs-org-18",
      robotId: "de-eed9dc12a94b492ea8e7",
      serverOrigin: "https://staging.turingfocus.cn",
      creatorName: "",
      creatorUid: "",
      platformId: "",
    });
    expect(result).toMatchObject({
      ok: true,
      value: {
        creator: { name: "CurrentUser", uid: "current-user" },
      },
    });
    if (result.ok) expect(result.value.platformId).toBeUndefined();
    if (!result.ok) return;
    const requests: Request[] = [];
    const session = createRobotServerPlaygroundSession(result.value, {
      fetch: vi.fn(async (input, init) => {
        requests.push(new Request(input, init));
        return envelope({ conversations: [], cursor: null });
      }),
      socketFactory: socketFixture().factory,
    });
    await session.refresh();
    expect(requests).toHaveLength(1);
    expect(new URL(requests[0]!.url).searchParams.has("platformId")).toBe(
      false,
    );
    await session.dispose();
  });

  it("exchanges an administrator password for an in-memory Admin Token", async () => {
    const password = "password-only-in-request";
    const fetch = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        expect(init?.method).toBe("POST");
        expect(JSON.parse(String(init?.body))).toEqual({ password });
        return envelope({
          accessToken: "short-lived-admin-token",
          expiresAt: "2026-08-02T00:00:00Z",
        });
      },
    );
    const target = validateRobotServerConnection({
      ...validDraft(),
      credential: "placeholder",
    });
    expect(target.ok).toBe(true);
    if (!target.ok) return;
    const result = await loginRobotServerWithPassword(target.value, password, {
      fetch,
    });
    expect(result).toMatchObject({
      ok: true,
      value: {
        credential: { adminKey: "short-lived-admin-token", kind: "admin" },
      },
    });
    expect(JSON.stringify(result)).not.toContain(password);
  });

  it("returns a safe password-login error without echoing credentials", async () => {
    const password = "wrong-password-must-not-leak";
    const result = await loginRobotServerWithPassword(validConfig(), password, {
      fetch: vi.fn(
        async () =>
          new Response(JSON.stringify({ detail: password }), { status: 401 }),
      ),
    });
    expect(result).toEqual({ ok: false, message: "管理员密码不正确。" });
    expect(JSON.stringify(result)).not.toContain(password);
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
        status: "RobotServer 上报了已脱敏的 validation 诊断信息。",
      });

      const sent = await fixture.session.client.sendText({
        conversationId: "43",
        deadlineAt: fixture.now + 10_000,
        text: "Exercise the real write path",
      });
      expect(sent).toEqual({ ok: true, value: { runId: "run-accepted" } });
      await expect(
        fixture.session.attachmentUploader.upload({
          blob: new Blob(["robot attachment"], { type: "text/plain" }),
          deadlineAt: fixture.now + 10_000,
          fileName: "acceptance.txt",
          mimeType: "text/plain",
        }),
      ).resolves.toEqual({
        ok: true,
        value: {
          mimeType: "text/plain",
          name: "acceptance.txt",
          size: 16,
          uri: "s3://playground/acceptance.txt",
        },
      });
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
        status: "RobotServer 已通过有效实时更新恢复连接。",
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
        status: "RobotServer 已通过有效实时更新恢复连接。",
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

      await expect(fixture.session.deleteConversation("42")).resolves.toBe(
        false,
      );
      const renamedTitle = `${robotServerTestConversationTitle(
        fixture.now,
      )} renamed`;
      await expect(
        fixture.session.renameConversation("43", renamedTitle),
      ).resolves.toBe(true);
      expect(fixture.title()).toBe(renamedTitle);
      await expect(fixture.session.deleteConversation("43")).resolves.toBe(
        true,
      );
      expect(fixture.title()).toBeUndefined();
      expect(fixture.session.getState()).toMatchObject({
        contentState: { kind: "empty" },
        selectedConversationId: undefined,
      });

      expect(fixture.requests.length).toBeGreaterThanOrEqual(8);
      for (const request of fixture.requests) {
        expect(request.headers.get(header)).toBe(value);
        expect(request.headers.get(missing)).toBeNull();
        if (
          request.method === "POST" &&
          !new URL(request.url).pathname.endsWith("/conversations") &&
          !new URL(request.url).pathname.endsWith(
            "/v1/dashboard/remote/source/cos/upload",
          )
        ) {
          expect(request.headers.get("Content-Type")).toBe("application/json");
        }
      }
      expect(
        fixture.requests.some((request) => request.url.endsWith("/interrupt")),
      ).toBe(true);
      const uploadRequest = fixture.requests.find((request) =>
        new URL(request.url).pathname.endsWith(
          "/v1/dashboard/remote/source/cos/upload",
        ),
      );
      expect(uploadRequest).toBeDefined();
      const uploadBody = fixture.uploadedFormData();
      expect(uploadBody).toBeDefined();
      expect(uploadBody!.get("file")).toMatchObject({
        name: "acceptance.txt",
        size: 16,
        type: "text/plain",
      });
      expect(
        fixture.requests.some(
          (request) =>
            request.method === "PATCH" &&
            new URL(request.url).pathname.endsWith("/conversations/43"),
        ),
      ).toBe(true);
      expect(
        fixture.requests.some(
          (request) =>
            request.method === "DELETE" &&
            new URL(request.url).pathname.endsWith("/conversations/43"),
        ),
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
      await fixture.session.dispose();
      expect(fixture.session.client.disposed).toBe(true);
      expect(
        fixture.sockets.sockets.every((socket) => socket.disconnectCalls === 1),
      ).toBe(true);
      const requestsAfterDispose = fixture.requests.length;
      await expect(
        fixture.session.attachmentUploader.upload({
          blob: new Blob(["late"]),
          deadlineAt: fixture.now + 10_000,
          fileName: "late.txt",
        }),
      ).resolves.toMatchObject({ ok: false, error: { code: "conflict" } });
      expect(fixture.requests).toHaveLength(requestsAfterDispose);
    },
  );

  it("best-effort deletes only exact conversations created by the session during disposal", async () => {
    const fixture = createRobotServerFixture("bearer");
    await fixture.session.start();
    await expect(
      fixture.session.createConversation("ignored-host-title"),
    ).resolves.toBe(true);
    expect(fixture.title()).toBe(robotServerTestConversationTitle(fixture.now));

    await fixture.session.dispose();

    expect(fixture.title()).toBeUndefined();
    const deletePaths = fixture.requests
      .filter((request) => request.method === "DELETE")
      .map((request) => new URL(request.url).pathname);
    expect(deletePaths).toEqual([
      expect.stringMatching(/\/v1\/chat\/conversations\/43$/u),
    ]);
    expect(deletePaths.some((path) => path.endsWith("/42"))).toBe(false);
  });

  it("waits for an in-flight test creation before disposal cleanup snapshots owned IDs", async () => {
    const createResponse = deferred<void>();
    const fixture = createRobotServerFixture("bearer", {
      createResponse: createResponse.promise,
    });
    await fixture.session.start();
    const creating = fixture.session.createConversation("ignored-host-title");
    await vi.waitFor(() =>
      expect(
        fixture.requests.some(
          (request) =>
            request.method === "POST" &&
            new URL(request.url).pathname.endsWith("/conversations"),
        ),
      ).toBe(true),
    );

    const disposing = fixture.session.dispose();
    createResponse.resolve(undefined);

    await expect(creating).resolves.toBe(false);
    await disposing;
    expect(fixture.title()).toBeUndefined();
    expect(
      fixture.requests.filter((request) => request.method === "DELETE"),
    ).toHaveLength(1);
  });

  it.each([
    [401, "authentication", "RobotServer 鉴权失败。"],
    [403, "authorization", "RobotServer 授权失败。"],
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
      expectedStatus: "RobotServer 网络或跨域连接失败。",
      fetch: vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
      label: "network or CORS",
    },
    {
      expectedKind: "error",
      expectedStatus: "RobotServer 发生 validation 错误。",
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
      status: "RobotServer 网络或跨域连接失败。",
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

  it("keeps an in-flight conversation selection active while history refreshes", async () => {
    const selectedHistory = deferred<Response>();
    const selectedStatus = deferred<Response>();
    const fetch = vi.fn(
      async (input: Parameters<typeof globalThis.fetch>[0]) => {
        const path = new URL(input instanceof Request ? input.url : input)
          .pathname;
        if (path.endsWith("/conversations")) {
          return envelope({
            conversations: [
              conversationDto(44, "Initial selection"),
              conversationDto(42, "Selected conversation"),
            ],
            cursor: null,
          });
        }
        if (path.includes("/42/") && path.endsWith("/messages")) {
          return selectedHistory.promise.then((response) => response.clone());
        }
        if (path.includes("/42/") && path.endsWith("/status")) {
          return selectedStatus.promise.then((response) => response.clone());
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
    await session.start();

    const selection = session.selectConversation("42");
    await vi.waitFor(() =>
      expect(session.getState()).toMatchObject({
        contentState: { kind: "loading" },
        pendingConversationId: "42",
      }),
    );
    await session.loadConversations();
    expect(session.getState()).toMatchObject({
      contentState: { kind: "loading" },
      pendingConversationId: "42",
    });

    selectedHistory.resolve(
      envelope({ cursor: null, events: [], messages: [] }),
    );
    selectedStatus.resolve(envelope({ taskId: null, working: false }));
    await selection;

    expect(session.getState()).toMatchObject({
      connected: true,
      contentState: { kind: "ready" },
      pendingConversationId: undefined,
      selectedConversationId: "42",
      status: "正在查看「Selected conversation」。",
    });
    expect(session.client.getSnapshot()?.conversation.id).toBe("42");
    await session.dispose();
  });

  it("selects from the latest history request when startup lists settle out of order", async () => {
    const listRequests = [deferred<Response>(), deferred<Response>()];
    let listRequestIndex = 0;
    const requestedPaths: string[] = [];
    const fetch = vi.fn(
      async (input: Parameters<typeof globalThis.fetch>[0]) => {
        const path = new URL(input instanceof Request ? input.url : input)
          .pathname;
        requestedPaths.push(path);
        if (path.endsWith("/conversations")) {
          return listRequests[listRequestIndex++]!.promise;
        }
        if (path.includes("/43/") && path.endsWith("/messages")) {
          return envelope({ cursor: null, events: [], messages: [] });
        }
        if (path.includes("/43/") && path.endsWith("/status")) {
          return envelope({ taskId: null, working: false });
        }
        if (path.includes("/42/") && path.endsWith("/messages")) {
          return envelope({ cursor: null, events: [], messages: [] });
        }
        if (path.includes("/42/") && path.endsWith("/status")) {
          return envelope({ taskId: null, working: false });
        }
        throw new Error(`Unexpected path: ${path}`);
      },
    );
    const session = createRobotServerPlaygroundSession(validConfig(), {
      fetch,
      socketFactory: socketFixture().factory,
    });

    const startup = session.start();
    await vi.waitFor(() => expect(listRequestIndex).toBe(1));
    const history = session.loadConversations();
    await vi.waitFor(() => expect(listRequestIndex).toBe(2));
    listRequests[1]!.resolve(
      envelope({
        conversations: [conversationDto(43, "Newest conversation")],
        cursor: null,
      }),
    );
    await history;
    listRequests[0]!.resolve(
      envelope({
        conversations: [conversationDto(42, "Stale conversation")],
        cursor: null,
      }),
    );
    await startup;

    expect(session.getState()).toMatchObject({
      connected: true,
      contentState: { kind: "ready" },
      conversations: [{ id: "43", title: "Newest conversation" }],
      selectedConversationId: "43",
      status: "正在查看「Newest conversation」。",
    });
    expect(session.client.getSnapshot()?.conversation.id).toBe("43");
    expect(requestedPaths.some((path) => path.includes("/42/"))).toBe(false);
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
      status: "正在查看「Latest selection」。",
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
    await vi.waitFor(() =>
      expect(fetch.mock.calls.length).toBeGreaterThanOrEqual(2),
    );
    const latest = session.refresh();
    await latest;
    expect(fetch.mock.calls.length).toBeGreaterThanOrEqual(7);
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
      status: "正在查看「Latest conversations」。",
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

describe("RobotServer Playground local debug prefill", () => {
  it("validates the private file shape without accepting unknown or inconsistent fields", () => {
    expect(
      parseRobotServerDebugPrefill({
        authKind: "password",
        namespace: "example-ns",
        robotId: "example-robot",
        secret: "local-password",
        serverOrigin: "https://staging.turingfocus.cn",
      }),
    ).toEqual({
      ok: true,
      value: {
        authKind: "password",
        namespace: "example-ns",
        robotId: "example-robot",
        secret: "local-password",
        serverOrigin: "https://staging.turingfocus.cn",
      },
    });
    expect(
      parseRobotServerDebugPrefill({
        authKind: "password",
        connectionKind: "direct",
      }).ok,
    ).toBe(false);
    expect(parseRobotServerDebugPrefill({ persist: true }).ok).toBe(false);
    expect(parseRobotServerDebugPrefill({ secret: "x".repeat(8_193) }).ok).toBe(
      false,
    );
  });

  it("prefills every supported form field in memory", async () => {
    const actEnvironmentKey = "IS_REACT_ACT_ENVIRONMENT";
    const previousActEnvironment = Reflect.get(globalThis, actEnvironmentKey);
    Reflect.set(globalThis, actEnvironmentKey, true);
    const storage = vi.spyOn(Storage.prototype, "setItem");
    const loadDebugPrefill = vi.fn(
      async (): Promise<RobotServerDebugPrefillResult> => ({
        ok: true,
        value: {
          authKind: "bearer",
          connectionKind: "direct",
          creatorName: "Local Developer",
          creatorUid: "developer-1",
          httpBaseUrl: "https://robot.example/api",
          namespace: "example-ns",
          platformId: "platform-7",
          robotId: "example-robot",
          secret: "local-memory-only-token",
          serverOrigin: "https://staging.turingfocus.cn",
          socketNamespaceUrl: "wss://robot.example/chat",
          socketPath: "/socket.io",
        },
      }),
    );
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    try {
      await act(async () => {
        root.render(
          createElement(RobotServerConnectionPanel, {
            loadDebugPrefill,
            onCancel: vi.fn(),
            onConnect: vi.fn(),
          }),
        );
        await Promise.resolve();
      });
      await vi.waitFor(() => {
        expect(
          container.querySelector<HTMLInputElement>(
            'input[aria-label="RobotServer 服务地址"]',
          )?.value,
        ).toBe("https://staging.turingfocus.cn");
      });

      const expectedValues: Readonly<Record<string, string>> = {
        "Admin Token": "",
        "HTTP 基础地址": "https://robot.example/api",
        Namespace: "example-ns",
        "Robot ID": "example-robot",
        "Socket Namespace 地址": "wss://robot.example/chat",
        "Socket Path": "/socket.io",
        platformId: "platform-7",
        "消息创建者 ID": "developer-1",
        消息创建者名称: "Local Developer",
        "用户 Token": "local-memory-only-token",
      };
      for (const [label, value] of Object.entries(expectedValues)) {
        const input = container.querySelector<HTMLInputElement>(
          `input[aria-label="${label}"]`,
        );
        if (label === "Admin Token") {
          expect(input).toBeNull();
        } else {
          expect(input?.value).toBe(value);
        }
      }
      expect(storage).not.toHaveBeenCalled();
      expect(loadDebugPrefill).toHaveBeenCalledOnce();
    } finally {
      await act(async () => root.unmount());
      storage.mockRestore();
      container.remove();
      if (previousActEnvironment === undefined) {
        Reflect.deleteProperty(globalThis, actEnvironmentKey);
      } else {
        Reflect.set(globalThis, actEnvironmentKey, previousActEnvironment);
      }
    }
  });

  it("does not let a late debug response overwrite manual input", async () => {
    const actEnvironmentKey = "IS_REACT_ACT_ENVIRONMENT";
    const previousActEnvironment = Reflect.get(globalThis, actEnvironmentKey);
    Reflect.set(globalThis, actEnvironmentKey, true);
    const pending = deferred<RobotServerDebugPrefillResult>();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    try {
      await act(async () => {
        root.render(
          createElement(RobotServerConnectionPanel, {
            loadDebugPrefill: () => pending.promise,
            onCancel: vi.fn(),
            onConnect: vi.fn(),
          }),
        );
        await Promise.resolve();
      });
      const serverOrigin = container.querySelector<HTMLInputElement>(
        'input[aria-label="RobotServer 服务地址"]',
      );
      await act(async () => {
        setInput(serverOrigin!, "https://manual.example");
      });
      await act(async () => {
        pending.resolve({
          ok: true,
          value: {
            namespace: "must-not-overwrite",
            serverOrigin: "https://debug.example",
          },
        });
        await pending.promise;
      });
      expect(serverOrigin?.value).toBe("https://manual.example");
      expect(
        container.querySelector<HTMLInputElement>(
          'input[aria-label="Namespace"]',
        )?.value,
      ).toBe("");
    } finally {
      await act(async () => root.unmount());
      container.remove();
      if (previousActEnvironment === undefined) {
        Reflect.deleteProperty(globalThis, actEnvironmentKey);
      } else {
        Reflect.set(globalThis, actEnvironmentKey, previousActEnvironment);
      }
    }
  });
});

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
        (button) => button.textContent === "RobotServer 模式",
      );
      await act(async () => robotMode!.click());
      await vi.waitFor(() => {
        expect(container.textContent).toContain("连接 RobotServer");
        expect(mockSessions[0]!.client.disposed).toBe(true);
        expect(mockSessions[0]!.dispose).toHaveBeenCalledOnce();
      });

      for (const label of [
        "RobotServer 服务地址",
        "Namespace",
        "Robot ID",
        "管理员密码",
        "消息创建者 ID",
        "消息创建者名称",
      ]) {
        expect(
          container.querySelector<HTMLInputElement>(
            `input[aria-label="${label}"]`,
          )?.value,
        ).toBe("");
      }

      const values: Record<string, string> = {
        "RobotServer 服务地址": "https://staging.turingfocus.cn",
        Namespace: "example-ns",
        "Robot ID": "example-robot",
        platformId: "platform-7",
        "用户 Token": "dom-memory-only-secret",
      };
      await act(async () => {
        container
          .querySelector<HTMLInputElement>('input[value="bearer"]')!
          .click();
        for (const [label, value] of Object.entries(values)) {
          const input = container.querySelector<HTMLInputElement>(
            `input[aria-label="${label}"]`,
          );
          expect(input).not.toBeNull();
          setInput(input!, value);
        }
      });
      const connect = [...container.querySelectorAll("button")].find(
        (button) => button.textContent === "连接 RobotServer",
      );
      await act(async () => {
        connect!.click();
        await Promise.resolve();
      });
      await vi.waitFor(() => {
        expect(configs).toHaveLength(1);
        expect(container.textContent).toContain("RobotServer 操作");
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
        (button) => button.textContent === "重新配置 RobotServer",
      );
      await act(async () => reconfigure!.click());
      await vi.waitFor(() => {
        expect(robotSessions[0]?.client.disposed).toBe(true);
        expect(robotSessions[0]?.dispose).toHaveBeenCalledOnce();
        expect(container.textContent).toContain("连接 RobotServer");
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
  }, 10_000);

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
        (button) => button.textContent === "RobotServer 模式",
      );
      await act(async () => robotMode!.click());
      await vi.waitFor(() =>
        expect(container.textContent).toContain("连接 RobotServer"),
      );

      const values: Record<string, string> = {
        "RobotServer 服务地址": "https://staging.turingfocus.cn",
        Namespace: "example-ns",
        "Robot ID": "example-robot",
        platformId: "platform-7",
        "用户 Token": secret,
      };
      await act(async () => {
        container
          .querySelector<HTMLInputElement>('input[value="bearer"]')!
          .click();
        for (const [label, value] of Object.entries(values)) {
          const input = container.querySelector<HTMLInputElement>(
            `input[aria-label="${label}"]`,
          );
          setInput(input!, value);
        }
      });
      const connect = [...container.querySelectorAll("button")].find(
        (button) => button.textContent === "连接 RobotServer",
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
          container.querySelector('textarea[aria-label="消息"]'),
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
        'textarea[aria-label="消息"]',
      );
      await act(async () => setTextArea(composer!, "Trigger safe failure"));
      const send = [...container.querySelectorAll("button")].find(
        (button) => button.textContent?.replace(/\s/gu, "") === "发送",
      );
      await act(async () => {
        send!.click();
        await Promise.resolve();
      });

      await vi.waitFor(() =>
        expect(container.textContent).toContain(
          "RobotServer 发生内部聊天错误。",
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
  }, 10_000);
});
