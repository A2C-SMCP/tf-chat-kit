import { createServer, type ServerResponse } from "node:http";
import { Server as SocketIoServer, type Socket } from "socket.io";
import { expect, it, vi } from "vitest";
import { createMemoryChatGateway } from "../packages/chat-testing/src/index.js";
import { createTFRobotChatGateway } from "../packages/chat-gateway-tfrobot/src/index.js";
import {
  createChatClient,
  type ConversationCacheStorage,
} from "../packages/chat-runtime/src/index.js";

it.each([
  { liveFirst: false, profile: "current-server" as const, attachments: false },
  { liveFirst: true, profile: "current-server" as const, attachments: false },
  { liveFirst: false, profile: "verified" as const, attachments: false },
  { liveFirst: true, profile: "verified" as const, attachments: false },
  { liveFirst: false, profile: "current-server" as const, attachments: true },
])(
  "joins real POST/Socket/history/cache by elementId: %j",
  async ({ liveFirst, profile, attachments }) => {
    const elementId = "28d9e235-607c-40dc-a984-dba615b62e49";
    const otherElementId = "55b01bed-c317-445b-a3e3-040ea3fc4d7c";
    const live = {
      msgId: null,
      elementId,
      conversationId: 42,
      role: "user",
      msgType: "text",
      content: "Same input",
      createTimestamp: 100,
      creator: { uid: "admin", name: "Admin" },
    };
    let persisted = false;
    let held: ServerResponse | undefined;
    let encoded: string | null = null;
    let posted: Record<string, unknown> | undefined;
    const storage: ConversationCacheStorage = {
      read: async () => encoded,
      update: async (_scope, transform) => {
        encoded = transform(encoded);
      },
    };
    const reply = (response: ServerResponse, data: unknown) => {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ code: 200, message: "Success", data }));
    };
    const history = () => ({
      messages: persisted
        ? [
            {
              ...live,
              msgId: 366,
              creator: { uid: "user-1", name: "History User" },
            },
            {
              ...live,
              elementId: otherElementId,
              msgId: 367,
              creator: { uid: "user-2", name: "Other User" },
            },
          ]
        : [],
      events: [],
      cursor: null,
    });
    const server = createServer((request, response) => {
      const path = new URL(request.url ?? "/", "http://localhost").pathname;
      if (request.method === "POST" && path.endsWith("/messages")) {
        let text = "";
        request.setEncoding("utf8");
        request.on("data", (chunk: string) => {
          text += chunk;
        });
        request.on("end", () => {
          posted = JSON.parse(text) as Record<string, unknown>;
          held = response;
        });
      } else if (path.endsWith("/messages")) reply(response, history());
      else if (path.endsWith("/status"))
        reply(response, { working: false, taskId: null });
      else
        reply(response, {
          conversations: [{ conversationId: 42, title: "Identity test" }],
          cursor: null,
        });
    });
    const sockets: Socket[] = [];
    let joins = 0;
    const socketServer = new SocketIoServer(server, {
      transports: ["websocket"],
    });
    socketServer.of("/chat").on("connection", (socket) => {
      sockets.push(socket);
      socket.on("join_conversation", (_data, ack: (value: unknown) => void) => {
        joins++;
        ack({ accepted: true });
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new Error("Missing port");
    const origin = `http://127.0.0.1:${address.port}`;
    const makeClient = () =>
      createChatClient({
        cache: { storage },
        gateway: createTFRobotChatGateway({
          baseUrl: origin,
          socketNamespaceUrl: `${origin}/chat`,
          serverProfile: { kind: profile },
          messageCreatorProvider: () => ({ uid: "user-1", name: "User" }),
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
      const input = { ...options(), conversationId: "42", text: live.content };
      const sending = attachments
        ? first.sendMessage({
            ...input,
            attachments: [
              {
                uri: "https://example.invalid/test.txt",
                mimeType: "text/plain",
                name: "test.txt",
              },
            ],
          })
        : first.sendText(input);
      await vi.waitFor(() => expect(held).toBeDefined());
      expect(posted).not.toHaveProperty("elementId");
      expect(first.getSnapshot()?.timeline).toHaveLength(0);
      expect(first.getSnapshot()?.outgoingMessages).toMatchObject([
        { status: "sending" },
      ]);
      if (liveFirst) {
        sockets.at(-1)!.emit("chat_message", live);
        await vi.waitFor(() =>
          expect(first.getSnapshot()?.timeline).toHaveLength(1),
        );
      }
      reply(held!, { taskId: "run-1", elementId });
      expect(await sending).toMatchObject({
        ok: true,
        value: { runId: "run-1", serverMessageId: elementId },
      });
      if (!liveFirst) {
        expect(first.getSnapshot()?.outgoingMessages).toMatchObject([
          { status: "accepted", serverMessageId: elementId },
        ]);
        expect(first.getSnapshot()?.timeline).toHaveLength(0);
        sockets.at(-1)!.emit("chat_message", live);
      }
      await vi.waitFor(() =>
        expect(first.getSnapshot()?.outgoingMessages ?? []).toHaveLength(0),
      );
      const initialId = first.getSnapshot()?.timeline[0]?.id;
      sockets
        .at(-1)!
        .emit("chat_message", { ...live, elementId: otherElementId });
      await vi.waitFor(() =>
        expect(first.getSnapshot()?.timeline).toHaveLength(2),
      );
      persisted = true;
      expect(
        (await first.loadConversation({ ...options(), conversationId: "42" }))
          .ok,
      ).toBe(true);
      expect(first.getSnapshot()?.timeline).toHaveLength(2);
      expect(first.getSnapshot()?.timeline[0]).toMatchObject({
        id: initialId,
        serverMessageId: elementId,
        author: { id: "user-1", displayName: "History User" },
        provenance: { kind: "persisted", id: "366" },
      });
      sockets.at(-1)!.emit("chat_message", live);
      await vi.waitFor(() =>
        expect(first.getSnapshot()?.timeline[0]).toMatchObject({
          author: { id: "user-1" },
        }),
      );
      await first.flushCache(options());
      expect(encoded).toContain(elementId);
      expect(encoded).not.toContain("outgoingMessages");
      await first.dispose(options());
      second = makeClient();
      expect(
        (await second.loadConversation({ ...options(), conversationId: "42" }))
          .ok,
      ).toBe(true);
      expect(second.getSnapshot()?.timeline).toHaveLength(2);
      expect(second.getSnapshot()?.timeline[0]?.id).toBe(initialId);
      expect(second.getSnapshot()?.outgoingMessages ?? []).toHaveLength(0);
      if (profile === "current-server") {
        const before = joins;
        sockets.at(-1)!.conn.close();
        await vi.waitFor(
          () => {
            expect(joins).toBeGreaterThan(before);
            expect(second!.getSnapshot()?.lifecycle?.status).toBe("degraded");
          },
          { timeout: 5000 },
        );
        expect(second.getSnapshot()?.timeline).toHaveLength(2);
        expect(second.getSnapshot()?.timeline[0]).toMatchObject({
          serverMessageId: elementId,
          author: { id: "user-1" },
        });
      }

      if (profile === "current-server")
        expect(second.getSnapshot()?.lifecycle?.recovery?.complete).toBe(false);
      else expect(second.getSnapshot()?.lifecycle?.status).toBe("active");
    } finally {
      held?.end();
      await first.dispose(options());
      await second?.dispose(options());
      await new Promise<void>((resolve) => socketServer.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);

it.each([
  { status: 400, data: { taskId: "rejected" }, expected: "failed" },
  { status: 408, data: { taskId: "rejected" }, expected: "failed" },
  { status: 429, data: { taskId: "rejected" }, expected: "failed" },
  {
    status: 200,
    data: { taskId: "accepted", elementId: 42 },
    expected: "unknown",
  },
  { status: 200, data: null, expected: "unknown" },
])(
  "classifies an actual HTTP $status send response ($expected): $data",
  async ({ status, data, expected }) => {
    let posts = 0;
    const server = createServer((request, response) => {
      if (request.method === "POST") posts++;
      request.resume();
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({ code: 200, message: "Fixture response", data }),
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new Error("Missing port");
    const gateway = createTFRobotChatGateway({
      baseUrl: `http://127.0.0.1:${address.port}`,
      sessionProvider: {
        getSession: () => ({ kind: "bearer", token: "fixture-session" }),
      },
      messageCreatorProvider: () => ({ uid: "user-1", name: "User" }),
    });
    const memory = createMemoryChatGateway();
    vi.spyOn(memory.gateway, "sendText").mockImplementation((input) =>
      gateway.sendText(input),
    );
    const client = createChatClient({ gateway: memory.gateway });
    const options = () => ({ deadlineAt: Date.now() + 5000 });
    const conversationId = memory.fixtures.conversation.id;
    try {
      expect(
        (await client.loadConversation({ ...options(), conversationId })).ok,
      ).toBe(true);
      const result = await client.sendText({
        ...options(),
        conversationId,
        text: "Send receipt",
      });
      expect(result).toMatchObject({
        ok: false,
        error: { diagnostic: { httpStatus: status } },
      });
      expect(posts).toBe(1);
      expect(client.getSnapshot()!.outgoingMessages).toMatchObject([
        { status: expected },
      ]);
      expect(posts).toBe(1);
      client.dismissOutgoingMessage(
        client.getSnapshot()!.outgoingMessages![0]!.id,
      );
      expect(posts).toBe(1);
    } finally {
      await client.dispose(options());
      await gateway.dispose(options());
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  },
);
