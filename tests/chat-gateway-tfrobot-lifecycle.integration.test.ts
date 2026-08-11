import { createServer } from "node:http";

import { Server as SocketIoServer, type Socket } from "socket.io";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createTFRobotChatGateway } from "../packages/chat-gateway-tfrobot/src/index.js";
import type { ChatUpdate } from "../packages/chat-protocol/src/index.js";

const deadlineAt = (): number => Date.now() + 5_000;

describe("TFRobot Gateway real Socket.IO lifecycle", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it("acknowledges join, refreshes a server-forced disconnect, and verifies recovery", async () => {
    const httpServer = createServer();
    const socketServer = new SocketIoServer(httpServer, {
      transports: ["websocket"],
    });
    const namespace = socketServer.of("/chat");
    const serverSockets: Socket[] = [];
    const handshakeTokens: unknown[] = [];
    const replayedMessage = {
      msgId: "message-missed-while-offline",
      content: "Replayed after reconnect",
      additionalKwargs: {},
      attachments: null,
      createTimestamp: 1_773_705_600_000,
      creator: { uid: "agent-1", name: "Agent", avatar: null },
      conversationId: 42,
      role: "assistant",
      msgType: "text",
    };
    let joinCount = 0;
    let replayPending = false;
    let replayCount = 0;
    namespace.on("connection", (socket) => {
      serverSockets.push(socket);
      handshakeTokens.push(socket.handshake.auth["token"]);
      socket.on(
        "join_conversation",
        (
          payload: { readonly conversation_id?: unknown },
          acknowledge: (value: unknown) => void,
        ) => {
          joinCount += 1;
          expect(payload).toEqual({ conversation_id: "42" });
          if (joinCount === 2 && replayPending) {
            socket.emit("chat_message", replayedMessage);
            replayPending = false;
            replayCount += 1;
          }
          acknowledge(
            joinCount === 1
              ? { accepted: true }
              : {
                  accepted: true,
                  recovered: true,
                  cursor: "cursor-after-reconnect",
                },
          );
        },
      );
    });
    await new Promise<void>((resolve) => {
      httpServer.listen(0, "127.0.0.1", resolve);
    });
    const address = httpServer.address();
    if (address === null || typeof address === "string") {
      throw new Error("Socket.IO test server did not expose a TCP port");
    }
    const origin = `http://127.0.0.1:${address.port}`;
    const onSessionInvalid = vi.fn(async () => undefined);
    const getSession = vi.fn(
      (request: { readonly purpose: "connect" | "reconnect" | "request" }) =>
        request.purpose === "reconnect"
          ? { kind: "bearer" as const, token: "refreshed-token" }
          : { kind: "bearer" as const, token: "initial-token" },
    );
    const updates: ChatUpdate[] = [];
    const gateway = createTFRobotChatGateway({
      baseUrl: origin,
      socketNamespaceUrl: `${origin}/chat`,
      messageCreatorProvider: () => ({ uid: "user-1", name: "User" }),
      sessionProvider: {
        getSession,
        onSessionInvalid,
      },
      fetch: vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              code: 200,
              message: "Success",
              data: { working: false, taskId: null },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
      ),
    });
    cleanups.push(async () => {
      await gateway.dispose({ deadlineAt: deadlineAt() });
      await new Promise<void>((resolve) => socketServer.close(() => resolve()));
      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) =>
          error === undefined ? resolve() : reject(error),
        );
      }).catch(() => undefined);
    });

    const subscribed = await gateway.subscribe(
      { conversationId: "42", deadlineAt: deadlineAt() },
      { next: (update) => updates.push(update) },
    );
    expect(subscribed.ok).toBe(true);
    expect(
      updates
        .filter((update) => update.kind === "lifecycle.changed")
        .map((update) => update.lifecycle.status),
    ).toEqual(["connecting", "joining", "active"]);

    replayPending = true;
    serverSockets[0]!.disconnect(true);
    await vi.waitFor(() => expect(onSessionInvalid).toHaveBeenCalledOnce(), {
      timeout: 3_000,
    });
    await vi.waitFor(
      () => {
        const active = updates
          .filter(
            (update) =>
              update.kind === "lifecycle.changed" &&
              update.lifecycle.status === "active" &&
              update.lifecycle.reconnectAttempt === 1,
          )
          .at(-1);
        expect(active).toMatchObject({
          lifecycle: {
            recovery: {
              complete: true,
              cursor: "cursor-after-reconnect",
            },
          },
        });
      },
      { timeout: 3_000 },
    );
    expect(joinCount).toBe(2);
    expect(replayCount).toBe(1);
    expect(handshakeTokens).toEqual(["initial-token", "refreshed-token"]);
    const recoveringIndex = updates.findIndex(
      (update) =>
        update.kind === "lifecycle.changed" &&
        update.lifecycle.status === "recovering",
    );
    const replayIndex = updates.findIndex(
      (update) =>
        update.kind === "timeline.upsert" &&
        update.item.id === "message-missed-while-offline",
    );
    const recoveredActiveIndex = updates.findIndex(
      (update) =>
        update.kind === "lifecycle.changed" &&
        update.lifecycle.status === "active" &&
        update.lifecycle.reconnectAttempt === 1,
    );
    expect(recoveringIndex).toBeGreaterThan(-1);
    expect(replayIndex).toBeGreaterThan(recoveringIndex);
    expect(recoveredActiveIndex).toBeGreaterThan(replayIndex);
  });

  it("fails closed when the real Socket.IO join route returns a forbidden ack", async () => {
    const httpServer = createServer();
    const socketServer = new SocketIoServer(httpServer, {
      transports: ["websocket"],
    });
    socketServer.of("/chat").on("connection", (socket) => {
      socket.on(
        "join_conversation",
        (_payload: unknown, acknowledge: (value: unknown) => void) => {
          acknowledge({ statusCode: "403", message: "Forbidden" });
        },
      );
    });
    await new Promise<void>((resolve) => {
      httpServer.listen(0, "127.0.0.1", resolve);
    });
    const address = httpServer.address();
    if (address === null || typeof address === "string") {
      throw new Error("Socket.IO test server did not expose a TCP port");
    }
    const origin = `http://127.0.0.1:${address.port}`;
    const onSessionInvalid = vi.fn(async () => undefined);
    const updates: ChatUpdate[] = [];
    const gateway = createTFRobotChatGateway({
      baseUrl: origin,
      socketNamespaceUrl: `${origin}/chat`,
      messageCreatorProvider: () => ({ uid: "user-1", name: "User" }),
      sessionProvider: {
        getSession: () => ({ kind: "bearer", token: "short-lived-token" }),
        onSessionInvalid,
      },
      fetch: vi.fn(),
    });
    cleanups.push(async () => {
      await gateway.dispose({ deadlineAt: deadlineAt() });
      await new Promise<void>((resolve) => socketServer.close(() => resolve()));
      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) =>
          error === undefined ? resolve() : reject(error),
        );
      }).catch(() => undefined);
    });

    await expect(
      gateway.subscribe(
        { conversationId: "42", deadlineAt: deadlineAt() },
        { next: (update) => updates.push(update) },
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "authorization", message: "Forbidden" },
    });
    await vi.waitFor(() => expect(onSessionInvalid).toHaveBeenCalledOnce());
    expect(updates).toEqual([]);
  });
});
