import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { readFileSync } from "node:fs";
import { Server } from "socket.io";
const origin = process.env["TF_CHAT_MANAGER_ORIGIN"] ?? "http://127.0.0.1:4312";
const cert = process.env["TF_CHAT_MANAGER_CERT"];
const key = process.env["TF_CHAT_MANAGER_KEY"];
/** DTOs exported by the real Server converter in the generated-text integration test. */
/** @type {Array<Record<string, unknown> & {eventId: string}>} */
const generatedEvents = JSON.parse(
  readFileSync(
    new URL("../fixtures/tfrs-generated-text.json", import.meta.url),
    "utf8",
  ),
);
let generatedTextEvents = false;
let generatedLive = false;
const account = {
  userId: "manager-user",
  accountId: "account",
  organizationId: "org",
};
/** @type {{userId: string; accountId: string; organizationId: string; organizationName?: string; displayName?: string}} */
let activeAccount = account;
let directoryStatus = 200;
let chatStatus = 200;
let historyStatus = 200;
let accountsStatus = 200;
/** @type {string | undefined} */
let accountDisplayName;
/** @type {string | undefined} */
let organizationDisplayName;
/** @type {string | undefined} */
let robotDisplayName;
let platformsStatus = 200;
let switchAccountStatus = 200;
let authorMismatch = false;
let serverMessageIds = false;
let holdMessageEcho = false;
let conversationFailures = false;
/** @type {Array<() => void>} */
const heldMessageEchoes = [];
/** @type {Map<number, import("../packages/chat-gateway-tfrobot/src/dto.js").MessageDto[]>} */
const messageHistory = new Map();
let platforms = [{ platformId: 17, name: "Word fixture" }];
let nextConversation = 43;
/** @type {Map<number, {conversationId: number; title: string; updateTimestamp: number}>} */
const createdConversations = new Map();
/** @type {(handler: import("node:http").RequestListener) => import("node:http").Server | import("node:https").Server} */
const createListener =
  cert && key
    ? (handler) =>
        createHttpsServer(
          { cert: readFileSync(cert), key: readFileSync(key) },
          handler,
        )
    : createServer;
const server = createListener((req, res) => {
  const url = new URL(req.url ?? "/", origin);
  const cors = {
    "Access-Control-Allow-Origin":
      process.env["TF_CHAT_PLAYGROUND_ORIGIN"] ?? "http://localhost:4311",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
  };
  /** @param {unknown} data @param {number} [status] */
  const reply = (data, status = 200) => {
    res.writeHead(status, { ...cors, "Content-Type": "application/json" });
    res.end(JSON.stringify(data));
  };
  if (req.method === "OPTIONS") {
    res.writeHead(204, cors);
    res.end();
    return;
  }
  if (url.pathname === "/ready") {
    reply({ ready: true });
    return;
  }
  let body = "";
  req.on("data", (chunk) => {
    body += chunk.toString();
  });
  req.on("end", () => {
    if (url.pathname === "/__test/ui-options") {
      const input = JSON.parse(body);
      if (input.generatedTextEvents !== undefined)
        generatedTextEvents = input.generatedTextEvents;
      if (input.platforms !== undefined) platforms = input.platforms;
      if (input.platformsStatus !== undefined)
        platformsStatus = input.platformsStatus;
      if (input.accountsStatus !== undefined)
        accountsStatus = input.accountsStatus;
      if (input.switchAccountStatus !== undefined)
        switchAccountStatus = input.switchAccountStatus;
      if (input.accountName !== undefined)
        accountDisplayName = input.accountName;
      if (input.organizationName !== undefined)
        organizationDisplayName = input.organizationName;
      if (input.robotName !== undefined) robotDisplayName = input.robotName;
      if (input.authorMismatch !== undefined)
        authorMismatch = input.authorMismatch;
      if (input.serverMessageIds !== undefined)
        serverMessageIds = input.serverMessageIds;
      if (input.conversationFailures !== undefined)
        conversationFailures = input.conversationFailures;
      if (input.holdMessageEcho !== undefined)
        holdMessageEcho = input.holdMessageEcho;
      reply({});
      return;
    }
    if (url.pathname === "/__test/generated-text") {
      generatedLive = true;
      for (const io of sockets) {
        for (let index = 0; index < 3; index++)
          io.of("/chat")
            .to("42")
            .emit(
              "chat_event",
              generatedEvents.find((event) => event.eventId === "mixed"),
            );
      }
      reply({});
      return;
    }
    if (url.pathname === "/__test/conversation-failure") {
      for (const io of sockets)
        io.of("/chat").to("42").emit("chat_error", {
          conversationId: 42,
          error: "实时运行失败：请拆分问题。",
          createTimestamp: Date.now(),
          code: "future.code",
        });
      reply({});
      return;
    }
    if (url.pathname === "/__test/release-message-echo") {
      for (const emit of heldMessageEchoes.splice(0)) emit();
      reply({});
      return;
    }
    if (url.pathname === "/__test/history-status") {
      historyStatus = Number(JSON.parse(body).status);
      reply({});
      return;
    }
    if (url.pathname === "/__test/chat-status") {
      chatStatus = Number(JSON.parse(body).status);
      reply({});
      return;
    }
    if (url.pathname === "/__test/directory-status") {
      directoryStatus = Number(JSON.parse(body).status);
      reply({});
      return;
    }
    if (url.pathname === "/auth/login-by-password") {
      directoryStatus = 200;
      chatStatus = 200;
      generatedTextEvents = false;
      generatedLive = false;
      historyStatus = 200;
      accountsStatus = 200;
      accountDisplayName = undefined;
      organizationDisplayName = undefined;
      robotDisplayName = undefined;
      platformsStatus = 200;
      switchAccountStatus = 200;
      authorMismatch = false;
      serverMessageIds = false;
      holdMessageEcho = false;
      conversationFailures = false;
      heldMessageEchoes.length = 0;
      platforms = [{ platformId: 17, name: "Word fixture" }];
      activeAccount = account;
      const input = JSON.parse(body);
      if (input.password === "invalid") {
        reply({ message: "private-fixture-detail" }, 401);
        return;
      }
      if (input.phone === "ui")
        reply({
          tempToken: "ui-selection",
          accounts: [
            {
              accountId: "account",
              organizationId: "org",
              organizationName: "Word 测试组织",
              accountName: "测试账户",
            },
            {
              accountId: "other",
              organizationId: "other-org",
              organizationName: "另一个组织",
              accountName: "其他账户",
            },
          ],
        });
      else reply({ token: "manager-browser", account });
      return;
    }
    if (url.pathname === "/auth/select-account") {
      const input = JSON.parse(body);
      activeAccount = {
        ...account,
        ...(accountDisplayName === undefined
          ? {}
          : { displayName: accountDisplayName }),
        accountId: input.accountId,
        organizationName:
          organizationDisplayName ??
          (input.accountId === "account" ? "Word 测试组织" : "另一个组织"),
        organizationId: input.accountId === "account" ? "org" : "other-org",
      };
      reply({ token: "manager-browser", account: activeAccount });
      return;
    }
    const isExchange = url.pathname === "/api/v1/oauth/token";
    const isChat =
      /^(?:\/api|\/c\/tfrobot\/(?:tenant\/)?robot-[ab])?\/v1\/chat\//u.test(
        url.pathname,
      );
    if (
      !isExchange &&
      req.headers.authorization !==
        `Bearer ${isChat ? "robot-browser" : "manager-browser"}`
    ) {
      reply({ message: "Unauthorized" }, 401);
      return;
    }
    if (url.pathname === "/api/v1/accounts/my") {
      if (accountsStatus !== 200) {
        reply({}, accountsStatus);
        return;
      }
      reply({
        accounts: [
          {
            accountId: "account",
            organizationId: "org",
            organizationName: organizationDisplayName ?? "Word 测试组织",
            accountName: "测试账户",
          },
          {
            accountId: "other",
            organizationId: "other-org",
            organizationName: "另一个组织",
            accountName: "其他账户",
          },
        ],
      });
      return;
    }
    if (url.pathname === "/api/v1/auth/logout") {
      reply({});
      return;
    }
    if (url.pathname === "/api/v1/auth/me") {
      reply(activeAccount);
      return;
    }
    if (url.pathname === "/api/v1/auth/switch-account") {
      if (switchAccountStatus !== 200) {
        reply({}, switchAccountStatus);
        return;
      }
      const input = JSON.parse(body);
      activeAccount = {
        ...account,
        accountId: String(input.accountId),
        organizationId: `org-${String(input.accountId)}`,
      };
      reply({ token: "manager-browser", account: activeAccount });
      return;
    }
    if (url.pathname === "/api/v1/digital-employees") {
      if (directoryStatus !== 200) {
        reply({ message: "private-fixture-detail" }, directoryStatus);
        return;
      }
      const page = Number(url.searchParams.get("page")),
        pageSize = Number(url.searchParams.get("pageSize"));
      reply({
        code: 200,
        data: {
          items: [
            { id: "legacy", robotId: "robot-a", robotAccountId: "account-a" },
            { id: "alias", robotId: "robot-b", robotAccountId: "account-b" },
          ]
            .slice((page - 1) * pageSize, page * pageSize)
            .map((r) => ({
              ...r,
              name: r.id === "legacy" ? (robotDisplayName ?? r.id) : r.id,
              status: "running",
              templateType: "tfrserver",
            })),
          page,
          pageSize,
          total: 2,
        },
      });
      return;
    }
    if (url.pathname.endsWith("/connection-info")) {
      const alias = url.pathname.includes("/alias/");
      reply({
        code: 200,
        data: {
          socketBaseURL: origin,
          namespace: "tenant",
          rid: alias ? "robot-b" : "robot-a",
          robotType: "tfrobot",
          sioPath: alias ? "/c/tfrobot/robot-b/socket.io/" : "/socket.io/",
        },
      });
      return;
    }
    if (isExchange) {
      const form = new URLSearchParams(body);
      if (
        form.get("subject_token") !== "manager-browser" ||
        !["robot:account-a", "robot:account-b"].includes(
          form.get("audience") ?? "",
        )
      ) {
        reply({}, 403);
        return;
      }
      reply({
        access_token: "robot-browser",
        token_type: "Bearer",
        issued_token_type: "urn:ietf:params:oauth:token-type:jwt",
        expires_in: 40,
      });
      return;
    }
    if (isChat) {
      if (req.headers.cookie !== undefined) {
        reply({}, 400);
        return;
      }
      if (req.method === "GET" && url.pathname.endsWith("/platforms")) {
        if (platformsStatus !== 200) {
          reply({}, platformsStatus);
          return;
        }
        reply({
          code: 200,
          message: "Success",
          data: platforms,
        });
        return;
      }
      const conversationId = Number(
        url.pathname.match(/conversations\/(\d+)/u)?.[1],
      );
      if (req.method === "POST" && url.pathname.endsWith("/conversations")) {
        const modern = body.length > 0;
        const input = modern ? JSON.parse(body) : undefined;
        const title = modern ? input.title : url.searchParams.get("title");
        if (
          !title ||
          (modern &&
            (!platforms.some(
              (platform) => platform.platformId === input.platformId,
            ) ||
              url.search !== ""))
        ) {
          reply({}, 422);
          return;
        }
        const created = {
          conversationId: nextConversation++,
          title,
          updateTimestamp: Date.now(),
        };
        createdConversations.set(created.conversationId, created);
        reply({ code: 200, message: "Success", data: created });
        return;
      }
      if (req.method === "POST" && url.pathname.endsWith("/messages")) {
        if (chatStatus !== 200) {
          reply({ message: "private-fixture-detail" }, chatStatus);
          return;
        }
        const message = JSON.parse(body);
        if (
          !createdConversations.has(conversationId) ||
          (message.content !== "Browser round trip" &&
            !String(message.content).startsWith("UI long text:")) ||
          message.creator?.uid !== "manager-user"
        ) {
          reply({}, 422);
          return;
        }
        const elementId = serverMessageIds ? randomUUID() : undefined;
        reply({
          code: 200,
          message: "Success",
          data: {
            taskId: `run-${conversationId}`,
            ...(elementId === undefined ? {} : { elementId }),
          },
        });
        const timestamp = Date.now();
        const saved = messageHistory.get(conversationId) ?? [];
        const sequence = saved.length;
        const assistant = {
          msgId: authorMismatch
            ? `assistant-${conversationId}-${sequence}`
            : `assistant-${conversationId}`,
          content: "Direct browser reply",
          conversationId,
          createTimestamp: timestamp + 1,
          role: "assistant",
          msgType: "text",
          additionalKwargs: {},
          attachments: null,
          creator: { uid: "robot", name: "Fixture", avatar: null },
        };
        /** @type {Array<import("../packages/chat-gateway-tfrobot/src/dto.js").MessageDto>} */
        const echoes = [];
        if (authorMismatch || serverMessageIds) {
          const user = {
            ...assistant,
            ...(elementId === undefined ? {} : { elementId }),
            msgId: `user-${conversationId}-${sequence}`,
            role: "user",
            content: message.content,
            createTimestamp: timestamp,
            creator: { uid: "manager-user", name: "Word user", avatar: null },
          };
          saved.push(user, assistant);
          messageHistory.set(conversationId, saved);
          echoes.push({
            ...user,
            msgId: null,
            creator: { uid: "admin", name: "Admin", avatar: null },
          });
        }
        echoes.push(assistant);
        const emit = () => {
          for (const message of echoes)
            for (const io of sockets)
              io.of("/chat")
                .to(String(conversationId))
                .emit("chat_message", message);
        };
        if (holdMessageEcho) heldMessageEchoes.push(emit);
        else emit();
        return;
      }
      if (req.method === "PATCH" && createdConversations.has(conversationId)) {
        const item = createdConversations.get(conversationId);
        if (!item) {
          reply({}, 404);
          return;
        }
        Object.assign(item, { title: JSON.parse(body).title });
        reply({ code: 200, message: "Success", data: item });
        return;
      }
      if (req.method === "DELETE") {
        if (!createdConversations.delete(conversationId)) {
          reply({}, 404);
          return;
        }
        messageHistory.delete(conversationId);
        reply({
          code: 200,
          message: "Success",
          data: { conversationId, message: "deleted" },
        });
        return;
      }
      if (
        req.method === "GET" &&
        url.pathname.endsWith("/conversations") &&
        historyStatus !== 200
      ) {
        reply({}, historyStatus);
        return;
      }
      const data = url.pathname.endsWith("/messages")
        ? {
            messages:
              conversationId === 42
                ? [
                    {
                      msgId: "existing-private",
                      content: "Persisted private reply",
                      conversationId: 42,
                      createTimestamp: Date.now(),
                      role: "assistant",
                      msgType: "text",
                      additionalKwargs: {},
                      attachments: null,
                      creator: { uid: "robot", name: "Fixture", avatar: null },
                    },
                  ]
                : url.searchParams.has("cursor")
                  ? []
                  : (messageHistory.get(conversationId) ?? []),
            errors:
              conversationFailures && conversationId === 42
                ? [
                    {
                      id: "saved-token-error",
                      conversationId: 42,
                      error:
                        "当前 Chain 的 Token 使用量 139132 超过最大限制 128000。请拆分问题。",
                      code: null,
                      createTimestamp: Date.now(),
                      message: {
                        msgId: "failed-user-input",
                        conversationId: 42,
                        role: "user",
                        msgType: "text",
                        content: "我选中的文字加粗",
                        createTimestamp: Date.now() - 100,
                      },
                    },
                  ]
                : [],
            events:
              generatedTextEvents && conversationId === 42
                ? generatedEvents.filter(
                    (event) => generatedLive || event.eventId !== "mixed",
                  )
                : [],
            cursor:
              messageHistory.has(conversationId) &&
              !url.searchParams.has("cursor")
                ? "nonempty-oldest-message"
                : null,
          }
        : url.pathname.endsWith("/status")
          ? { working: false, taskId: null }
          : {
              conversations: [
                ...createdConversations.values(),
                {
                  conversationId: 42,
                  title: "Manager browser fixture",
                  updateTimestamp: Date.now(),
                },
              ],
              cursor: "next-page",
            };
      reply({ code: 200, message: "Success", data });
      return;
    }
    reply({}, 404);
  });
});
const sockets = [
  "/c/tfrobot/tenant/robot-a/socket.io/",
  "/c/tfrobot/robot-b/socket.io/",
].map((path) => {
  const io = new Server(server, {
    path,
    transports: ["websocket"],
    destroyUpgrade: false,
  });
  io.of("/chat").use((socket, next) =>
    next(
      socket.handshake.auth["token"] === "robot-browser"
        ? undefined
        : new Error("Forbidden"),
    ),
  );
  io.of("/chat").on("connection", (socket) => {
    socket.on("join_conversation", async (input, ack) => {
      await socket.join(String(input.conversation_id));
      ack();
    });
  });
  return io;
});
server.listen(4312, "127.0.0.1");
const stop = () => {
  for (const io of sockets) void io.close();
  server.closeAllConnections();
  server.close(() => process.exit(0));
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
