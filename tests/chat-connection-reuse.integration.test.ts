import { createServer, type ServerResponse } from "node:http";
import { Server, type Socket } from "socket.io";
import { io as connectSocket } from "socket.io-client";
import { createSocketIoFactoryWith } from "../packages/chat-gateway-tfrobot/src/socket.js";
import { afterEach, describe, expect, it } from "vitest";
import { createTFRobotChatClient } from "../packages/chat-kit/src/headless.js";

const deadline = () => ({ deadlineAt: Date.now() + 5_000 });
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
};
const message = (conversationId: string, id: string) => ({
  msgId: id,
  conversationId,
  content: id,
  additionalKwargs: {},
  attachments: null,
  createTimestamp: 1_800_000_000_000 + (id === "current" ? 1 : 0),
  creator: { uid: "agent", name: "Agent", avatar: null },
  role: "assistant",
  msgType: "text",
});

describe("Front-style switching through real HTTP and Socket.IO", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.reverse()) await cleanup();
    cleanups.length = 0;
  });

  async function fixture(cache = true) {
    let token = "identity-A";
    let denied: string | undefined;
    let heldHistory: string | undefined;
    let heldJoin: string | undefined;
    let rejectedJoin: string | undefined;
    const targetAuthRequired = deferred<void>();
    let heldReconnectAuth: string | undefined;
    const authStarted = deferred<void>();
    const authSession = deferred<{ kind: "bearer"; token: string }>();
    const historyStarted = deferred<ServerResponse>();
    const joinStarted = deferred<(value?: unknown) => void>();
    const sockets: Socket[] = [];
    const clientSockets: ReturnType<typeof connectSocket>[] = [];
    const joins: Array<{ id: string; socketId: string }> = [];
    const requests: string[] = [];
    const connected = deferred<void>();
    const envelope = (response: ServerResponse, data: unknown) => {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ code: 200, message: "Success", data }));
    };
    const http = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://local");
      requests.push(url.pathname);
      const id = /conversations\/(\d+)/u.exec(url.pathname)?.[1];
      if (id === denied) {
        response.writeHead(403);
        response.end();
        return;
      }
      if (url.pathname.endsWith("/status"))
        return envelope(response, { working: false, taskId: null });
      if (url.pathname.endsWith("/messages")) {
        if (request.method === "POST")
          return envelope(response, { taskId: "accepted-run" });
        if (id === heldHistory) {
          historyStarted.resolve(response);
          return;
        }
        return envelope(response, {
          messages: [message(id!, `history-${id}`)],
          events: [],
          cursor: null,
        });
      }
      return envelope(response, {
        conversations: ["1", "2", "3"].map((conversationId) => ({
          conversationId,
          title: conversationId,
          description: null,
          updateTimestamp: 1_800_000_000_000,
        })),
        cursor: null,
      });
    });
    const io = new Server(http, { transports: ["websocket"] });
    const namespace = io.of("/chat");
    const onConnection = (socket: Socket) => {
      sockets.push(socket);
      connected.resolve();
      socket.on(
        "join_conversation",
        async (
          payload: { conversation_id: string },
          ack: (value?: unknown) => void,
        ) => {
          joins.push({ id: payload.conversation_id, socketId: socket.id });
          await socket.join(payload.conversation_id);
          if (payload.conversation_id === rejectedJoin) {
            ack({ code: 403 });
            return;
          }
          if (payload.conversation_id === heldJoin) joinStarted.resolve(ack);
          else ack(); // The current Python Server's empty ACK, no leave handler.
        },
      );
    };
    namespace.on("connection", onConnection);
    io.of("/other-robot").on("connection", onConnection);
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    const address = http.address();
    if (address === null || typeof address === "string")
      throw new Error("No port");
    const origin = `http://127.0.0.1:${address.port}`;
    cleanups.push(async () => {
      await new Promise<void>((resolve) => io.close(() => resolve()));
    });
    const makeClient = (socketNamespace = "/chat") => {
      const client = createTFRobotChatClient({
        baseUrl: origin,
        socketFactory: createSocketIoFactoryWith(
          (
            uri?: string | Parameters<typeof connectSocket>[1],
            options?: Parameters<typeof connectSocket>[1],
          ) => {
            const socket =
              typeof uri === "object"
                ? connectSocket(uri)
                : connectSocket(uri, options);
            clientSockets.push(socket);
            return socket;
          },
        ),
        socketNamespaceUrl: `${origin}${socketNamespace}`,
        serverProfile: { kind: "current-server" },
        onLifecycleDiagnostic: (diagnostic) => {
          if (
            diagnostic.conversationId === "2" &&
            diagnostic.status === "auth-required"
          )
            targetAuthRequired.resolve();
        },
        cache: cache ? {} : false,
        sessionProvider: {
          getSession: (request) => {
            if (
              request.purpose === "reconnect" &&
              request.conversationId === heldReconnectAuth
            ) {
              authStarted.resolve();
              return authSession.promise;
            }
            return { kind: "bearer", token };
          },
          onSessionInvalid: () => undefined,
        },
        messageCreatorProvider: () => ({ uid: "user", name: "User" }),
      });
      cleanups.push(async () => {
        await client.dispose(deadline());
      });
      return client;
    };
    const client = makeClient();
    const load = (id: string) =>
      client.loadConversation({ ...deadline(), conversationId: id });
    return {
      client,
      load,
      makeClient,
      sockets,
      clientSockets,
      joins,
      namespace,
      requests,
      connected,
      targetAuthRequired,
      rejectJoin: (id: string) => {
        rejectedJoin = id;
      },
      holdReconnectAuth: (id: string) => {
        heldReconnectAuth = id;
        return authStarted.promise;
      },
      releaseReconnectAuth: () => {
        heldReconnectAuth = undefined;
        authSession.resolve({ kind: "bearer", token });
      },
      deny: (id?: string) => {
        denied = id;
      },
      changeToken: () => {
        token = "identity-B";
      },
      holdHistory: (id: string) => {
        heldHistory = id;
        return historyStarted.promise;
      },
      releaseHistory: (response: ServerResponse, id: string) => {
        heldHistory = undefined;
        envelope(response, {
          messages: [message(id, `history-${id}`)],
          events: [],
          cursor: null,
        });
      },
      holdJoin: (id: string) => {
        heldJoin = id;
        return joinStarted.promise;
      },
    };
  }

  it.each([true, false])(
    "reuses one handshake for A→B→A and repeated A (cache=%s)",
    async (cache) => {
      const f = await fixture(cache);
      for (const id of ["1", "2", "1", "1"])
        expect((await f.load(id)).ok).toBe(true);
      expect(f.sockets).toHaveLength(1);
      expect(new Set(f.joins.map((join) => join.socketId)).size).toBe(1);
      expect(f.sockets[0]!.rooms).toEqual(
        new Set([f.sockets[0]!.id, "1", "2"]),
      );
      expect(
        f.requests.filter((path) => path.endsWith("/messages")).length,
      ).toBeGreaterThanOrEqual(4);
      expect(f.client.getSnapshot()?.lifecycle?.status).toBe("degraded");
      // Deliver old-room data and an unscoped unknown event before a current
      // message on the same ordered transport; only the current data may appear.
      const seen = deferred<void>();
      const stop = f.client.subscribe(() => {
        if (
          f.client.getSnapshot()?.timeline.some((item) => item.id === "current")
        )
          seen.resolve();
      });
      f.namespace.to("2").emit("chat_message", message("2", "foreign"));
      f.sockets[0]!.emit("future_unscoped", { id: "unscoped" });
      f.namespace.to("2").emit("error", {
        conversationId: "2",
        status: "error",
        message: "old conversation error",
      });
      f.namespace.to("1").emit("chat_message", message("1", "current"));
      await seen.promise;
      stop.dispose();
      expect(f.client.getDiagnostics("1")).toHaveLength(0);
      expect(f.client.getSnapshot()?.timeline.map((item) => item.id)).toEqual([
        "history-1",
        "current",
      ]);
      const disconnected = new Promise<void>((resolve) =>
        f.sockets[0]!.once("disconnect", () => resolve()),
      );
      await f.client.dispose(deadline());
      await disconnected;
      expect(f.sockets[0]!.rooms.size).toBe(0);
    },
  );

  it("shows cache immediately, remains read-only until sync, and preserves the connection", async () => {
    const f = await fixture();
    await f.load("1");
    await f.load("2");
    const held = f.holdHistory("1");
    const loading = f.load("1");
    const response = await held;
    expect(f.client.getSnapshot()?.conversation.id).toBe("1");
    expect(f.client.getSnapshot()?.timeline[0]?.id).toBe("history-1");
    expect(f.client.getSnapshot()?.lifecycle?.status).toBe("offline");
    expect(f.client.getSnapshot()?.capabilities.sendText).toBe(false);
    expect(f.sockets).toHaveLength(1);
    f.releaseHistory(response, "1");
    expect((await loading).ok).toBe(true);
    expect(f.client.getSnapshot()?.lifecycle?.status).toBe("degraded");
    expect(f.sockets).toHaveLength(1);
  });

  it("keeps the old conversation on an uncached denial and target cache read-only on a cached denial", async () => {
    const f = await fixture();
    await f.load("1");
    f.deny("2");
    expect((await f.load("2")).ok).toBe(false);
    expect(f.client.getSnapshot()?.conversation.id).toBe("1");
    expect(f.client.getSnapshot()?.lifecycle?.status).toBe("degraded");
    f.deny();
    await f.load("2");
    f.deny("1");
    expect((await f.load("1")).ok).toBe(false);
    expect(f.client.getSnapshot()?.conversation.id).toBe("1");
    expect(f.client.getSnapshot()?.capabilities.sendText).toBe(false);
    expect(f.sockets).toHaveLength(1);
  });

  it("rejects a late B ACK after A→B→C without rebuilding the connection", async () => {
    const f = await fixture();
    await f.load("1");
    const held = f.holdJoin("2");
    const b = f.load("2");
    const acknowledgeB = await held;
    expect((await f.load("3")).ok).toBe(true);
    acknowledgeB();
    expect((await b).ok).toBe(false);
    expect(f.client.getSnapshot()?.conversation.id).toBe("3");
    expect(f.client.getSnapshot()?.timeline.map((item) => item.id)).toEqual([
      "history-3",
    ]);
    expect(f.sockets).toHaveLength(1);
  });

  it("never shares across Gateway instances or changed credentials", async () => {
    const f = await fixture();
    await f.load("1");
    const second = f.makeClient();
    expect(
      (await second.loadConversation({ ...deadline(), conversationId: "1" }))
        .ok,
    ).toBe(true);
    expect(f.sockets).toHaveLength(2);
    const disconnected = new Promise<void>((resolve) =>
      f.sockets[0]!.once("disconnect", () => resolve()),
    );
    f.changeToken();
    expect((await f.load("2")).ok).toBe(true);
    await disconnected;
    expect(f.sockets).toHaveLength(3);
    expect(f.sockets[1]!.connected).toBe(true);
    expect(f.sockets[2]!.handshake.auth["token"]).toBe("identity-B");
  });

  it("keeps different robot namespace routes on separate physical connections", async () => {
    const f = await fixture();
    await f.load("1");
    const other = f.makeClient("/other-robot");
    expect(
      (await other.loadConversation({ ...deadline(), conversationId: "1" })).ok,
    ).toBe(true);
    expect(f.sockets).toHaveLength(2);
    expect(f.sockets[0]!.conn).not.toBe(f.sockets[1]!.conn);
  });

  it("keeps A usable after a reused B join times out and ignores its late ACK", async () => {
    const f = await fixture(false);
    await f.load("1");
    const held = f.holdJoin("2");
    const pending = f.client.loadConversation({
      conversationId: "2",
      deadlineAt: Date.now() + 250,
    });
    const acknowledge = await held;
    expect((await pending).ok).toBe(false);
    expect(f.client.getSnapshot()?.conversation.id).toBe("1");
    expect(f.client.getSnapshot()?.lifecycle?.status).toBe("degraded");
    acknowledge();
    expect((await f.load("3")).ok).toBe(true);
    expect(f.client.getSnapshot()?.conversation.id).toBe("3");
    expect(f.sockets).toHaveLength(1);
  });

  it("invalidates the shared identity on a reused join's authentication rejection", async () => {
    const f = await fixture(false);
    await f.load("1");
    const held = f.holdJoin("2");
    const pending = f.load("2");
    const acknowledge = await held;
    acknowledge({ code: 401 });
    expect((await pending).ok).toBe(false);
    expect(f.client.getSnapshot()?.lifecycle?.status).toBe("auth-required");
    expect(
      (
        await f.client.sendText({
          ...deadline(),
          conversationId: "1",
          text: "blocked",
        })
      ).ok,
    ).toBe(false);
  });

  it("reconnects the selected conversation after reuse with best-effort recovery", async () => {
    const f = await fixture();
    await f.load("1");
    await f.load("2");
    const recovered = deferred<void>();
    const stop = f.client.subscribe(() => {
      const lifecycle = f.client.getSnapshot()?.lifecycle;
      if (
        lifecycle?.status === "degraded" &&
        (lifecycle.reconnectAttempt ?? 0) > 0
      )
        recovered.resolve();
    });
    f.sockets[0]!.disconnect(true);
    await recovered.promise;
    stop.dispose();
    expect(f.sockets).toHaveLength(2);
    expect(f.sockets[1]!.rooms).toEqual(new Set([f.sockets[1]!.id, "2"]));
    expect(f.client.getSnapshot()?.lifecycle?.recovery?.complete).toBe(false);
  });

  it("ignores released A's cancelled authentication while B reconnects", async () => {
    const f = await fixture(false);
    await f.load("1");
    const joined = f.holdJoin("2");
    const loading = f.load("2");
    const acknowledge = await joined;
    const history = f.holdHistory("2");
    acknowledge();
    const response = await history;
    const authStarted = f.holdReconnectAuth("1");
    f.sockets[0]!.disconnect(true);
    await authStarted;
    const recovered = deferred<void>();
    const stop = f.client.subscribe(() => {
      const snapshot = f.client.getSnapshot();
      if (
        snapshot?.conversation.id === "2" &&
        snapshot.lifecycle?.status === "degraded" &&
        (snapshot.lifecycle.reconnectAttempt ?? 0) > 0
      )
        recovered.resolve();
    });
    f.releaseHistory(response, "2");
    expect((await loading).ok).toBe(true);
    // The reconnect join must no longer be held by the initial ACK fixture.
    void f.holdJoin("unused");
    await recovered.promise;
    stop.dispose();
    expect(f.sockets).toHaveLength(2);
    expect(f.sockets[1]!.handshake.auth).toEqual({ token: "identity-A" });
  });

  it("retires a recovered old transport after the new transport commits", async () => {
    const f = await fixture(false);
    await f.load("1");
    const authStarted = f.holdReconnectAuth("1");
    f.sockets[0]!.disconnect(true);
    await authStarted;
    const joined = f.holdJoin("2");
    const loading = f.load("2");
    const acknowledge = await joined;
    const recovered = deferred<void>();
    const stop = f.client.subscribe(() => {
      const snapshot = f.client.getSnapshot();
      if (
        snapshot?.conversation.id === "1" &&
        snapshot.lifecycle?.status === "degraded" &&
        (snapshot.lifecycle.reconnectAttempt ?? 0) > 0
      )
        recovered.resolve();
    });
    f.releaseReconnectAuth();
    await recovered.promise;
    stop.dispose();
    expect(f.sockets).toHaveLength(3);
    expect(f.sockets.filter((socket) => socket.connected)).toHaveLength(2);
    acknowledge();
    expect((await loading).ok).toBe(true);
    await expect
      .poll(() => f.sockets.filter((socket) => socket.connected).length)
      .toBe(1);
    expect(f.sockets[1]!.connected).toBe(true);
    expect((await f.load("3")).ok).toBe(true);
    expect(f.sockets).toHaveLength(3);
  });

  it.each([true, false])(
    "reuses recovered A after a new B transport is rejected (cache=%s)",
    async (cache) => {
      const f = await fixture(cache);
      await f.load("3");
      await f.load("1");
      const authStarted = f.holdReconnectAuth("1");
      f.sockets[0]!.disconnect(true);
      await authStarted;
      const joined = f.holdJoin("2");
      const loading = f.load("2");
      const acknowledge = await joined;
      const recovered = deferred<void>();
      const stop = f.client.subscribe(() => {
        const snapshot = f.client.getSnapshot();
        if (
          snapshot?.conversation.id === "1" &&
          snapshot.lifecycle?.status === "degraded" &&
          (snapshot.lifecycle.reconnectAttempt ?? 0) > 0
        )
          recovered.resolve();
      });
      f.releaseReconnectAuth();
      await recovered.promise;
      stop.dispose();
      acknowledge({ code: 403 });
      expect((await loading).ok).toBe(false);
      expect(f.client.getSnapshot()?.lifecycle?.status).toBe("degraded");
      expect(f.sockets).toHaveLength(3);
      expect((await f.load("3")).ok).toBe(true);
      expect(f.sockets).toHaveLength(3);
      expect(f.sockets[2]!.connected).toBe(true);
    },
  );

  it.each(["join", "rebase"])(
    "keeps A usable when B's reconnect %s is forbidden",
    async (phase) => {
      const f = await fixture(false);
      await f.load("1");
      const joined = f.holdJoin("2");
      const loading = f.load("2");
      const acknowledge = await joined;
      const history = f.holdHistory("2");
      acknowledge();
      const response = await history;
      void f.holdJoin("unused");
      if (phase === "join") f.rejectJoin("2");
      else f.deny("2");
      f.sockets[0]!.disconnect(true);
      await f.targetAuthRequired.promise;
      response.writeHead(403);
      response.end();
      expect((await loading).ok).toBe(false);
      expect(f.client.getSnapshot()?.conversation.id).toBe("1");
      await expect
        .poll(() => f.client.getSnapshot()?.lifecycle?.status)
        .toBe("degraded");
      expect(f.sockets).toHaveLength(2);
      expect(f.sockets[1]!.connected).toBe(true);
      f.namespace.to("1").emit("chat_message", message("1", "current"));
      await expect
        .poll(() =>
          f.client
            .getSnapshot()
            ?.timeline.some((item) => item.id === "current"),
        )
        .toBe(true);
      expect(
        await f.client.sendText({
          ...deadline(),
          conversationId: "1",
          text: "A remains usable",
        }),
      ).toEqual({ ok: true, value: { runId: "accepted-run" } });
    },
  );

  it("expires transport ACK callbacks after repeated cancelled and timed out joins", async () => {
    const f = await fixture(false);
    await f.load("1");
    void f.holdJoin("2");
    const first = await f.client.loadConversation({
      conversationId: "2",
      deadlineAt: Date.now() + 100,
    });
    expect(first.ok).toBe(false);
    for (let index = 0; index < 2; index += 1) {
      const pending = f.client.loadConversation({
        conversationId: "2",
        deadlineAt: Date.now() + 500,
      });
      await expect
        .poll(() => f.joins.filter((join) => join.id === "2").length)
        .toBe(index + 2);
      expect((await f.load("1")).ok).toBe(true);
      expect((await pending).ok).toBe(false);
    }
    // Inspect the real client's private ACK registry only as resource evidence.
    const pendingAcks = () =>
      Object.keys(
        Object.getOwnPropertyDescriptor(f.clientSockets[0]!, "acks")!
          .value as object,
      ).length;
    await expect.poll(pendingAcks, { timeout: 1_500 }).toBe(0);
    expect(f.sockets).toHaveLength(1);
    expect(f.sockets[0]!.connected).toBe(true);
    expect(f.client.getSnapshot()?.lifecycle?.status).toBe("degraded");
  });

  it("keeps A usable when B history fails after its join succeeds", async () => {
    const f = await fixture(false);
    await f.load("1");
    const held = f.holdJoin("2");
    const loading = f.load("2");
    const acknowledge = await held;
    f.deny("2");
    acknowledge();
    expect((await loading).ok).toBe(false);
    expect(f.client.getSnapshot()?.conversation.id).toBe("1");
    expect(f.client.getSnapshot()?.lifecycle?.status).toBe("degraded");
    expect(f.sockets).toHaveLength(1);
    expect(f.sockets[0]!.connected).toBe(true);
  });

  it("retires the previous identity even when the new identity's target preflight fails", async () => {
    const f = await fixture(false);
    await f.load("1");
    const disconnected = new Promise<void>((resolve) =>
      f.sockets[0]!.once("disconnect", () => resolve()),
    );
    f.changeToken();
    f.deny("2");
    expect((await f.load("2")).ok).toBe(false);
    await disconnected;
    expect(f.client.getSnapshot()?.lifecycle?.status).toBe("auth-required");
    expect(
      (
        await f.client.sendText({
          ...deadline(),
          conversationId: "1",
          text: "must not send",
        })
      ).ok,
    ).toBe(false);
  });

  it("can switch during a real disconnection without late recovery affecting the target", async () => {
    const f = await fixture();
    await f.load("1");
    const offline = deferred<void>();
    const subscription = f.client.subscribe(() => {
      if (f.client.getSnapshot()?.lifecycle?.status === "reconnecting")
        offline.resolve();
    });
    f.sockets[0]!.disconnect(true);
    await offline.promise;
    expect((await f.load("2")).ok).toBe(true);
    subscription.dispose();
    expect(f.client.getSnapshot()?.conversation.id).toBe("2");
    expect(f.client.getSnapshot()?.lifecycle?.status).toBe("degraded");
    expect(
      f.client
        .getSnapshot()
        ?.timeline.every((item) => item.conversationId === "2"),
    ).toBe(true);
  });
});
