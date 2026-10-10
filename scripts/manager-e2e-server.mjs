import { createServer } from "node:http";
import { Server } from "socket.io";
const origin = "http://127.0.0.1:4312";
const account = {
  userId: "manager-user",
  accountId: "account",
  organizationId: "org",
};
let activeAccount = account;
const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", origin);
  const cors = {
    "Access-Control-Allow-Origin":
      process.env["TF_CHAT_PLAYGROUND_ORIGIN"] ?? "http://localhost:4311",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
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
    if (url.pathname === "/auth/login-by-password") {
      reply({ token: "manager-browser", account });
      return;
    }
    const isExchange = url.pathname === "/api/v1/oauth/token";
    const isChat = /^(?:\/api)?\/v1\/chat\//u.test(url.pathname);
    if (
      !isExchange &&
      req.headers.authorization !==
        `Bearer ${isChat ? "robot-browser" : "manager-browser"}`
    ) {
      reply({ message: "Unauthorized" }, 401);
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
      const data = url.pathname.endsWith("/messages")
        ? { messages: [], events: [], cursor: null }
        : url.pathname.endsWith("/status")
          ? { working: false, taskId: null }
          : {
              conversations: [
                {
                  conversationId: 42,
                  title: "Manager browser fixture",
                  updateTimestamp: Date.now(),
                },
              ],
              cursor: null,
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
    socket.on("join_conversation", (_input, ack) => ack());
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
