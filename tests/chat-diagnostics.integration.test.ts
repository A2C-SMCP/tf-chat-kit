import { createServer } from "node:http";
import { Server as SocketServer } from "socket.io";
import { expect, it, vi } from "vitest";
import { TFRobotHttpClient } from "../packages/chat-gateway-tfrobot/src/http.js";
import { historyDtoSchema } from "../packages/chat-gateway-tfrobot/src/dto.js";
import { createTFRobotChatGateway } from "../packages/chat-gateway-tfrobot/src/index.js";
import type {
  ChatError,
  ChatUpdate,
} from "../packages/chat-protocol/src/index.js";

it("captures real HTTP errors, business codes, response IDs and uncertain post deadlines without copying payloads", async () => {
  let mode = 401;
  const http = createServer((request, response) => {
    if (mode === 0) return;
    response.writeHead(mode === 700 || mode === 701 ? 200 : mode, {
      "Content-Type": "application/json",
      "X-Request-ID": "req-actual",
      "X-Trace-ID": "trace-actual",
    });
    response.end(
      mode === 701
        ? "invalid JSON"
        : JSON.stringify({
            code: mode,
            message: "private chat body opaque-secret",
            data: { secret: "opaque-secret" },
          }),
    );
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  if (!address || typeof address === "string")
    throw new Error("No HTTP address");
  const diagnostics: ChatError[] = [];
  const client = new TFRobotHttpClient({
    baseUrl: `http://127.0.0.1:${address.port}`,
    socketNamespaceUrl: `http://127.0.0.1:${address.port}/chat`,
    messageCreatorProvider: () => ({ uid: "test", name: "Test" }),
    sessionProvider: {
      getSession: () => ({ kind: "bearer", token: "opaque-secret" }),
    },
    onDiagnostic: (error) => {
      diagnostics.push(error);
    },
  });
  try {
    for (mode of [401, 403, 503, 700, 701, 0]) {
      const result = await client.request({
        method: "POST",
        operation: "send",
        conversationId: "42",
        path: "/conversations/42/messages",
        body: { text: "private chat body" },
        options: { deadlineAt: Date.now() + (mode === 0 ? 40 : 2000) },
        schema: historyDtoSchema,
      });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("Expected failure");
      expect(result.error.diagnostic).toMatchObject({
        method: "POST",
        path: "/conversations/:id/messages",
      });
      expect(result.error.diagnostic?.elapsedMs).toBeGreaterThanOrEqual(0);
      if (mode === 0)
        expect(result.error.diagnostic).toMatchObject({
          outcome: "unknown",
          reasonCode: "deadline-exceeded",
        });
      else
        expect(result.error.diagnostic).toMatchObject({
          requestId: "req-actual",
          traceId: "trace-actual",
          httpStatus: mode >= 700 ? 200 : mode,
        });
    }
    expect(diagnostics).toHaveLength(6);
    expect(JSON.stringify(diagnostics)).not.toMatch(
      /opaque-secret|private chat|payload|Authorization/,
    );
  } finally {
    client.dispose();
    http.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      http.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

it("records real Socket.IO rejected joins with stable error identity and captured generation", async () => {
  const http = createServer();
  const sockets = new SocketServer(http, { transports: ["websocket"] });
  let accepted = false;
  sockets
    .of("/chat")
    .on("connection", (socket) =>
      socket.on(
        "join_conversation",
        (_input: unknown, ack: (value: unknown) => void) =>
          ack({ accepted, message: "private body" }),
      ),
    );
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  if (!address || typeof address === "string")
    throw new Error("No socket address");
  const origin = `http://127.0.0.1:${address.port}`;
  const diagnostics: ChatError[] = [];
  const updates: ChatUpdate[] = [];
  const gateway = createTFRobotChatGateway({
    baseUrl: origin,
    socketNamespaceUrl: `${origin}/chat`,
    messageCreatorProvider: () => ({ uid: "test", name: "Test" }),
    sessionProvider: {
      getSession: () => ({ kind: "bearer", token: "opaque-secret" }),
    },
    onDiagnostic: (error) => {
      diagnostics.push(error);
    },
  });
  try {
    const subscribed = await gateway.subscribe(
      { conversationId: "42", deadlineAt: Date.now() + 2000 },
      { next: (update) => updates.push(update) },
    );
    expect(subscribed.ok).toBe(false);
    expect(JSON.stringify(diagnostics)).not.toMatch(
      /opaque-secret|private body/,
    );
    expect(diagnostics).toHaveLength(1);
    expect(
      diagnostics.some(
        (error) =>
          error.diagnostic?.errorId &&
          error.diagnostic.generation !== undefined,
      ),
    ).toBe(true);
    accepted = true;
    const live = await gateway.subscribe(
      { conversationId: "42", deadlineAt: Date.now() + 2000 },
      { next: (update) => updates.push(update) },
    );
    expect(live.ok).toBe(true);
    diagnostics.length = 0;
    sockets.of("/chat").emit("error", { message: "private body" });
    await vi.waitFor(() => expect(diagnostics).toHaveLength(1));
    expect(diagnostics[0]?.diagnostic?.errorId).toBeDefined();
    expect(JSON.stringify(diagnostics)).not.toContain("private body");
  } finally {
    await gateway.dispose({ deadlineAt: Date.now() + 2000 });
    await new Promise<void>((resolve) => sockets.close(() => resolve()));
    if (http.listening)
      await new Promise<void>((resolve) => http.close(() => resolve()));
  }
});
