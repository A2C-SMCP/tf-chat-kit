import { createServer } from "node:http";
import { Server } from "socket.io";
import {
  createAuthClient,
  type AuthClient,
} from "@turingfocus/chat-auth/headless";
import { createTfRobotAuthTransport } from "@turingfocus/chat-auth/tfrobot";
import {
  createTFRobotChatClient,
  type ChatClient,
} from "@turingfocus/chat-kit/headless";

const check = (value: unknown, message: string): void => {
  if (!value) throw new Error(message);
};
const deadlineAt = () => Date.now() + 8_000;
const identity = (accountId: string) => ({
  userId: 9,
  accountId,
  organizationId: `org-${accountId}`,
});
const credential = (accountId: string) => `packed-fixture-${accountId}`;
const message = (accountId: string, content: string, id = "history") => ({
  msgId: `${accountId}-${id}`,
  content,
  additionalKwargs: {},
  attachments: null,
  createTimestamp: 1_773_705_600_000,
  creator: { uid: "9", name: "Packed user", avatar: null },
  conversationId: 42,
  role: "assistant",
  msgType: "text",
});

export interface AuthChatConsumerView {
  render(auth: AuthClient, chat: ChatClient): Promise<void>;
  assertText(text: string): void;
  close(): Promise<void>;
}

/** Runs public tarball boundaries against actual TCP HTTP and Socket.IO. */
export const runAuthChatConsumerVerification = async (
  view?: AuthChatConsumerView,
): Promise<void> => {
  const requests: Array<{ accountId: string; method: string; path: string }> =
    [];
  const socketAccounts: string[] = [];
  let releaseHeld: (() => void) | undefined;
  let heldStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    heldStarted = resolve;
  });
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });
    request.on("end", () => {
      const path = new URL(request.url ?? "/", "http://localhost").pathname;
      const input =
        body === "" ? {} : (JSON.parse(body) as { accountId?: string });
      const accountId =
        request.headers.authorization === `Bearer ${credential("b")}`
          ? "b"
          : "a";
      const reply = (data: unknown, status = 200) => {
        if (response.writableEnded || response.destroyed) return;
        response.writeHead(status, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify({
            code: status,
            message: status === 200 ? "Success" : "Unauthorized",
            data,
          }),
        );
      };
      if (path === "/auth/login-by-password") {
        reply({ ...identity("a"), token: credential("a") });
        return;
      }
      if (request.headers.authorization !== `Bearer ${credential(accountId)}`) {
        reply(null, 401);
        return;
      }
      if (path === "/api/v1/auth/me") reply(identity(accountId));
      else if (path === "/api/v1/auth/switch-account") {
        const next = input.accountId ?? "b";
        reply({ ...identity(next), token: credential(next) });
      } else if (path === "/api/v1/accounts/my")
        reply({ accounts: [identity("a"), identity("b")] });
      else {
        requests.push({ accountId, method: request.method ?? "", path });
        if (path.endsWith("/status")) reply({ working: false, taskId: null });
        else if (path.endsWith("/messages") && request.method === "POST")
          reply({ taskId: `run-${accountId}` });
        else if (path.endsWith("/43/messages")) {
          releaseHeld = () => reply({ messages: [], events: [], cursor: null });
          heldStarted();
        } else if (path.endsWith("/messages"))
          reply({
            messages: [message(accountId, `History ${accountId}`)],
            events: [],
            cursor: null,
          });
        else if (path.endsWith("/conversations"))
          reply({
            conversations: [
              {
                conversationId: 42,
                title: `Conversation ${accountId}`,
                description: null,
                updateTimestamp: 1_773_705_600_000,
              },
            ],
            cursor: null,
          });
        else reply(null, 404);
      }
    });
  });
  const sockets = new Server(server, { transports: ["websocket"] });
  const namespace = sockets.of("/chat");
  namespace.use((socket, next) => {
    const token: unknown = socket.handshake.auth["token"];
    if (token !== credential("a") && token !== credential("b"))
      next(new Error("Unauthorized"));
    else next();
  });
  namespace.on("connection", (socket) => {
    socketAccounts.push(
      socket.handshake.auth["token"] === credential("b") ? "b" : "a",
    );
    socket.on(
      "join_conversation",
      (_payload, acknowledge: (value: unknown) => void) =>
        acknowledge({ accepted: true }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("Missing fixture port");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const auth = createAuthClient({
    environment: "staging",
    transport: createTfRobotAuthTransport({ baseUrl }),
  });
  const provider = auth.createSessionProvider();
  let reads = 0;
  const clients: ChatClient[] = [];
  const disposals: Promise<unknown>[] = [];
  let owned: ChatClient | undefined;
  let scope: string | undefined;
  const unwatch = auth.subscribe(() => {
    const snapshot = auth.getSnapshot();
    const next =
      snapshot.status === "authenticated" || snapshot.status === "refreshing"
        ? JSON.stringify([
            snapshot.environment,
            snapshot.account?.userId,
            snapshot.account?.accountId,
            snapshot.account?.organizationId,
          ])
        : undefined;
    if (next === scope) return;
    scope = next;
    if (owned !== undefined)
      disposals.push(owned.dispose({ deadlineAt: deadlineAt() }));
    owned =
      next === undefined
        ? undefined
        : createTFRobotChatClient({
            baseUrl,
            socketNamespaceUrl: `${baseUrl}/chat`,
            serverProfile: { kind: "current-server" },
            messageCreatorProvider: () => ({ uid: "9", name: "Packed user" }),
            sessionProvider: {
              ...provider,
              getSession: async (request) => {
                ++reads;
                return provider.getSession(request);
              },
            },
          });
    if (owned !== undefined) clients.push(owned);
  });
  const current = (): ChatClient => {
    if (owned === undefined) throw new Error("Missing identity-owned chat");
    return owned;
  };
  try {
    check(reads === 0, "Composition eagerly read chat credentials");
    await auth.login({
      identifier: "packed@example.test",
      password: "transient-fixture",
    });
    const first = current();
    check(reads === 0, "Chat construction eagerly read credentials");
    check(
      (await first.listConversations({ deadlineAt: deadlineAt() })).ok,
      "Authenticated listing failed",
    );
    check(
      (
        await first.loadConversation({
          conversationId: "42",
          deadlineAt: deadlineAt(),
        })
      ).ok,
      "Authenticated load failed",
    );
    await view?.render(auth, first);
    view?.assertText("History a");
    check(
      (
        await first.sendText({
          conversationId: "42",
          text: "Packed independent chat",
          deadlineAt: deadlineAt(),
        })
      ).ok,
      "Authenticated send failed",
    );
    const realtime = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        subscription.dispose();
        reject(new Error("Realtime delivery deadline exceeded"));
      }, 8_000);
      const subscription = first.subscribe(() => {
        if (JSON.stringify(first.getSnapshot()).includes("Packed realtime")) {
          clearTimeout(timeout);
          subscription.dispose();
          resolve();
        }
      });
    });
    namespace.emit("chat_message", message("a", "Packed realtime", "live"));
    await realtime;
    await view?.render(auth, first);
    view?.assertText("Packed realtime");
    const late = first.loadConversation({
      conversationId: "43",
      deadlineAt: deadlineAt(),
    });
    let holdTimeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        started,
        new Promise<never>((_resolve, reject) => {
          holdTimeout = setTimeout(
            () => reject(new Error("Held HTTP request did not start")),
            8_000,
          );
        }),
      ]);
    } finally {
      clearTimeout(holdTimeout);
    }
    await auth.switchAccount("b");
    const second = current();
    check(
      second !== first && second.getSnapshot() === null,
      "Identity switch reused chat state",
    );
    releaseHeld?.();
    check(!(await late).ok, "Disposed client accepted a late load");
    await Promise.all(disposals);
    check(first.disposed, "Old chat client remained alive");
    check(
      (
        await second.loadConversation({
          conversationId: "42",
          deadlineAt: deadlineAt(),
        })
      ).ok,
      "Switched identity failed to load",
    );
    await view?.render(auth, second);
    view?.assertText("History b");
    check(
      socketAccounts.includes("a") && socketAccounts.at(-1) === "b",
      "Socket identity did not follow HTTP identity",
    );
    check(
      requests.some(
        (entry) => entry.accountId === "a" && entry.method === "POST",
      ),
      "No authenticated chat POST reached server",
    );
    check(
      requests.some((entry) => entry.accountId === "b"),
      "Switched bearer never reached HTTP server",
    );
    check(reads > 0, "Facade never requested session materials");
    check(
      !JSON.stringify([auth.getSnapshot(), second.getSnapshot()]).includes(
        "packed-fixture",
      ),
      "Credential leaked into snapshots",
    );
    await auth.logout();
    check(owned === undefined, "Logout retained chat ownership");
    await Promise.all(disposals);
    check(second.disposed, "Logout retained the active chat");
  } finally {
    unwatch();
    releaseHeld?.();
    await view?.close();
    await Promise.all(
      clients.map((client) => client.dispose({ deadlineAt: deadlineAt() })),
    );
    await auth.dispose();
    await new Promise<void>((resolve) => sockets.close(() => resolve()));
    server.closeAllConnections();
    if (server.listening)
      await new Promise<void>((resolve) => server.close(() => resolve()));
  }
};
