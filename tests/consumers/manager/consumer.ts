import { createServer } from "node:http";
import { Server } from "socket.io";
import { createAuthClient } from "@turingfocus/chat-auth/headless";
import {
  createManagerClient,
  type ManagerRobot,
} from "@turingfocus/chat-auth/manager";
import { createManagerChatController } from "@turingfocus/chat-kit/manager";

const check = (value: unknown, message: string): void => {
  if (!value) throw new Error(message);
};
/** Independent packed Web and Office-style headless consumers share real wire assertions. */
export const runManagerConsumerVerification = async (
  host: "web" | "office" = "web",
): Promise<void> => {
  for (const format of ["legacy", "alias"] as const) {
    const socketPath =
      format === "legacy"
        ? "/c/tfrobot/tenant/robot-a/socket.io/"
        : "/c/tfrobot/robot-a/socket.io/";
    const chatPrefix = host === "web" ? "/api" : "";
    const wire: string[] = [],
      handshakes: string[] = [];
    let origin = "",
      exchanges = 0;
    const server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk: Buffer) => {
        body += chunk.toString();
      });
      request.on("end", () => {
        const url = new URL(request.url ?? "/", "http://localhost");
        const reply = (data: unknown, status = 200) => {
          response.writeHead(status, { "Content-Type": "application/json" });
          response.end(
            JSON.stringify({
              code: status,
              message: status === 200 ? "Success" : "Fixture error",
              data,
            }),
          );
        };
        if (url.pathname === "/api/v1/digital-employees") {
          check(
            request.headers.authorization === "Bearer manager-only",
            "Directory Manager credential missing",
          );
          const page = Number(url.searchParams.get("page"));
          reply({
            items: [
              {
                id: page,
                name: `Robot ${page}`,
                robotId: page === 1 ? "robot-a" : "robot-b",
                robotAccountId: `account-${page}`,
                status: "running",
                templateType: "tfrserver",
              },
            ],
            total: 2,
            page,
            pageSize: 1,
          });
        } else if (url.pathname.endsWith("/connection-info")) {
          check(
            request.headers.authorization === "Bearer manager-only",
            "Connection Manager credential missing",
          );
          reply({
            socketBaseURL: origin,
            namespace: "tenant",
            rid: "robot-a",
            robotType: "tfrobot",
            sioPath: format === "legacy" ? "/socket.io/" : socketPath,
          });
        } else if (url.pathname === "/api/v1/oauth/token") {
          const form = new URLSearchParams(body);
          check(
            form.get("audience") === "robot:account-1",
            "Wrong token audience",
          );
          check(
            form.get("subject_token") === "manager-only",
            "Wrong subject token",
          );
          exchanges++;
          response.writeHead(200, { "Content-Type": "application/json" });
          response.end(
            JSON.stringify({
              access_token: "robot-only",
              token_type: "Bearer",
              issued_token_type: "urn:ietf:params:oauth:token-type:jwt",
              expires_in: 3600,
            }),
          );
        } else if (url.pathname.startsWith(`${chatPrefix}/v1/chat/`)) {
          check(
            request.headers.authorization === "Bearer robot-only",
            "Robot received Manager credential or missing exchanged token",
          );
          wire.push(url.pathname);
          if (url.pathname.endsWith("/messages"))
            reply({ messages: [], events: [], cursor: null });
          else if (url.pathname.endsWith("/status"))
            reply({ working: false, taskId: null });
          else
            reply({
              conversations: [
                {
                  conversationId: 42,
                  title: "Fixture",
                  updateTimestamp: Date.now(),
                },
              ],
              cursor: null,
            });
        } else reply(null, 404);
      });
    });
    const sockets = new Server(server, {
      path: socketPath,
      transports: ["websocket"],
    });
    sockets.of("/chat").on("connection", (socket) => {
      check(
        socket.handshake.auth["token"] === "robot-only",
        "Socket did not use exchanged token",
      );
      handshakes.push(socketPath);
      socket.on("join_conversation", (_input, ack: () => void) => ack());
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Missing port");
    origin = `http://127.0.0.1:${address.port}`;
    const identity = {
      userId: "user",
      accountId: "account",
      organizationId: "org",
    };
    const auth = createAuthClient({
      environment: "staging",
      transport: {
        login: async () => ({ kind: "authenticated", account: identity }),
        selectAccount: async () => ({
          kind: "authenticated",
          account: identity,
        }),
        listAccounts: async () => [identity],
        getCurrentAccount: async () => identity,
        switchAccount: async (accountId) => ({ ...identity, accountId }),
        getSession: async () => ({ kind: "bearer", token: "manager-only" }),
        logout: async () => {},
      },
    });
    await auth.login({ identifier: "fixture", password: "transient" });
    const manager = createManagerClient({
      auth,
      baseUrl: origin,
      fetch: globalThis.fetch,
      routing: {
        allowedOrigins: [origin],
        http:
          host === "web"
            ? { kind: "bff", baseUrl: `${origin}/api` }
            : { kind: "direct" },
      },
    });
    const controller = createManagerChatController<ManagerRobot>({
      manager,
      chat: {
        messageCreatorProvider: () => ({ name: "Fixture", uid: "user" }),
        serverProfile: { kind: "current-server" },
      },
    });
    try {
      const page = await manager.loadPage(1, 1);
      check(page.hasMore, "Pagination lost");
      await manager.loadPage(2, 1);
      check(manager.getSnapshot().items.length === 2, "Second page lost");
      await controller.select(page.items[0]);
      const chat = controller.getSnapshot().client;
      check(chat, "No public chat client");
      if (!chat) throw new Error("No chat client");
      check(
        (await chat.listConversations({ deadlineAt: Date.now() + 5000 })).ok,
        "REST failed",
      );
      check(
        (
          await chat.loadConversation({
            conversationId: "42",
            deadlineAt: Date.now() + 5000,
          })
        ).ok,
        "Socket/chat load failed",
      );
      check(
        wire.length >= 2 && handshakes.length === 1 && exchanges === 1,
        "Wire lifecycle incomplete",
      );
      // A cancelled directory operation must not release the selected chat.
      const aborted = new AbortController();
      aborted.abort();
      await manager
        .loadPage(1, 1, { signal: aborted.signal })
        .catch(() => undefined);
      check(
        controller.getSnapshot().client === chat && !chat.disposed,
        "Directory cancellation disposed chat",
      );
      manager.cancel();
      check(
        controller.getSnapshot().client === chat,
        "Manager cancellation changed identity",
      );
      await auth.switchAccount("other");
      check(
        controller.getSnapshot().client === undefined,
        "Identity retained old chat",
      );
      await controller.dispose();
      check(chat.disposed, "Old client leaked");
      check(
        !JSON.stringify(manager.getSnapshot()).includes("robot-only"),
        "Credential leaked to snapshot",
      );
    } finally {
      await controller.dispose();
      await manager.dispose();
      await auth.dispose();
      await new Promise<void>((resolve) => sockets.close(() => resolve()));
      server.closeAllConnections();
      if (server.listening)
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
};
