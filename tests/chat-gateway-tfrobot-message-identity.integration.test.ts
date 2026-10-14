import { createServer, type ServerResponse } from "node:http";

import { Server as SocketIoServer, type Socket } from "socket.io";
import { expect, it, vi } from "vitest";

import { createTFRobotChatGateway } from "../packages/chat-gateway-tfrobot/src/index.js";
import {
  createChatClient,
  type ConversationCacheStorage,
} from "../packages/chat-runtime/src/index.js";

it.each([false, true])(
  "restores durable facts across Gateway instances without duplicate bubbles or cursor chasing (sibling=%s)",
  async (sibling) => {
    const dto = {
      msgId: null,
      content: "Cross-instance persisted fact",
      conversationId: 42,
      createTimestamp: 1_791_538_963_309,
      creator: { uid: "user-1", name: "User" },
      role: "user",
      msgType: "text",
      additionalKwargs: {},
      attachments: null,
    };
    let persisted = false;
    let authorName = "User";
    let cursorReads = 0;
    let encoded: string | null = null;
    const storage: ConversationCacheStorage = {
      read: async () => encoded,
      update: async (_scope, transform) => {
        encoded = transform(encoded);
      },
    };
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://localhost");
      let data: unknown;
      if (url.pathname.endsWith("/messages")) {
        const cursor = url.searchParams.get("cursor");
        if (cursor !== null) cursorReads++;
        data = {
          messages:
            persisted && cursor === null
              ? [
                  {
                    ...dto,
                    msgId: 366,
                    creator: { uid: "user-1", name: authorName },
                  },
                  ...(sibling
                    ? [
                        {
                          ...dto,
                          msgId: 367,
                          createTimestamp: dto.createTimestamp + 1,
                        },
                      ]
                    : []),
                ]
              : [],
          events: [],
          cursor: persisted && cursor === null ? "older" : null,
        };
      } else if (url.pathname.endsWith("/status")) {
        data = { working: false, taskId: null };
      } else {
        data = {
          conversations: [{ conversationId: 42, title: "Cache regression" }],
          cursor: null,
        };
      }
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ code: 200, message: "Success", data }));
    });
    const sockets: Socket[] = [];
    const socketServer = new SocketIoServer(server, {
      transports: ["websocket"],
    });
    socketServer.of("/chat").on("connection", (socket) => {
      sockets.push(socket);
      socket.on("join_conversation", (_payload, acknowledge) => acknowledge());
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new Error("Missing TCP port");
    const origin = `http://127.0.0.1:${address.port}`;
    const makeClient = () =>
      createChatClient({
        cache: { storage },
        gateway: createTFRobotChatGateway({
          baseUrl: origin,
          socketNamespaceUrl: `${origin}/chat`,
          serverProfile: { kind: "current-server" },
          messageCreatorProvider: () => dto.creator,
          sessionProvider: {
            getSession: () => ({ kind: "bearer", token: "fixture-session" }),
          },
        }),
      });
    const first = makeClient();
    let second: ReturnType<typeof makeClient> | undefined;
    const options = () => ({ deadlineAt: Date.now() + 5_000 });
    try {
      expect(
        (await first.loadConversation({ ...options(), conversationId: "42" }))
          .ok,
      ).toBe(true);
      sockets[0]!.emit("chat_message", dto);
      await vi.waitFor(() =>
        expect(first.getSnapshot()?.timeline).toHaveLength(1),
      );
      persisted = true;
      expect(
        (await first.loadConversation({ ...options(), conversationId: "42" }))
          .ok,
      ).toBe(true);
      await first.flushCache(options());
      const originalId = first.getSnapshot()?.timeline[0]?.id;
      expect(originalId).not.toBe("366");
      await first.dispose(options());
      authorName = "Fresh historical author";
      second = makeClient();
      expect(
        (await second.loadConversation({ ...options(), conversationId: "42" }))
          .ok,
      ).toBe(true);
      expect(second.getSnapshot()?.timeline).toHaveLength(sibling ? 2 : 1);
      expect(second.getSnapshot()?.timeline[0]).toMatchObject({
        author: { displayName: authorName },
        provenance: { kind: "persisted", id: "366", source: "history" },
      });
      expect(cursorReads).toBe(0);
    } finally {
      await first.dispose(options());
      await second?.dispose(options());
      await new Promise<void>((resolve) => socketServer.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);

it.each([
  { enriched: false, changedAuthor: false },
  { enriched: true, changedAuthor: false },
  { enriched: false, changedAuthor: true },
  { enriched: true, changedAuthor: true },
])(
  "reconciles a provisional user through HTTP/Socket handoff and late echo: %j",
  async ({ enriched, changedAuthor }) => {
    const message = {
      msgId: null,
      content: "Dedicated message identity regression",
      conversationId: 42,
      createTimestamp: 1_791_538_963_309,
      creator: { uid: "user-1", name: "User" },
      role: "user",
      msgType: "text",
      additionalKwargs: {},
      attachments: null,
    };
    let persisted = false;
    let historyAuthorName = changedAuthor ? "History User" : "User";
    let echoBarrierContent = "After echo";
    let secondPersistedMessage = false;
    let afterEcho = false;
    let heldHistory: ServerResponse | undefined;
    let holdNextHistory = false;
    let holdLatestOnly = false;
    const sockets: Socket[] = [];
    const reply = (response: ServerResponse, data: unknown): void => {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ code: 200, message: "Success", data }));
    };
    const history = (): unknown => ({
      messages: persisted
        ? [
            {
              ...message,
              msgId: 366,
              creator: {
                uid: "user-1",
                name: historyAuthorName,
                ...(changedAuthor
                  ? { avatar: "https://example.invalid/history-avatar" }
                  : {}),
              },
              ...(enriched
                ? {
                    additionalKwargs: {
                      chain_result: "fixture result",
                      __tf_parent_uuid: "fixture-parent",
                      __tf_element_uuid: "fixture-element",
                    },
                  }
                : {}),
            },
            ...(secondPersistedMessage ? [{ ...message, msgId: 367 }] : []),
            ...(afterEcho
              ? [
                  {
                    ...message,
                    msgId: 400,
                    content: echoBarrierContent,
                    createTimestamp: message.createTimestamp + 1,
                  },
                ]
              : []),
          ]
        : [],
      events: [],
      cursor: persisted ? "nonempty-oldest-cursor" : null,
    });
    const server = createServer((request, response) => {
      const path = new URL(request.url ?? "/", "http://localhost").pathname;
      if (path.endsWith("/messages")) {
        if (
          holdNextHistory &&
          (!holdLatestOnly ||
            new URL(request.url ?? "/", "http://localhost").searchParams.get(
              "count",
            ) === "-7")
        ) {
          holdNextHistory = false;
          heldHistory = response;
        } else reply(response, history());
      } else if (path.endsWith("/status")) {
        reply(response, { working: false, taskId: null });
      } else
        reply(response, {
          conversations: [{ conversationId: 42, title: "Regression" }],
          cursor: null,
        });
    });
    const socketServer = new SocketIoServer(server, {
      transports: ["websocket"],
    });
    socketServer.of("/chat").on("connection", (socket) => {
      sockets.push(socket);
      socket.on("join_conversation", (_payload, acknowledge) => acknowledge());
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new Error("Missing TCP port");
    const origin = `http://127.0.0.1:${address.port}`;
    const client = createChatClient({
      ...(enriched && changedAuthor ? { cache: false as const } : {}),
      gateway: createTFRobotChatGateway({
        baseUrl: origin,
        socketNamespaceUrl: `${origin}/chat`,
        serverProfile: { kind: "current-server" },
        messageCreatorProvider: () => ({ uid: "user-1", name: "User" }),
        sessionProvider: {
          getSession: () => ({ kind: "bearer", token: "fixture-session" }),
        },
      }),
    });
    const load = () =>
      client.loadConversation({
        conversationId: "42",
        deadlineAt: Date.now() + 5_000,
      });
    try {
      expect((await load()).ok).toBe(true);
      expect(client.getSnapshot()?.timeline).toHaveLength(0);
      holdNextHistory = true;
      const pending = load();
      await vi.waitFor(() => expect(heldHistory).toBeDefined());
      sockets[0]!.emit("chat_message", message);
      await vi.waitFor(() =>
        expect(client.getSnapshot()?.timeline).toHaveLength(1),
      );
      persisted = true;
      reply(heldHistory!, history());
      expect((await pending).ok).toBe(true);
      expect(client.getSnapshot()?.timeline).toHaveLength(1);
      const confirmed = client.getSnapshot()?.timeline[0];
      expect(
        confirmed?.kind === "message"
          ? confirmed.author?.displayName
          : undefined,
      ).toBe(changedAuthor ? "History User" : "User");
      sockets[0]!.emit("chat_message", message);
      afterEcho = true;
      sockets[0]!.emit("chat_message", {
        ...message,
        msgId: 400,
        content: echoBarrierContent,
        createTimestamp: message.createTimestamp + 1,
      });
      await vi.waitFor(() =>
        expect(client.getSnapshot()?.timeline).toHaveLength(2),
      );
      await vi.waitFor(() => {
        expect(client.getSnapshot()?.timeline).toHaveLength(2);
        const item = client.getSnapshot()?.timeline[0];
        expect(
          item?.kind === "message" ? item.author?.displayName : undefined,
        ).toBe(changedAuthor ? "History User" : "User");
      });
      expect((await load()).ok).toBe(true);
      expect(client.getSnapshot()?.timeline).toHaveLength(2);
      if (enriched && changedAuthor) {
        heldHistory = undefined;
        holdNextHistory = true;
        holdLatestOnly = true;
        const staleHistory = history();
        const olderReload = client.loadConversation({
          conversationId: "42",
          limit: 7,
          deadlineAt: Date.now() + 5_000,
        });
        await vi.waitFor(() => expect(heldHistory).toBeDefined());
        let newerSeen = false;
        let authorRolledBack = false;
        const observed = client.subscribe((snapshot) => {
          const item = snapshot.timeline[0];
          if (item?.kind !== "message") return;
          if (item.author?.displayName === "Newer history user")
            newerSeen = true;
          else if (newerSeen) authorRolledBack = true;
        });
        historyAuthorName = "Newer history user";
        expect(
          (
            await client.loadConversation({
              conversationId: "42",
              previousCursor: "nonempty-oldest-cursor",
              deadlineAt: Date.now() + 5_000,
            })
          ).ok,
        ).toBe(true);
        const author = () => {
          const item = client.getSnapshot()?.timeline[0];
          return item?.kind === "message"
            ? item.author?.displayName
            : undefined;
        };
        expect(author()).toBe("Newer history user");
        reply(heldHistory!, staleHistory);
        expect((await olderReload).ok).toBe(true);
        expect(author()).toBe("Newer history user");
        sockets[0]!.emit("chat_message", message);
        echoBarrierContent = "After stale echo";
        sockets[0]!.emit("chat_message", {
          ...message,
          msgId: 400,
          content: echoBarrierContent,
          createTimestamp: message.createTimestamp + 1,
        });
        await vi.waitFor(() =>
          expect(client.getSnapshot()?.timeline[1]).toMatchObject({
            content: { text: echoBarrierContent },
          }),
        );
        expect(author()).toBe("Newer history user");
        observed.dispose();
        expect(authorRolledBack).toBe(false);
      }
      secondPersistedMessage = true;
      expect((await load()).ok).toBe(true);
      expect(client.getSnapshot()?.timeline).toHaveLength(3);
    } finally {
      heldHistory?.end();
      await client.dispose({ deadlineAt: Date.now() + 5_000 });
      await new Promise<void>((resolve) => socketServer.close(() => resolve()));
      if (server.listening)
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);

it("keeps a newer HTTP author after paging beyond the provisional signature window", async () => {
  let held: ServerResponse | undefined;
  const dto = {
    msgId: 366,
    conversationId: 42,
    role: "user",
    msgType: "text",
    content: "Retained author",
    createTimestamp: 1791538963309,
    creator: { uid: "user-1", name: "New" },
    additionalKwargs: {},
    attachments: null,
  };
  const reply = (response: ServerResponse, data: unknown) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ code: 200, message: "Success", data }));
  };
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname.endsWith("/messages")) {
      const cursor = url.searchParams.get("cursor");
      if (cursor === "hold") {
        held = response;
        return;
      }
      const page = Number(cursor ?? 0);
      const extras = Array.from(
        { length: page === 0 ? 99 : 100 },
        (_, index) => ({
          ...dto,
          msgId: 1000 + page * 100 + index,
          content: `Other fact ${page}:${index}`,
          createTimestamp: dto.createTimestamp - (page * 100 + index + 1),
        }),
      );
      reply(response, {
        messages: page === 0 ? [dto, ...extras] : extras,
        events: [],
        cursor: String(page + 1),
      });
    } else if (url.pathname.endsWith("/status"))
      reply(response, { working: false, taskId: null });
    else
      reply(response, {
        conversations: [{ conversationId: 42, title: "Regression" }],
        cursor: null,
      });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("Missing TCP port");
  const gateway = createTFRobotChatGateway({
    baseUrl: `http://127.0.0.1:${address.port}`,
    serverProfile: { kind: "current-server" },
    messageCreatorProvider: () => ({ uid: "user-1", name: "User" }),
    sessionProvider: {
      getSession: () => ({ kind: "bearer", token: "fixture-session" }),
    },
  });
  try {
    expect(
      (await gateway.listConversations({ deadlineAt: Date.now() + 5000 })).ok,
    ).toBe(true);
    const stale = gateway.loadConversation({
      conversationId: "42",
      previousCursor: "hold",
      limit: 100,
      deadlineAt: Date.now() + 5000,
    });
    await vi.waitFor(() => expect(held).toBeDefined());
    for (let page = 0; page < 3; page += 1) {
      const result = await gateway.loadConversation({
        conversationId: "42",
        previousCursor: String(page),
        limit: 100,
        deadlineAt: Date.now() + 5000,
      });
      expect(result.ok).toBe(true);
    }
    reply(held!, {
      messages: [{ ...dto, creator: { uid: "user-1", name: "Old" } }],
      events: [],
      cursor: "older",
    });
    const result = await stale;
    expect(result.ok).toBe(true);
    if (result.ok)
      expect(result.value.timeline).toMatchObject([
        { author: { displayName: "New" } },
      ]);
  } finally {
    held?.end();
    await gateway.dispose({ deadlineAt: Date.now() + 5000 });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it("refreshes checkpoint authors on real Socket reconnect without replacing newer realtime content", async () => {
  let held: ServerResponse | undefined;
  let hold = false;
  let name = "Old";
  const user = {
    msgId: 366,
    conversationId: 42,
    role: "user",
    msgType: "text",
    content: "User input",
    createTimestamp: 1791538963309,
    additionalKwargs: {},
    attachments: null,
    creator: { uid: "user-1", name: "Old", avatar: null },
  };
  const assistant = {
    ...user,
    msgId: 367,
    role: "assistant",
    content: "Old reply",
    createTimestamp: user.createTimestamp + 1,
    creator: { uid: "robot", name: "Robot", avatar: null },
  };
  const history = () => ({
    messages: [{ ...user, creator: { ...user.creator, name } }, assistant],
    events: [],
    cursor: "nonempty-oldest",
  });
  const reply = (response: ServerResponse, data: unknown) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ code: 200, message: "Success", data }));
  };
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    if (path.endsWith("/messages")) {
      if (hold) {
        hold = false;
        held = response;
      } else reply(response, history());
    } else if (path.endsWith("/status"))
      reply(response, { working: false, taskId: null });
    else
      reply(response, {
        conversations: [{ conversationId: 42, title: "Regression" }],
        cursor: null,
      });
  });
  const io = new SocketIoServer(server, { transports: ["websocket"] });
  const sockets: Socket[] = [];
  io.of("/chat").on("connection", (socket) => {
    sockets.push(socket);
    socket.on("join_conversation", (_payload, acknowledge) => acknowledge());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("Missing TCP port");
  const origin = `http://127.0.0.1:${address.port}`;
  const client = createChatClient({
    gateway: createTFRobotChatGateway({
      baseUrl: origin,
      socketNamespaceUrl: `${origin}/chat`,
      serverProfile: { kind: "current-server" },
      messageCreatorProvider: () => ({ uid: "user-1", name: "User" }),
      sessionProvider: {
        getSession: () => ({ kind: "bearer", token: "fixture-session" }),
      },
    }),
  });
  try {
    expect(
      (
        await client.loadConversation({
          conversationId: "42",
          deadlineAt: Date.now() + 5000,
        })
      ).ok,
    ).toBe(true);
    name = "New";
    hold = true;
    sockets[0]!.conn.close();
    await vi.waitFor(() => expect(held).toBeDefined(), { timeout: 5000 });
    sockets
      .at(-1)!
      .emit("chat_message", { ...assistant, content: "New realtime content" });
    await vi.waitFor(() =>
      expect(
        client.getSnapshot()?.timeline.find((item) => item.id === "367"),
      ).toMatchObject({ content: { text: "New realtime content" } }),
    );
    reply(held!, history());
    await vi.waitFor(
      () =>
        expect(client.getSnapshot()?.lifecycle).toMatchObject({
          status: "degraded",
          reconnectAttempt: 1,
        }),
      { timeout: 5000 },
    );
    expect(
      client.getSnapshot()?.timeline.find((item) => item.id === "366"),
    ).toMatchObject({ author: { displayName: "New" } });
    expect(
      client.getSnapshot()?.timeline.find((item) => item.id === "367"),
    ).toMatchObject({ content: { text: "New realtime content" } });
    expect(client.getSnapshot()?.lifecycle?.recovery?.complete).toBe(false);
  } finally {
    held?.end();
    await client.dispose({ deadlineAt: Date.now() + 5000 });
    await new Promise<void>((resolve) => io.close(() => resolve()));
    if (server.listening)
      await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
