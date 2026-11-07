// @vitest-environment jsdom

import { setImmediate as nextTurn } from "node:timers/promises";

import { StrictMode, act, createElement } from "react";
import { createRoot } from "react-dom/client";
import {
  createTFRobotChatClientFactory,
  OwnedChatProvider,
} from "../packages/chat-kit/src/react.js";
import { createServer } from "node:http";
import { Server, type Socket } from "socket.io";
import { afterEach, expect, it } from "vitest";
import {
  createTFRobotChatClient,
  createTFRobotRemoteToolClient,
  createTFRobotSocketConnection,
  defineRemoteTool,
  type ChatClient,
  type SessionRequest,
  type TFRobotSession,
  type RemoteToolClient,
  type RemoteToolResult,
  type MaybePromise,
  type TFRobotSocket,
} from "../packages/chat-kit/src/headless.js";

const deadline = () => ({ deadlineAt: Date.now() + 5_000 });
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((r, j) => {
    resolve = r;
    reject = j;
  });
  return { promise, resolve, reject };
};
const bounded = async <T>(promise: Promise<T>, label: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Missing ${label}`)), 2_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};
const state = (client: RemoteToolClient, expected = "ready"): Promise<void> => {
  if (client.getSnapshot().status === expected) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      stop();
      reject(new Error(JSON.stringify(client.getSnapshot())));
    }, 5_000);
    const stop = client.subscribe(() => {
      if (client.getSnapshot().status === expected) {
        stop();
        clearTimeout(timer);
        resolve();
      }
    });
  });
};
const event = (socket: TFRobotSocket, name: string): Promise<unknown[]> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(name, listener);
      reject(new Error(`Missing ${name}`));
    }, 5_000);
    const listener = (...args: unknown[]) => {
      clearTimeout(timer);
      socket.off(name, listener);
      resolve(args);
    };
    socket.on(name, listener);
  });
const message = (id: string, conversationId = "1") => ({
  msgId: id,
  conversationId,
  content: id,
  additionalKwargs: {},
  attachments: null,
  createTimestamp: 1_800_000_000_000,
  creator: { uid: "agent", name: "Agent", avatar: null },
  role: "assistant",
  msgType: "text",
});
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups.length = 0;
});

async function fixture() {
  let deniedConversation: string | undefined;
  let requiredChatToken: string | undefined;
  let holdJoin = false;
  const heldJoin = deferred<(value: unknown) => void>();
  let denyChat = false;
  let toolMode: "normal" | "deny" | "hang" | "conflict" | "delay" = "normal";
  const delayedAuthentication = deferred<(error?: Error) => void>();
  const http = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://local");
    if (
      requiredChatToken &&
      url.pathname.includes("/conversations/") &&
      request.headers.authorization !== `Bearer ${requiredChatToken}`
    ) {
      response.writeHead(401).end();
      return;
    }
    if (
      deniedConversation &&
      url.pathname.includes(`/conversations/${deniedConversation}/`)
    ) {
      response.writeHead(403).end();
      return;
    }
    response.setHeader("Content-Type", "application/json");
    const data = url.pathname.endsWith("/status")
      ? { working: false, taskId: null }
      : url.pathname.endsWith("/messages")
        ? { messages: [], events: [], cursor: null }
        : {
            conversations: ["1", "2"].map((conversationId) => ({
              conversationId,
              title: conversationId,
              description: null,
              updateTimestamp: 1_800_000_000_000,
            })),
            cursor: null,
          };
    response.end(JSON.stringify({ code: 200, message: "Success", data }));
  });
  const server = new Server(http, { transports: ["websocket"] });
  const chats: Socket[] = [];
  const providers: Socket[] = [];
  let connections = 0;
  let registrations = 0;
  let revocations = 0;
  server.engine.on("connection", () => {
    ++connections;
  });
  server
    .of("/chat")
    .use((_socket, next) =>
      next(denyChat ? new Error("not authorized") : undefined),
    );
  server.of("/chat").on("connection", (socket) => {
    chats.push(socket);
    socket.on("join_conversation", (_payload, ack) => {
      if (holdJoin) {
        holdJoin = false;
        heldJoin.resolve(ack);
      } else ack({ accepted: true, recoveryComplete: true });
    });
    socket.on("ping_business", (ack) => ack("chat-alive"));
  });
  server.of("/remote-tool").use((_socket, next) => {
    if (toolMode === "hang") return;
    if (toolMode === "delay") {
      delayedAuthentication.resolve(next);
      return;
    }
    next(toolMode === "deny" ? new Error("not authorized") : undefined);
  });
  server.of("/remote-tool").on("connection", (socket) => {
    providers.push(socket);
    socket.on("register", (_payload, ack) => {
      ++registrations;
      if (toolMode === "conflict")
        ack({
          providerId: socket.id,
          error:
            "Remote tool name conflicts with existing provider tool: host_tool",
        });
      else
        ack({
          providerId: socket.id,
          registeredToolNames: ["host_tool"],
          error: null,
        });
    });
    socket.on("revoke", () => {
      ++revocations;
    });
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("Missing port");
  const origin = `http://127.0.0.1:${address.port}`;
  cleanups.push(
    () => new Promise<void>((resolve) => server.close(() => resolve())),
  );
  const connection = createTFRobotSocketConnection({ serverUrl: origin });
  cleanups.push(() => connection.dispose());
  const makeChat = (
    getSession?: (request: SessionRequest) => MaybePromise<TFRobotSession>,
    currentServer = false,
  ) => {
    const client = createTFRobotChatClient({
      baseUrl: origin,
      cache: false,
      ...(currentServer
        ? { serverProfile: { kind: "current-server" as const } }
        : {}),
      socketFactory: connection.socketFactory,
      sessionProvider: {
        getSession:
          getSession ?? (() => ({ kind: "bearer", token: "chat-token" })),
      },
      messageCreatorProvider: () => ({ uid: "user", name: "User" }),
    });
    cleanups.push(async () => {
      await client.dispose(deadline());
    });
    return client;
  };
  const makeTools = (
    execute: () => MaybePromise<RemoteToolResult> = () => ({
      ok: true,
      resultForLlm: "host-result",
    }),
  ) => {
    const client = createTFRobotRemoteToolClient({
      baseUrl: origin,
      socketFactory: connection.socketFactory,
      connectionTimeoutMs: 200,
      sessionProvider: {
        getSession: () => ({ kind: "bearer", token: "tool-token" }),
      },
      tools: [
        defineRemoteTool({
          definition: {
            toolName: "host_tool",
            description: "Host tool",
            parameters: { type: "object" },
            tags: ["Read"],
          },
          validate: () => undefined,
          execute,
        }),
      ],
    });
    cleanups.push(() => client.dispose());
    return client;
  };
  const invoke = (id = "request") =>
    providers
      .at(-1)!
      .timeout(3_000)
      .emitWithAck("remote_tool_invoke", {
        providerId: providers.at(-1)!.id,
        requestId: id,
        toolName: "host_tool",
        params: {},
      });
  return {
    origin,
    delayedAuthentication,
    connection,
    server,
    chats,
    providers,
    makeChat,
    makeTools,
    invoke,
    get connections() {
      return connections;
    },
    get registrations() {
      return registrations;
    },
    get revocations() {
      return revocations;
    },
    holdNextJoin() {
      holdJoin = true;
      return heldJoin.promise;
    },
    requireChatToken(token: string) {
      requiredChatToken = token;
    },
    denyConversation(id: string) {
      deniedConversation = id;
    },
    denyChat() {
      denyChat = true;
    },
    toolMode(mode: typeof toolMode) {
      toolMode = mode;
    },
  };
}

it.each(["chat-first", "tools-first"])(
  "shares one Engine.IO connection and preserves either survivor (%s)",
  async (order) => {
    const f = await fixture();
    const chat = f.makeChat();
    let tools = f.makeTools();
    if (order === "tools-first") {
      tools.start();
      await state(tools);
    }
    expect(
      (await chat.loadConversation({ ...deadline(), conversationId: "1" })).ok,
    ).toBe(true);
    if (order === "chat-first") {
      tools.start();
      await state(tools);
    }
    expect(f.connections).toBe(1);
    expect(f.chats[0]!.conn).toBe(f.providers[0]!.conn);
    expect(f.chats[0]!.handshake.auth["token"]).toBe("chat-token");
    expect(f.providers[0]!.handshake.auth["token"]).toBe("tool-token");
    expect(await f.invoke()).toMatchObject({
      success: true,
      resultForLlm: "host-result",
    });
    for (const id of ["2", "1"])
      expect(
        (await chat.loadConversation({ ...deadline(), conversationId: id })).ok,
      ).toBe(true);
    f.denyConversation("2");
    expect(
      (await chat.loadConversation({ ...deadline(), conversationId: "2" })).ok,
    ).toBe(false);
    expect(await f.invoke("after-switch")).toMatchObject({ success: true });
    const toolLeft = new Promise<void>((resolve) =>
      f.providers[0]!.once("disconnect", () => resolve()),
    );
    tools.dispose();
    await bounded(toolLeft, "tool namespace disconnect");
    expect(f.providers[0]!.connected).toBe(false);
    expect(f.server.engine.clientsCount).toBe(1);
    const seen = deferred<void>();
    const stop = chat.subscribe(() => {
      if (
        chat.getSnapshot()?.timeline.some((item) => item.id === "after-tools")
      )
        seen.resolve();
    });
    f.chats[0]!.emit("chat_message", message("after-tools"));
    await bounded(seen.promise, "chat message after tools dispose");
    stop.dispose();
    tools = f.makeTools();
    tools.start();
    await state(tools);
    expect(f.connections).toBe(1);
    expect(await f.invoke("new-provider")).toMatchObject({ success: true });
    await chat.dispose(deadline());
    expect(await f.invoke("chat-disposed")).toMatchObject({ success: true });
    const closed = new Promise<void>((resolve) =>
      f.providers.at(-1)!.conn.once("close", () => resolve()),
    );
    tools.dispose();
    await bounded(closed, "Engine.IO close");
    expect(f.server.engine.clientsCount).toBe(0);
    const replacement = f.makeTools();
    replacement.start();
    await state(replacement);
    expect(await f.invoke("new-engine")).toMatchObject({ success: true });
    expect(f.connections).toBe(2);
  },
);

it.each(["deny", "conflict", "hang"] as const)(
  "isolates RemoteTool %s from chat",
  async (mode) => {
    const f = await fixture();
    const chat = f.makeChat();
    expect(
      (await chat.loadConversation({ ...deadline(), conversationId: "1" })).ok,
    ).toBe(true);
    f.toolMode(mode);
    const tools = f.makeTools();
    tools.start();
    await state(tools, "error");
    expect(tools.getSnapshot().error).toBe(
      mode === "deny"
        ? "authentication"
        : mode === "conflict"
          ? "name-conflict"
          : "timeout",
    );
    expect(f.chats[0]!.connected).toBe(true);
    expect(
      (await chat.loadConversation({ ...deadline(), conversationId: "2" })).ok,
    ).toBe(true);
    f.toolMode("normal");
    tools.retry();
    if (mode === "hang") {
      // A CONNECT the Server never answers cannot be cancelled at namespace
      // level. Preserve chat while the explicit retry reaches its own deadline.
      await state(tools, "error");
      expect(f.chats[0]!.connected).toBe(true);
      return;
    }
    await state(tools);
    expect(await f.invoke()).toMatchObject({ success: true });
    expect(f.connections).toBe(1);
  },
);

it("isolates a rejected chat namespace from a working provider", async () => {
  const f = await fixture();
  const tools = f.makeTools();
  tools.start();
  await state(tools);
  f.denyChat();
  const chat = f.makeChat();
  expect(
    (await chat.loadConversation({ ...deadline(), conversationId: "1" })).ok,
  ).toBe(false);
  expect(await f.invoke()).toMatchObject({ success: true });
  expect(f.connections).toBe(1);
});

it("recovers both namespaces after a physical failure, without reviving released tools", async () => {
  const f = await fixture();
  const chat = f.makeChat();
  const tools = f.makeTools();
  await chat.loadConversation({ ...deadline(), conversationId: "1" });
  tools.start();
  await state(tools);
  const disconnected = state(tools, "disconnected");
  f.chats[0]!.conn.close();
  await disconnected;
  await state(tools);
  expect(f.connections).toBe(2);
  expect(f.registrations).toBe(2);
  expect(f.chats.at(-1)!.conn).toBe(f.providers.at(-1)!.conn);
  expect(await f.invoke()).toMatchObject({ success: true });
  const toolLeft = new Promise<void>((resolve) =>
    f.providers.at(-1)!.once("disconnect", () => resolve()),
  );
  tools.dispose();
  await bounded(toolLeft, "tool namespace disconnect");
  const restored = deferred<void>();
  f.server.of("/chat").once("connection", (socket) => {
    socket.once("join_conversation", () => restored.resolve());
  });
  f.chats.at(-1)!.conn.close();
  await restored.promise;
  expect(f.registrations).toBe(2);
  expect(tools.getSnapshot().status).toBe("disposed");
});

it("keeps contexts separate and rejects endpoint mismatches and concurrent namespace owners", async () => {
  const f = await fixture();
  const other = createTFRobotSocketConnection({ serverUrl: f.origin });
  cleanups.push(() => other.dispose());
  const input = {
    namespaceUrl: `${f.origin}/chat`,
    path: "/socket.io",
    getAuth: async () => ({ token: "raw" }),
  };
  const a = f.connection.socketFactory(input);
  const b = other.socketFactory(input);
  const connected = [event(a, "connect"), event(b, "connect")];
  a.connect();
  b.connect();
  await Promise.all(connected);
  expect(f.connections).toBe(2);
  expect(f.chats[0]!.conn).not.toBe(f.chats[1]!.conn);
  expect(() => f.connection.socketFactory(input)).toThrow(
    "already has an owner",
  );
  expect(() =>
    f.connection.socketFactory({ ...input, path: "/another/socket.io" }),
  ).toThrow("does not match");
  expect(() =>
    f.connection.socketFactory({
      ...input,
      namespaceUrl: "https://other.example/chat",
    }),
  ).toThrow("does not match");
  a.disconnect();
  const successor = f.connection.socketFactory(input);
  const done = event(successor, "connect");
  successor.connect();
  await done;
  a.disconnect();
  expect(successor.connected).toBe(true);
  expect(() => a.connect()).toThrow();
});

it("invalidates delayed authentication on overall disposal and on namespace replacement", async () => {
  const f = await fixture();
  const auth = deferred<{ token: string }>();
  const requested = deferred<void>();
  const old = f.connection.socketFactory({
    namespaceUrl: `${f.origin}/chat`,
    path: "/socket.io",
    getAuth: () => {
      requested.resolve();
      return auth.promise;
    },
  });
  old.connect();
  await requested.promise;
  old.disconnect();
  const current = f.connection.socketFactory({
    namespaceUrl: `${f.origin}/chat`,
    path: "/socket.io",
    getAuth: async () => ({ token: "new-token" }),
  });
  const connected = event(current, "connect");
  current.connect();
  auth.resolve({ token: "old-token" });
  await connected;
  expect(f.chats).toHaveLength(1);
  expect(f.chats[0]!.handshake.auth["token"]).toBe("new-token");
  const closed = new Promise<void>((resolve) =>
    f.chats[0]!.conn.once("close", () => resolve()),
  );
  f.connection.dispose();
  f.connection.dispose();
  await bounded(closed, "Engine.IO close");
  expect(() => current.connect()).toThrow("disposed");
  expect(() =>
    f.connection.socketFactory({
      namespaceUrl: `${f.origin}/chat`,
      path: "/socket.io",
      getAuth: async () => ({}),
    }),
  ).toThrow("disposed");
});

it("ends pending host work and handshakes when the shared context is disposed", async () => {
  const f = await fixture();
  const pending = deferred<{ ok: true; resultForLlm: string }>();
  const started = deferred<void>();
  const tools = f.makeTools(() => {
    started.resolve();
    return pending.promise;
  });
  tools.start();
  await state(tools);
  const response = f.invoke().catch(() => undefined);
  await started.promise;
  f.connection.dispose();
  expect(tools.getSnapshot().activeCalls).toBe(0);
  expect(tools.getSnapshot().status).toBe("error");
  pending.resolve({ ok: true, resultForLlm: "late" });
  await response;
});

it("preserves tools through real React StrictMode replay, replacement and unmount", async () => {
  const f = await fixture();
  const tools = f.makeTools();
  tools.start();
  await state(tools);
  const clients: ChatClient[] = [];
  const disposeErrors: unknown[] = [];
  const base = createTFRobotChatClientFactory({
    baseUrl: f.origin,
    socketFactory: f.connection.socketFactory,
    sessionProvider: {
      getSession: () => ({ kind: "bearer", token: "strict-chat" }),
    },
    messageCreatorProvider: () => ({ uid: "user", name: "User" }),
    getDisposeOptions: deadline,
  });
  const factory = {
    ...base,
    create: () => {
      const client = base.create();
      clients.push(client);
      return client;
    },
  };
  const root = createRoot(document.createElement("div"));
  const previous = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  try {
    for (const key of ["first", "replacement"]) {
      // Node Socket.IO defers DISCONNECT handling. Observe namespace release
      // before re-entering it; the Python Server probe covers immediate reuse.
      const retiring = f.chats.at(-1);
      const released = retiring?.connected
        ? new Promise<void>((resolve) =>
            retiring.once("disconnect", () => resolve()),
          )
        : Promise.resolve();
      await act(async () => {
        root.render(
          createElement(
            StrictMode,
            null,
            createElement(OwnedChatProvider, {
              key,
              factory,
              onDisposeError: (error: unknown) => {
                disposeErrors.push(error);
              },
            }),
          ),
        );
      });
      await bounded(released, "Node chat namespace release");
      const current = clients.at(-1)!;
      expect(
        (await current.loadConversation({ ...deadline(), conversationId: "1" }))
          .ok,
      ).toBe(true);
      expect(await f.invoke(key)).toMatchObject({ success: true });
      expect(clients.slice(0, -1).every((client) => client.disposed)).toBe(
        true,
      );
    }
    expect(clients).toHaveLength(4);
    expect(f.connections).toBe(1);
  } finally {
    await act(async () => root.unmount());
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previous);
  }
  expect(clients.every((client) => client.disposed)).toBe(true);
  expect(disposeErrors).toEqual([]);
  expect(await f.invoke("after-unmount")).toMatchObject({ success: true });
});

it("reuses the chat namespace during a pending reconnect and candidate handoff", async () => {
  const f = await fixture();
  const requested = deferred<void>();
  const auth = deferred<TFRobotSession>();
  let hold = true;
  const chat = f.makeChat((request) => {
    if (request.purpose === "reconnect" && hold) {
      requested.resolve();
      return auth.promise;
    }
    return { kind: "bearer", token: "chat-token" };
  });
  const tools = f.makeTools();
  tools.start();
  await state(tools);
  await chat.loadConversation({ ...deadline(), conversationId: "1" });
  f.chats[0]!.conn.close();
  await requested.promise;
  const switching = chat.loadConversation({
    ...deadline(),
    conversationId: "2",
  });
  hold = false;
  auth.resolve({ kind: "bearer", token: "chat-token" });
  expect((await switching).ok).toBe(true);
  await state(tools);
  expect(f.connections).toBe(2);
  expect(f.chats.at(-1)!.conn).toBe(f.providers.at(-1)!.conn);
  expect(await f.invoke()).toMatchObject({ success: true });
});

it("discards authentication resolved after overall disposal", async () => {
  const f = await fixture();
  const tools = f.makeTools();
  tools.start();
  await state(tools);
  const requested = deferred<void>();
  const auth = deferred<{ token: string }>();
  const socket = f.connection.socketFactory({
    namespaceUrl: `${f.origin}/chat`,
    path: "/socket.io",
    getAuth: () => {
      requested.resolve();
      return auth.promise;
    },
  });
  socket.connect();
  await requested.promise;
  const closed = new Promise<void>((resolve) =>
    f.providers[0]!.conn.once("close", () => resolve()),
  );
  f.connection.dispose();
  auth.resolve({ token: "late" });
  await bounded(closed, "disposed transport close");
  expect(f.chats).toHaveLength(0);
  expect(f.connections).toBe(1);
  expect(socket.connected).toBe(false);
  expect(socket.active).toBe(false);
});

it("makes an active chat read-only when the overall context ends", async () => {
  const f = await fixture();
  const chat = f.makeChat();
  const tools = f.makeTools();
  await chat.loadConversation({ ...deadline(), conversationId: "1" });
  tools.start();
  await state(tools);
  expect(chat.getSnapshot()?.capabilities.sendText).toBe(true);
  f.connection.dispose();
  expect(chat.getSnapshot()?.lifecycle?.status).toBe("offline");
  expect(
    (
      await chat.sendText({
        ...deadline(),
        conversationId: "1",
        text: "must not send",
      })
    ).ok,
  ).toBe(false);
  expect(tools.getSnapshot().status).toBe("error");
});

it.each(["timeout", "dispose"])(
  "keeps chat connected when retired tool authentication succeeds late (%s)",
  async (retirement) => {
    const f = await fixture();
    const chat = f.makeChat();
    await chat.loadConversation({ ...deadline(), conversationId: "1" });
    f.toolMode("delay");
    const tools = f.makeTools();
    tools.start();
    const accept = await f.delayedAuthentication.promise;
    if (retirement === "timeout") await state(tools, "error");
    else tools.dispose();
    const retired = deferred<void>();
    const accepted = new Promise<void>((resolve) =>
      f.server.of("/remote-tool").once("connection", (socket) => {
        socket.once("disconnect", () => retired.resolve());
        resolve();
      }),
    );
    accept();
    await accepted;
    // Node Socket.IO defers its namespace deletion to nextTick. Observe its
    // real disconnect event; immediate retry interoperability is separately
    // verified against the supported Python Socket.IO implementation.
    await bounded(retired.promise, "late namespace cleanup");
    f.toolMode("normal");
    const next = retirement === "timeout" ? tools : f.makeTools();
    if (retirement === "timeout") next.retry();
    else next.start();
    await state(next);
    expect(f.chats[0]!.connected).toBe(true);
    expect(f.connections).toBe(1);
    expect(await f.invoke()).toMatchObject({ success: true });
  },
);

it.each(["resolve", "reject"])(
  "ignores old chat authentication after two physical reconnects (%s)",
  async (outcome) => {
    const f = await fixture();
    const oldRequested = deferred<void>();
    const oldAuth = deferred<TFRobotSession>();
    let reconnects = 0;
    let currentToken = "chat-token";
    const chat = f.makeChat((request) => {
      if (request.purpose === "reconnect") {
        reconnects += 1;
        if (reconnects === 1) {
          oldRequested.resolve();
          return oldAuth.promise;
        }
        currentToken = "fresh-chat-session";
        return { kind: "bearer", token: currentToken };
      }
      return { kind: "bearer", token: currentToken };
    });
    await chat.loadConversation({ ...deadline(), conversationId: "1" });
    const tools = f.makeTools();
    tools.start();
    await state(tools);
    let lost = state(tools, "disconnected");
    f.chats[0]!.conn.close();
    await lost;
    await oldRequested.promise;
    await state(tools);
    const restored = deferred<void>();
    const subscription = chat.subscribe(() => {
      if (
        f.chats.length === 2 &&
        chat.getSnapshot()?.lifecycle?.status === "active"
      )
        restored.resolve();
    });
    lost = state(tools, "disconnected");
    f.providers.at(-1)!.conn.close();
    await lost;
    await state(tools);
    await bounded(restored.promise, "third engine chat recovery");
    subscription.dispose();
    if (outcome === "resolve")
      oldAuth.resolve({ kind: "bearer", token: "stale-chat-session" });
    else oldAuth.reject(new Error("Old authentication failed"));
    // Drain promise continuations before asking the real peer to execute work.
    await nextTurn();
    expect(await f.invoke("after-old-auth")).toMatchObject({ success: true });
    expect(f.chats).toHaveLength(2);
    expect(f.chats.at(-1)!.connected).toBe(true);
    expect(f.chats.at(-1)!.handshake.auth["token"]).toBe("fresh-chat-session");
    expect(f.connections).toBe(3);
    expect(
      (await chat.loadConversation({ ...deadline(), conversationId: "2" })).ok,
    ).toBe(true);
    expect(f.connections).toBe(3);
    expect(f.chats).toHaveLength(2);
  },
  10_000,
);

it("keeps the newest current-server session for REST rebase while join ACK is delayed", async () => {
  const f = await fixture();
  const requested = deferred<void>();
  const old = deferred<TFRobotSession>();
  let reconnects = 0;
  const chat = f.makeChat((request) => {
    if (request.purpose === "reconnect") {
      reconnects += 1;
      if (reconnects === 1) {
        requested.resolve();
        return old.promise;
      }
      return { kind: "bearer", token: "fresh-chat-session" };
    }
    return { kind: "bearer", token: "chat-token" };
  }, true);
  expect(
    (await chat.loadConversation({ ...deadline(), conversationId: "1" })).ok,
  ).toBe(true);
  const tools = f.makeTools();
  tools.start();
  await state(tools);
  let lost = state(tools, "disconnected");
  f.chats[0]!.conn.close();
  await lost;
  await requested.promise;
  await state(tools);
  const join = f.holdNextJoin();
  lost = state(tools, "disconnected");
  f.providers.at(-1)!.conn.close();
  await lost;
  await state(tools);
  const acknowledge = await bounded(join, "held current-server join");
  const recovered = deferred<void>();
  const subscription = chat.subscribe(() => {
    if (chat.getSnapshot()?.lifecycle?.status === "degraded")
      recovered.resolve();
  });
  old.resolve({ kind: "bearer", token: "stale-chat-session" });
  await nextTurn();
  f.requireChatToken("fresh-chat-session");
  acknowledge({ accepted: true, recoveryComplete: false });
  await bounded(recovered.promise, "fresh-session REST recovery");
  subscription.dispose();
  expect(chat.getSnapshot()?.lifecycle?.status).toBe("degraded");
  expect(f.connections).toBe(3);
  expect(await f.invoke()).toMatchObject({ success: true });
}, 10_000);
