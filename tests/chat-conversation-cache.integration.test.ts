import { createServer, type ServerResponse } from "node:http";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Server as SocketServer } from "socket.io";
import { expect, it } from "vitest";
import { createTFRobotChatClient } from "../packages/chat-kit/src/headless.js";
import type { ConversationCacheStorage } from "../packages/chat-runtime/src/index.js";

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
};

it("restores real disk data and merges real HTTP/Socket.IO updates across a cache-first switch", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "chat-cache-"));
  let writes = Promise.resolve();
  const file = (scope: string) =>
    path.join(directory, Buffer.from(scope).toString("hex") + ".json");
  const read = async (scope: string): Promise<string | null> => {
    try {
      return await readFile(file(scope), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  };
  // One adapter is shared by all clients in this test; it owns the file lock.
  const storage: ConversationCacheStorage = {
    read: async (scope) => {
      await writes;
      return read(scope);
    },
    update(scope, transform) {
      const operation = writes.then(async () => {
        const next = transform(await read(scope));
        if (next === null) await rm(file(scope), { force: true });
        else {
          await writeFile(file(scope) + ".tmp", next);
          await rename(file(scope) + ".tmp", file(scope));
        }
      });
      writes = operation.catch(() => undefined);
      return operation;
    },
  };
  const held = deferred<ServerResponse>();
  let holdHistory = false;
  const envelope = (response: ServerResponse, data: unknown) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ code: 200, message: "Success", data }));
  };
  const dto = (id: string, conversationId: number, text = id) => ({
    msgId: id,
    conversationId,
    content: text,
    additionalKwargs: {},
    attachments: null,
    createTimestamp: 1_800_000_000_000 + (id === "live" ? 1 : 0),
    creator: { uid: "agent", name: "Agent", avatar: null },
    role: "assistant",
    msgType: "text",
  });
  const http = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname.endsWith("/status"))
      return envelope(response, { working: false, taskId: null });
    if (url.pathname.endsWith("/messages")) {
      const id = url.pathname.includes("/42/") ? 42 : 43;
      if (holdHistory && id === 42) {
        held.resolve(response);
        return;
      }
      return envelope(response, {
        messages: [dto(`message-${id}`, id)],
        events: [],
        cursor: null,
      });
    }
    return envelope(response, {
      conversations: [42, 43].map((id) => ({
        conversationId: id,
        title: `Conversation ${id}`,
        description: null,
        updateTimestamp: 1_800_000_000_000,
      })),
      cursor: null,
    });
  });
  const sockets = new SocketServer(http, { transports: ["websocket"] });
  const namespace = sockets.of("/chat");
  namespace.on("connection", (socket) => {
    socket.on(
      "join_conversation",
      (_payload: unknown, acknowledge: (value: unknown) => void) =>
        acknowledge({ accepted: true }),
    );
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  if (address === null || typeof address === "string")
    throw new Error("Missing server address");
  const origin = `http://127.0.0.1:${address.port}`;
  const clientOptions = {
    baseUrl: origin,
    socketNamespaceUrl: `${origin}/chat`,
    sessionProvider: {
      getSession: () => ({
        kind: "bearer" as const,
        token: "session-not-for-disk",
      }),
    },
    messageCreatorProvider: () => ({ uid: "user", name: "User" }),
    cache: { storage },
  };
  const options = () => ({ deadlineAt: Date.now() + 10_000 });
  const client = createTFRobotChatClient(clientOptions);
  let replacement: ReturnType<typeof createTFRobotChatClient> | undefined;
  let response: ServerResponse | undefined;
  try {
    expect(
      (await client.loadConversation({ ...options(), conversationId: "42" }))
        .ok,
    ).toBe(true);
    client.setComposerDraft({ conversationId: "42", text: "Disk draft" });
    expect(
      (await client.loadConversation({ ...options(), conversationId: "43" }))
        .ok,
    ).toBe(true);
    holdHistory = true;
    const loading = client.loadConversation({
      ...options(),
      conversationId: "42",
    });
    response = await held.promise;
    expect(client.getCacheState()).toMatchObject({
      source: "memory",
      status: "syncing",
    });
    expect(client.getSnapshot()?.timeline[0]?.id).toBe("message-42");
    namespace.emit("chat_message", dto("live", 42));
    envelope(response, {
      messages: [dto("message-42", 42)],
      events: [],
      cursor: null,
    });
    expect((await loading).ok).toBe(true);
    // The wire event may arrive just after REST; subscribe instead of polling.
    if (!client.getSnapshot()?.timeline.some((item) => item.id === "live")) {
      await new Promise<void>((resolve) => {
        const subscription = client.subscribe((snapshot) => {
          if (snapshot.timeline.some((item) => item.id === "live")) {
            subscription.dispose();
            resolve();
          }
        });
      });
    }
    expect(client.getSnapshot()?.timeline.map((item) => item.id)).toEqual([
      "message-42",
      "live",
    ]);
    await client.dispose(options());
    expect(await read("default")).not.toContain("session-not-for-disk");
    replacement = createTFRobotChatClient(clientOptions);
    const observed: string[] = [];
    replacement.subscribe((snapshot) => {
      if (replacement!.getCacheState().source === "storage")
        observed.push(snapshot.conversation.id);
    });
    holdHistory = false;
    expect(
      (
        await replacement.loadConversation({
          ...options(),
          conversationId: "42",
        })
      ).ok,
    ).toBe(true);
    expect(observed).toContain("42");
    expect(replacement.getComposerDraft("42").text).toBe("Disk draft");
  } finally {
    if (response !== undefined && !response.writableEnded) response.end();
    await client.dispose(options());
    await replacement?.dispose(options());
    await new Promise<void>((resolve) => sockets.close(() => resolve()));
    if (http.listening)
      await new Promise<void>((resolve) => http.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
}, 20_000);
