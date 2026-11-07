import { createServer } from "node:http";
import { Server, type Socket } from "socket.io";
import { expect, it } from "vitest";
import { createManagerClient } from "../packages/chat-auth/src/manager.js";
import { createPlaygroundEnvironment } from "../playground/src/real-environment.js";

async function fixture() {
  const scopes: string[] = [];
  let hold: (() => void) | undefined;
  let delay = false;
  const account = {
    accountId: "account",
    userId: "user",
    organizationId: "org",
  };
  const http = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on("end", () => {
      const path = new URL(req.url!, "http://fixture.invalid").pathname;
      const reply = (data: unknown) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(data));
      };
      if (path === "/auth/login-by-password")
        reply({ account, token: "manager" });
      else if (
        path !== "/api/v1/oauth/token" &&
        req.headers.authorization !== "Bearer manager"
      ) {
        res.writeHead(401);
        res.end();
      } else if (path === "/api/v1/auth/me") reply(account);
      else if (path === "/api/v1/digital-employees")
        reply({
          items: [
            {
              id: "robot",
              robotId: "robot-a",
              robotAccountId: "robot-account",
              status: "running",
              templateType: "tfrserver",
            },
          ],
          page: 1,
          pageSize: 20,
          total: 1,
        });
      else if (path.endsWith("/connection-info"))
        reply({
          socketBaseURL: origin,
          namespace: "tenant",
          rid: "robot-a",
          robotType: "tfrobot",
          sioPath: "/socket.io/",
        });
      else if (path === "/api/v1/oauth/token") {
        const form = new URLSearchParams(body);
        expect(form.get("audience")).toBe("robot:robot-account");
        const scope = form.get("scope")!;
        scopes.push(scope);
        const finish = () =>
          reply({
            access_token: scope === "action:execute" ? "tools" : "chat",
            expires_in: 3600,
          });
        if (delay) hold = finish;
        else finish();
      } else {
        res.writeHead(404);
        res.end();
      }
    });
  });
  const io = new Server(http, {
    path: "/c/tfrobot/tenant/robot-a/socket.io",
    transports: ["websocket"],
  });
  const chatSockets = new Set<Socket>();
  let toolSocket: Socket | undefined;
  io.of("/chat").use((socket, next) =>
    next(
      socket.handshake.auth["token"] === "chat"
        ? undefined
        : new Error("forbidden"),
    ),
  );
  io.of("/chat").on("connection", (socket) => {
    chatSockets.add(socket);
    socket.on("disconnect", () => chatSockets.delete(socket));
  });
  io.of("/remote-tool").use((socket, next) =>
    next(
      socket.handshake.auth["token"] === "tools"
        ? undefined
        : new Error("forbidden"),
    ),
  );
  io.of("/remote-tool").on("connection", (socket) => {
    socket.on(
      "register",
      (
        input: { tools: { toolName: string }[] },
        ack: (value: unknown) => void,
      ) => {
        expect(input.tools.map((tool) => tool.toolName)).toEqual(["add"]);
        toolSocket = socket;
        ack({
          providerId: socket.id,
          registeredToolNames: ["add"],
          error: null,
        });
      },
    );
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  if (!address || typeof address === "string") throw Error("No fixture port");
  const origin = `http://127.0.0.1:${address.port}`;
  const env = createPlaygroundEnvironment(origin);
  await env.auth.login({ identifier: "fixture", password: "fixture" });
  const directory = await env.toolManager.refresh();
  const robot = directory.items[0]!;
  const waitForTool = () =>
    new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        stop();
        reject(Error("Tool did not register"));
      }, 3000);
      const stop = env.tools.subscribe(() => {
        if (env.tools.getSnapshot().status === "ready") {
          clearTimeout(timeout);
          stop();
          resolve();
        }
      });
      if (env.tools.getSnapshot().status === "ready") {
        clearTimeout(timeout);
        stop();
        resolve();
      }
    });
  const invoke = (params: unknown) =>
    toolSocket!.timeout(2000).emitWithAck("remote_tool_invoke", {
      providerId: toolSocket!.id,
      requestId: crypto.randomUUID(),
      toolName: "add",
      params,
    });
  return {
    env,
    origin,
    robot,
    scopes,
    io,
    chatSockets,
    invoke,
    waitForTool,
    delay: () => {
      delay = true;
    },
    release: () => hold?.(),
    close: async () => {
      await env.dispose();
      await new Promise<void>((resolve) => io.close(() => resolve()));
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}

it("requests immutable explicit tool scopes while preserving default chat sessions", async () => {
  const f = await fixture();
  try {
    const customScopes = ["action:execute"];
    const manager = createManagerClient({
      auth: f.env.auth,
      baseUrl: f.origin,
      routing: { allowedOrigins: [f.origin], http: { kind: "routed-server" } },
      robotSessionScopes: customScopes,
    });
    customScopes.push("robot:admin");
    const connection = await manager.connect(f.robot);
    await connection.sessionProvider.getSession();
    expect(f.scopes).toEqual(["action:execute"]);
    connection.dispose();
    manager.dispose();
    const chat = await f.env.manager.connect(f.robot);
    chat.dispose();
    expect(f.scopes).toEqual(["action:execute", "chat:read chat:send"]);
    for (const scopes of [[], ["chat:read action:execute"], [""]])
      expect(() =>
        createManagerClient({
          auth: f.env.auth,
          baseUrl: f.origin,
          routing: {
            allowedOrigins: [f.origin],
            http: { kind: "routed-server" },
          },
          robotSessionScopes: scopes,
        }),
      ).toThrow("Invalid Robot session scopes");
  } finally {
    await f.close();
  }
});

it("registers add before chat and shares a real WebSocket while each namespace is released independently", async () => {
  const f = await fixture();
  try {
    const ready = f.waitForTool();
    await f.env.tools.start(f.robot);
    await ready;
    expect(f.io.engine.clientsCount).toBe(1);
    expect(f.chatSockets.size).toBe(0);
    expect(await f.invoke({ a: 12, b: 30 })).toMatchObject({
      success: true,
      resultForLlm: "42",
      origin: { a: 12, b: 30, sum: 42 },
    });
    expect(await f.invoke({ a: "12", b: 30 })).toMatchObject({
      success: false,
      error: "invalid-parameters",
    });
    expect(
      await f.invoke({ a: Number.MAX_VALUE, b: Number.MAX_VALUE }),
    ).toMatchObject({ success: false, error: "invalid-parameters" });
    expect(f.env.tools.getSnapshot().calls).toEqual([
      { a: 12, b: 30, sum: 42 },
    ]);
    const connection = await f.env.manager.connect(f.robot);
    const socket = f.env.chat.socketFactory({
      namespaceUrl: connection.target.socketNamespaceUrl,
      path: connection.target.socketPath,
      getAuth: async () => ({
        token: (await connection.sessionProvider.getSession()).token,
      }),
    });
    await new Promise<void>((resolve) => {
      socket.on("connect", () => resolve());
      socket.connect();
    });
    expect(f.chatSockets.size).toBe(1);
    expect(f.io.engine.clientsCount).toBe(1);
    const toolRemains = f.waitForTool();
    socket.disconnect();
    connection.dispose();
    await toolRemains;
    expect(await f.invoke({ a: -1, b: 0.5 })).toMatchObject({
      success: true,
      resultForLlm: "-0.5",
    });
    f.env.tools.stop();
    expect(f.env.tools.getSnapshot()).toMatchObject({
      status: "idle",
      calls: [],
    });
  } finally {
    await f.close();
  }
});

it("cancels a pending exchange without a late tool registration", async () => {
  const f = await fixture();
  try {
    f.delay();
    const work = f.env.tools.start(f.robot);
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(Error("No exchange")), 2000);
      const original = f.scopes.push.bind(f.scopes);
      f.scopes.push = (...values) => {
        const n = original(...values);
        clearTimeout(timeout);
        resolve();
        return n;
      };
    });
    f.env.tools.stop();
    f.release();
    await work;
    expect(f.env.tools.getSnapshot().status).toBe("idle");
    expect(f.io.engine.clientsCount).toBe(0);
  } finally {
    await f.close();
  }
});

it("clears tool registration and call data immediately on logout", async () => {
  const f = await fixture();
  try {
    const ready = f.waitForTool();
    await f.env.tools.start(f.robot);
    await ready;
    await f.invoke({ a: 1, b: 2 });
    await f.env.auth.logout();
    expect(f.env.tools.getSnapshot()).toMatchObject({
      status: "idle",
      calls: [],
    });
    expect(f.env.toolManager.getSnapshot().items).toEqual([]);
  } finally {
    await f.close();
  }
});
