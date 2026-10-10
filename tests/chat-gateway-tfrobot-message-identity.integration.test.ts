import { createServer, type ServerResponse } from "node:http";

import { Server as SocketIoServer, type Socket } from "socket.io";
import { expect, it, vi } from "vitest";

import { createTFRobotChatGateway } from "../packages/chat-gateway-tfrobot/src/index.js";
import { createChatClient } from "../packages/chat-runtime/src/index.js";

it.each([false, true])(
  "reconciles an unpersisted user message during handoff with Server enrichment: %s",
  async (enriched) => {
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
    let secondPersistedMessage = false;
    let heldHistory: ServerResponse | undefined;
    let holdNextHistory = false;
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
          ]
        : [],
      events: [],
      cursor: null,
    });
    const server = createServer((request, response) => {
      const path = new URL(request.url ?? "/", "http://localhost").pathname;
      if (path.endsWith("/messages")) {
        if (holdNextHistory) {
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
      secondPersistedMessage = true;
      expect((await load()).ok).toBe(true);
      expect(client.getSnapshot()?.timeline).toHaveLength(2);
    } finally {
      heldHistory?.end();
      await client.dispose({ deadlineAt: Date.now() + 5_000 });
      await new Promise<void>((resolve) => socketServer.close(() => resolve()));
      if (server.listening)
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);
