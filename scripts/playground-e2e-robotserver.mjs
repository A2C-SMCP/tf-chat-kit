import { createServer } from "node:http";

import { Server as SocketServer } from "socket.io";

const HOST = "127.0.0.1";
const PORT = 4310;
const PLAYGROUND_ORIGIN =
  process.env["TF_CHAT_PLAYGROUND_ORIGIN"] ?? "http://localhost:3000";
/** @typedef {{ conversationId: number; description: null; title: string; updateTimestamp: number }} ConversationDto */
/** @typedef {{ activeSockets: number; adminRequests: number; bearerRequests: number; contentTypeRequests: number; corsPreflights: number; interrupts: number; invalidOrigins: number; joins: number; passwordLogins: number; rejectedRest: { missing: number; wrong: number }; rejectedSockets: { missing: number; wrong: number }; routedRequests: number; socketConnections: number; socketDisconnections: number }} Observations */
/** @type {Map<string, ConversationDto>} */
const conversations = new Map();
/** @type {Map<string, Array<Record<string, unknown>>>} */
const messages = new Map();
/** @type {Map<string, Array<ReturnType<typeof setTimeout>>>} */
const timers = new Map();
let sequence = 1;
/** @type {Observations} */
let observations = {
  activeSockets: 0,
  adminRequests: 0,
  bearerRequests: 0,
  contentTypeRequests: 0,
  corsPreflights: 0,
  interrupts: 0,
  invalidOrigins: 0,
  joins: 0,
  passwordLogins: 0,
  rejectedRest: { missing: 0, wrong: 0 },
  rejectedSockets: { missing: 0, wrong: 0 },
  routedRequests: 0,
  socketConnections: 0,
  socketDisconnections: 0,
};

const reset = () => {
  for (const active of timers.values()) {
    for (const timer of active) clearTimeout(timer);
  }
  timers.clear();
  conversations.clear();
  messages.clear();
  sequence = 1;
  conversations.set("1", {
    conversationId: 1,
    description: null,
    title: "RobotServer fixture conversation",
    updateTimestamp: Date.now(),
  });
  messages.set("1", []);
  observations = {
    activeSockets: 0,
    adminRequests: 0,
    bearerRequests: 0,
    contentTypeRequests: 0,
    corsPreflights: 0,
    interrupts: 0,
    invalidOrigins: 0,
    joins: 0,
    passwordLogins: 0,
    rejectedRest: { missing: 0, wrong: 0 },
    rejectedSockets: { missing: 0, wrong: 0 },
    routedRequests: 0,
    socketConnections: 0,
    socketDisconnections: 0,
  };
};
reset();

const corsHeaders = {
  "Access-Control-Allow-Headers": "Authorization, admin_key, Content-Type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Origin": PLAYGROUND_ORIGIN,
};
/**
 * @param {import("node:http").ServerResponse} response
 * @param {number} status
 * @param {unknown} data
 */
const sendJson = (response, status, data) => {
  response.writeHead(status, {
    ...corsHeaders,
    "Content-Type": "application/json",
  });
  response.end(JSON.stringify(data));
};
/** @param {import("node:http").ServerResponse} response @param {unknown} data */
const envelope = (response, data) =>
  sendJson(response, 200, { code: 200, data, message: "Success" });
/** @param {import("node:http").ServerResponse} response @param {number} status @param {string} message */
const error = (response, status, message) =>
  sendJson(response, status, { detail: message });
/** @param {import("node:http").IncomingMessage} request @returns {Promise<Record<string, any>>} */
const readBody = async (request) => {
  /** @type {Buffer[]} */
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
};
/** @param {import("node:http").IncomingMessage} request @returns {"admin" | "bearer" | 401 | 403} */
const authentication = (request) => {
  const authorization = request.headers.authorization;
  const adminKey = request.headers["admin_key"];
  if (authorization === "Bearer bearer-good") {
    observations.bearerRequests += 1;
    return "bearer";
  }
  if (adminKey === "admin-good") {
    observations.adminRequests += 1;
    return "admin";
  }
  const missing = authorization === undefined && adminKey === undefined;
  observations.rejectedRest[missing ? "missing" : "wrong"] += 1;
  return missing ? 401 : 403;
};
/** @param {string} pathname */
const conversationIdOf = (pathname) =>
  pathname.match(/^\/v1\/chat\/conversations\/([^/]+)\//u)?.[1];

const httpServer = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://${HOST}:${PORT}`);
  if (url.pathname === "/__test/ready") {
    sendJson(response, 200, { ready: true });
    return;
  }
  if (url.pathname === "/__test/reset" && request.method === "POST") {
    chat.disconnectSockets(true);
    reset();
    sendJson(response, 200, { reset: true });
    return;
  }
  if (url.pathname === "/__test/state") {
    sendJson(response, 200, {
      conversations: [...conversations.values()].map(({ title }) => title),
      observations,
    });
    return;
  }
  if (request.method === "OPTIONS") {
    observations.corsPreflights += 1;
    if (request.headers.origin !== PLAYGROUND_ORIGIN) {
      observations.invalidOrigins += 1;
      error(response, 403, "Origin rejected");
      return;
    }
    response.writeHead(204, corsHeaders);
    response.end();
    return;
  }
  const hasRoutingHeaders =
    request.headers["x-tf-namespace"] === "e2e-ns" &&
    request.headers["x-tf-robotid"] === "e2e-robot" &&
    request.headers["x-tf-robottype"] === "tfrobot";
  if (request.headers.origin !== PLAYGROUND_ORIGIN && !hasRoutingHeaders) {
    observations.invalidOrigins += 1;
    error(response, 403, "Origin rejected");
    return;
  }
  if (url.pathname === "/v1/auth/login" && request.method === "POST") {
    if (!hasRoutingHeaders) {
      error(response, 422, "Robot routing headers are required");
      return;
    }
    const body = await readBody(request);
    if (body["password"] !== "password-good") {
      error(response, 401, "Wrong administrator password");
      return;
    }
    observations.passwordLogins += 1;
    observations.routedRequests += 1;
    envelope(response, {
      accessToken: "admin-good",
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    return;
  }
  const auth = authentication(request);
  if (typeof auth === "number") {
    error(
      response,
      auth,
      auth === 401 ? "Authentication required" : "Forbidden",
    );
    return;
  }
  if (!hasRoutingHeaders) {
    error(response, 422, "Robot routing headers are required");
    return;
  }
  observations.routedRequests += 1;
  if (request.headers["content-type"] === "application/json") {
    observations.contentTypeRequests += 1;
  }

  if (url.pathname === "/v1/chat/conversations") {
    if (url.searchParams.get("platformId") !== "platform-e2e") {
      error(response, 422, "platformId is required");
      return;
    }
    if (request.method === "GET") {
      envelope(response, {
        conversations: [...conversations.values()],
        cursor: null,
      });
      return;
    }
    if (request.method === "POST") {
      const id = String(++sequence);
      const conversation = {
        conversationId: Number(id),
        description: null,
        title: url.searchParams.get("title") ?? "Untitled",
        updateTimestamp: Date.now(),
      };
      conversations.set(id, conversation);
      messages.set(id, []);
      envelope(response, conversation);
      return;
    }
  }

  const conversationId = conversationIdOf(url.pathname);
  if (conversationId === undefined || !conversations.has(conversationId)) {
    error(response, 404, "Conversation not found");
    return;
  }
  if (request.method === "GET" && url.pathname.endsWith("/messages")) {
    envelope(response, {
      cursor: null,
      events: [
        {
          content: "RobotServer 正式事件详情",
          conversationId: Number(conversationId),
          createTimestamp: 1_773_705_600_000 + Number(conversationId),
          eventId: `playground-event-${conversationId}`,
          eventScene: "Chain",
          exception: null,
          status: "success",
        },
      ],
      messages: messages.get(conversationId),
    });
    return;
  }
  if (request.method === "GET" && url.pathname.endsWith("/status")) {
    envelope(response, { taskId: null, working: false });
    return;
  }
  if (request.method === "POST" && url.pathname.endsWith("/messages")) {
    const body = await readBody(request);
    if (
      body["creator"]?.uid !== "current-user" ||
      body["creator"]?.name !== "CurrentUser"
    ) {
      error(response, 422, "Creator rejected");
      return;
    }
    const taskId = `task-${Date.now()}`;
    messages.get(conversationId)?.push({
      ...body,
      createTimestamp: Date.now(),
      msgId: `user-${Date.now()}`,
    });
    envelope(response, { taskId });
    const workingTimer = setTimeout(() => {
      io.of("/chat").to(conversationId).emit("conversation_state_changed", {
        conversationId,
        state: "working",
        taskId,
      });
    }, 20);
    const assistantTimer = setTimeout(() => {
      io.of("/chat")
        .to(conversationId)
        .emit("chat_message", {
          additionalKwargs: {},
          attachments: null,
          content: `RobotServer streamed: ${String(body["content"])}`,
          conversationId,
          createTimestamp: Date.now(),
          creator: { avatar: null, name: "RobotServer", uid: "robot" },
          msgId: `assistant-${Date.now()}`,
          msgType: "text",
          role: "assistant",
        });
    }, 180);
    const completionTimer = setTimeout(() => {
      io.of("/chat").to(conversationId).emit("conversation_state_changed", {
        conversationId,
        state: "idle",
        taskId,
      });
      timers.delete(conversationId);
    }, 600);
    timers.set(conversationId, [workingTimer, assistantTimer, completionTimer]);
    return;
  }
  if (request.method === "POST" && url.pathname.endsWith("/interrupt")) {
    const body = await readBody(request);
    observations.interrupts += 1;
    for (const timer of timers.get(conversationId) ?? []) clearTimeout(timer);
    timers.delete(conversationId);
    io.of("/chat").to(conversationId).emit("conversation_state_changed", {
      conversationId,
      state: "idle",
      taskId: body["taskId"],
    });
    envelope(response, { taskId: body["taskId"] });
    return;
  }
  error(response, 404, "Route not found");
});

const io = new SocketServer(httpServer, {
  cors: { methods: ["GET", "POST"], origin: PLAYGROUND_ORIGIN },
  path: "/c/tfrobot/e2e-ns/e2e-robot/socket.io",
  transports: ["websocket"],
});
const chat = io.of("/chat");
chat.use((socket, next) => {
  const { admin_key: adminKey, token } = socket.handshake.auth;
  if (token === "bearer-good" || adminKey === "admin-good") {
    next();
    return;
  }
  const missing = token === undefined && adminKey === undefined;
  observations.rejectedSockets[missing ? "missing" : "wrong"] += 1;
  const rejection = Object.assign(
    new Error(missing ? "Authentication required" : "Forbidden"),
    { data: { status: missing ? 401 : 403 } },
  );
  next(rejection);
});
chat.on("connection", (socket) => {
  observations.activeSockets += 1;
  observations.socketConnections += 1;
  socket.on("join_conversation", ({ conversation_id: conversationId }) => {
    observations.joins += 1;
    void socket.join(String(conversationId));
  });
  socket.on("disconnect", () => {
    observations.activeSockets -= 1;
    observations.socketDisconnections += 1;
  });
});

httpServer.listen(PORT, HOST);
const shutdown = () => {
  for (const active of timers.values()) {
    for (const timer of active) clearTimeout(timer);
  }
  void io.close(() => httpServer.close(() => process.exit(0)));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
