import { createServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { readFileSync } from "node:fs";
import { Server } from "socket.io";
const origin = process.env["TF_CHAT_MANAGER_ORIGIN"] ?? "http://127.0.0.1:4312";
const cert = process.env["TF_CHAT_MANAGER_CERT"];
const key = process.env["TF_CHAT_MANAGER_KEY"];
const account = {
  userId: "manager-user",
  accountId: "account",
  organizationId: "org",
};
let activeAccount = account;
let directoryStatus = 200;
let chatStatus = 200;
let historyStatus = 200;
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
      historyStatus = 200;
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
              accountName: "Word 测试组织",
            },
            {
              accountId: "other",
              organizationId: "other-org",
              accountName: "另一个组织",
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
        accountId: input.accountId,
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
      reply({
        accounts: [
          {
            accountId: "account",
            organizationId: "org",
            accountName: "Word 测试组织",
          },
          {
            accountId: "other",
            organizationId: "other-org",
            accountName: "另一个组织",
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
            page === 1
              ? {
                  id: "legacy",
                  robotId: "robot-a",
                  robotAccountId: "account-a",
                }
              : {
                  id: "alias",
                  robotId: "robot-b",
                  robotAccountId: "account-b",
                },
          ].map((r) => ({
            ...r,
            name: r.id,
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
        reply({
          code: 200,
          message: "Success",
          data: [{ platformId: 17, name: "Word fixture" }],
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
          (modern && (input.platformId !== 17 || url.search !== ""))
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
        reply({
          code: 200,
          message: "Success",
          data: { taskId: `run-${conversationId}` },
        });
        for (const io of sockets)
          io.of("/chat")
            .to(String(conversationId))
            .emit("chat_message", {
              msgId: `assistant-${conversationId}`,
              content: "Direct browser reply",
              conversationId,
              createTimestamp: Date.now(),
              role: "assistant",
              msgType: "text",
              additionalKwargs: {},
              attachments: null,
              creator: { uid: "robot", name: "Fixture", avatar: null },
            });
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
                : [],
            events: [],
            cursor: null,
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
