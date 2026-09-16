import { createServer } from "node:http";
import { Server, type Socket } from "socket.io";
import { io } from "socket.io-client";
import { createSocketIoFactoryWith } from "../packages/chat-gateway-tfrobot/src/socket.js";
import { expect, it, vi } from "vitest";
import {
  createTFRobotRemoteToolClient,
  defineRemoteTool,
  type RemoteToolClient,
  type RemoteToolClientState,
  type RemoteToolResult,
  type SessionRequest,
} from "../packages/chat-kit/src/headless.js";

const definition = {
  toolName: "host_tool",
  description: "Host operation",
  parameters: { type: "object" },
  tags: ["Read"],
} as const;
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
const state = (
  client: RemoteToolClient,
  status: RemoteToolClientState["status"],
): Promise<RemoteToolClientState> => {
  if (client.getSnapshot().status === status)
    return Promise.resolve(client.getSnapshot());
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(
        new Error(
          `Expected ${status}; got ${JSON.stringify(client.getSnapshot())}`,
        ),
      );
    }, 5_000);
    const unsubscribe = client.subscribe(() => {
      if (client.getSnapshot().status !== status) return;
      clearTimeout(timeout);
      unsubscribe();
      resolve(client.getSnapshot());
    });
  });
};
const fixture = async (
  register?: (socket: Socket, reply: (value: unknown) => void) => void,
  port = 0,
  authorize?: (socket: Socket, next: (error?: Error) => void) => void,
) => {
  const http = createServer();
  const io = new Server(http, { transports: ["websocket"] });
  const namespace = io.of("/remote-tool");
  const registrations = new Map<string, Socket>();
  let latest!: Socket;
  let registerCount = 0;
  namespace.use((socket, next) =>
    next(
      socket.handshake.auth["token"] === "valid-session"
        ? undefined
        : new Error("not authorized"),
    ),
  );
  if (authorize !== undefined) namespace.use(authorize);
  namespace.on("connection", (socket) => {
    latest = socket;
    socket.on(
      "register",
      (
        payload: { tools: { toolName: string }[] },
        reply: (value: unknown) => void,
      ) => {
        ++registerCount;
        if (register !== undefined) {
          register(socket, reply);
          return;
        }
        const names = payload.tools.map((tool) => tool.toolName);
        if (
          names.some(
            (name) =>
              registrations.has(name) && registrations.get(name) !== socket,
          )
        ) {
          reply({
            providerId: socket.id,
            error:
              "Remote tool name conflicts with existing provider tool: host_tool",
          });
          return;
        }
        names.forEach((name) => registrations.set(name, socket));
        reply({
          providerId: socket.id,
          registeredToolNames: names,
          error: null,
        });
      },
    );
    const revoke = () => {
      for (const [name, owner] of registrations)
        if (owner === socket) registrations.delete(name);
    };
    socket.on("revoke", revoke);
    socket.on("disconnect", revoke);
  });
  await new Promise<void>((resolve) => http.listen(port, "127.0.0.1", resolve));
  const address = http.address();
  if (address === null || typeof address === "string")
    throw new Error("Missing server port");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    namespace,
    registrations,
    get socket() {
      return latest;
    },
    get registerCount() {
      return registerCount;
    },
    close: () => new Promise<void>((resolve) => io.close(() => resolve())),
  };
};
const invoke = (
  socket: Socket,
  requestId = "r1",
  params: Record<string, unknown> = { value: "hello" },
): Promise<unknown> =>
  socket.timeout(2_000).emitWithAck("remote_tool_invoke", {
    requestId,
    providerId: socket.id,
    toolName: "host_tool",
    params,
  });
const basicTool = () =>
  defineRemoteTool({
    definition,
    validate: (params) => {
      if (typeof params["value"] !== "string") throw new Error("invalid");
      return params["value"];
    },
    execute: (value) => ({ ok: true, resultForLlm: value }),
  });
const sessionProvider = {
  getSession: () => ({ kind: "bearer" as const, token: "valid-session" }),
};

it("supports synchronous host recovery from an error notification without closing the new connection", async () => {
  const server = await fixture();
  let valid = false;
  const client = createTFRobotRemoteToolClient({
    baseUrl: server.baseUrl,
    tools: [basicTool()],
    sessionProvider: {
      getSession: () => ({
        kind: "bearer",
        token: valid ? "valid-session" : "bad",
      }),
    },
  });
  client.subscribe(() => {
    if (client.getSnapshot().status === "error" && !valid) {
      valid = true;
      client.retry();
    }
  });
  try {
    client.start();
    await state(client, "ready");
    expect(await invoke(server.socket)).toMatchObject({ success: true });
  } finally {
    client.dispose();
    await server.close();
  }
});

it("ignores an old registration ACK after reconnect and rejects mismatched provider identity", async () => {
  const held = deferred<() => void>();
  let registrations = 0;
  const server = await fixture((socket, reply) => {
    const ack = () =>
      reply({
        providerId: socket.id,
        registeredToolNames: ["host_tool"],
        error: null,
      });
    if (++registrations === 1) held.resolve(ack);
    else ack();
  });
  const client = createTFRobotRemoteToolClient({
    baseUrl: server.baseUrl,
    sessionProvider,
    tools: [basicTool()],
  });
  try {
    client.start();
    const release = await held.promise;
    const disconnected = state(client, "disconnected");
    server.socket.conn.close();
    await disconnected;
    await state(client, "ready");
    release();
    const reply = vi.fn();
    server.socket.emit(
      "remote_tool_invoke",
      {
        requestId: "foreign",
        providerId: "other-provider",
        toolName: "host_tool",
        params: { value: "wrong" },
      },
      reply,
    );
    expect(await invoke(server.socket)).toMatchObject({ success: true });
    expect(reply).not.toHaveBeenCalled();
    expect(client.getSnapshot().status).toBe("ready");
  } finally {
    client.dispose();
    await server.close();
  }
}, 15_000);

it("runs the public Headless entry through real registration, host execution, ACK, reconnect and revoke", async () => {
  const server = await fixture();
  const sessions: SessionRequest[] = [];
  const execute = vi.fn((value: string) => ({
    ok: true as const,
    resultForLlm: value,
  }));
  const client = createTFRobotRemoteToolClient({
    baseUrl: `${server.baseUrl}/api/v1/`,
    sessionProvider: {
      getSession: (request) => {
        sessions.push(request);
        return sessionProvider.getSession();
      },
    },
    tools: [
      defineRemoteTool({
        ...basicTool(),
        validate: (params) => String(params["value"]),
        execute,
      }),
    ],
  });
  try {
    client.start();
    await state(client, "ready");
    const firstSocket = server.socket;
    expect(await invoke(firstSocket)).toEqual({
      requestId: "r1",
      success: true,
      done: true,
      origin: null,
      resultForLlm: "hello",
      error: null,
    });
    const repeated = vi.fn();
    firstSocket.emit(
      "remote_tool_invoke",
      {
        requestId: "r1",
        providerId: firstSocket.id,
        toolName: "host_tool",
        params: { value: "repeat" },
      },
      repeated,
    );
    expect(await invoke(firstSocket, "r2")).toMatchObject({ success: true });
    expect(repeated).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledTimes(2);
    const disconnected = state(client, "disconnected");
    firstSocket.conn.close();
    await disconnected;
    await state(client, "ready");
    expect(server.socket.id).not.toBe(firstSocket.id);
    expect(server.registerCount).toBe(2);
    expect(await invoke(server.socket, "r3")).toMatchObject({
      success: true,
      requestId: "r3",
    });
    expect(sessions).toEqual([
      { purpose: "connect", operation: "remote-tool" },
      { purpose: "reconnect", operation: "remote-tool" },
    ]);
    const revoked = new Promise<void>((resolve) =>
      server.socket.once("disconnect", () => resolve()),
    );
    client.dispose();
    client.dispose();
    await revoked;
    expect(server.registrations.size).toBe(0);
  } finally {
    client.dispose();
    await server.close();
  }
}, 15_000);

it("reports same-name conflicts and retries registration only when the host requests recovery", async () => {
  const server = await fixture();
  const options = {
    baseUrl: server.baseUrl,
    sessionProvider,
    tools: [basicTool()],
  };
  const first = createTFRobotRemoteToolClient(options);
  const second = createTFRobotRemoteToolClient(options);
  try {
    first.start();
    await state(first, "ready");
    const firstSocket = server.socket;
    second.start();
    expect(await state(second, "error")).toMatchObject({
      error: "name-conflict",
    });
    expect(first.getSnapshot().status).toBe("ready");
    const removed = new Promise<void>((resolve) =>
      firstSocket.once("disconnect", () => resolve()),
    );
    first.dispose();
    await removed;
    second.retry();
    await state(second, "ready");
    expect(await invoke(server.socket)).toMatchObject({ success: true });
  } finally {
    first.dispose();
    second.dispose();
    await server.close();
  }
});

it("reports authentication rejection without exposing credentials and refreshes material on explicit retry", async () => {
  const server = await fixture();
  let valid = false;
  const invalidated = deferred<unknown>();
  const client = createTFRobotRemoteToolClient({
    baseUrl: server.baseUrl,
    tools: [basicTool()],
    sessionProvider: {
      getSession: () => ({
        kind: "bearer",
        token: valid ? "valid-session" : "private-rejected-session",
      }),
      onSessionInvalid: (value) => {
        invalidated.resolve(value);
      },
    },
  });
  try {
    client.start();
    expect(await state(client, "error")).toMatchObject({
      error: "authentication",
    });
    expect(JSON.stringify(await invalidated.promise)).not.toContain(
      "private-rejected-session",
    );
    valid = true;
    client.retry();
    await state(client, "ready");
    expect(await invoke(server.socket)).toMatchObject({ success: true });
  } finally {
    client.dispose();
    await server.close();
  }
});

it.each(["missing-name", "duplicate-name", "absent-ack"])(
  "never advertises readiness with %s registration",
  async (kind) => {
    const server = await fixture((socket, reply) => {
      if (kind !== "absent-ack")
        reply({
          providerId: socket.id,
          registeredToolNames:
            kind === "missing-name" ? [] : ["host_tool", "host_tool"],
          error: null,
        });
    });
    const client = createTFRobotRemoteToolClient({
      baseUrl: server.baseUrl,
      sessionProvider,
      tools: [basicTool()],
      connectionTimeoutMs: 150,
    });
    try {
      client.start();
      expect(await state(client, "error")).toMatchObject({
        error: kind === "absent-ack" ? "timeout" : "invalid-ack",
      });
    } finally {
      client.dispose();
      await server.close();
    }
  },
);

it.each(["timeout", "cancelled", "disposed"] as const)(
  "returns %s once over the real transport and ignores a late host answer",
  async (reason) => {
    const server = await fixture();
    const pending = deferred<RemoteToolResult>();
    const executing = deferred<void>();
    const client = createTFRobotRemoteToolClient({
      baseUrl: server.baseUrl,
      sessionProvider,
      tools: [
        defineRemoteTool({
          definition,
          validate: (p) => p,
          execute: () => {
            executing.resolve();
            return pending.promise;
          },
        }),
      ],
      timeoutMs: 40,
    });
    try {
      client.start();
      await state(client, "ready");
      const response = invoke(server.socket);
      await executing.promise;
      if (reason === "cancelled") client.cancel("r1");
      if (reason === "disposed") client.dispose();
      // Socket.IO may close before flushing an ACK on dispose; disconnect is authoritative.
      if (reason === "disposed")
        await response.then(
          (value) => expect(value).toMatchObject({ error: "disposed" }),
          (error: unknown) => expect(error).toBeInstanceOf(Error),
        );
      else
        expect(await response).toMatchObject({
          success: false,
          done: true,
          error: reason,
        });
      pending.resolve({ ok: true, resultForLlm: "late" });
      expect(client.getSnapshot().activeCalls).toBe(0);
    } finally {
      client.dispose();
      await server.close();
    }
  },
);

it("bounds an unresolved SessionProvider and never connects after disposal", async () => {
  const server = await fixture();
  const auth = deferred<{ kind: "bearer"; token: string }>();
  const client = createTFRobotRemoteToolClient({
    baseUrl: server.baseUrl,
    tools: [basicTool()],
    connectionTimeoutMs: 30,
    sessionProvider: { getSession: () => auth.promise },
  });
  try {
    client.start();
    expect(await state(client, "error")).toMatchObject({ error: "timeout" });
    client.dispose();
    auth.resolve(sessionProvider.getSession());
    await Promise.resolve();
    expect(server.registerCount).toBe(0);
  } finally {
    client.dispose();
    await server.close();
  }
});

it("automatically recovers after a failed network reconnect without replaying old work", async () => {
  const original = await fixture();
  const port = Number(new URL(original.baseUrl).port);
  let replacement: Awaited<ReturnType<typeof fixture>> | undefined;
  const failedReconnect = deferred<void>();
  const executing = deferred<void>();
  const pending = deferred<RemoteToolResult>();
  const execute = vi.fn((_params: unknown, context: { requestId: string }) => {
    if (context.requestId === "old") {
      executing.resolve();
      return pending.promise;
    }
    return { ok: true as const, resultForLlm: "recovered" };
  });
  const client = createTFRobotRemoteToolClient({
    baseUrl: original.baseUrl,
    sessionProvider,
    socketFactory: createSocketIoFactoryWith(
      (
        url?: string | Parameters<typeof io>[1],
        options?: Parameters<typeof io>[1],
      ) => {
        const socket = io(typeof url === "string" ? url : undefined, {
          ...(typeof url === "object" ? url : options),
          reconnectionDelay: 20,
          reconnectionDelayMax: 20,
          randomizationFactor: 0,
        });
        socket.on("connect_error", () => failedReconnect.resolve());
        return socket;
      },
    ),
    tools: [
      defineRemoteTool({ definition, validate: (params) => params, execute }),
    ],
  });
  try {
    client.start();
    await state(client, "ready");
    const oldResponse = invoke(original.socket, "old").catch(() => undefined);
    await executing.promise;
    await original.close();
    await failedReconnect.promise;
    replacement = await fixture(undefined, port);
    await state(client, "ready");
    pending.resolve({ ok: true, resultForLlm: "late" });
    const repeated = vi.fn();
    replacement.socket.emit(
      "remote_tool_invoke",
      {
        requestId: "old",
        providerId: replacement.socket.id,
        toolName: "host_tool",
        params: {},
      },
      repeated,
    );
    expect(await invoke(replacement.socket, "new")).toMatchObject({
      success: true,
      resultForLlm: "recovered",
    });
    expect(execute).toHaveBeenCalledTimes(2);
    expect(repeated).not.toHaveBeenCalled();
    await oldResponse;
  } finally {
    client.dispose();
    await original.close();
    await replacement?.close();
  }
}, 15_000);

it("bounds every reconnect namespace handshake and ignores its late completion after disposal", async () => {
  const original = await fixture();
  const port = Number(new URL(original.baseUrl).port);
  let replacement: Awaited<ReturnType<typeof fixture>> | undefined;
  let control: RemoteToolClient | undefined;
  const held = deferred<() => void>();
  const client = createTFRobotRemoteToolClient({
    baseUrl: original.baseUrl,
    sessionProvider,
    tools: [basicTool()],
    connectionTimeoutMs: 300,
    socketFactory: createSocketIoFactoryWith(
      (
        url?: string | Parameters<typeof io>[1],
        options?: Parameters<typeof io>[1],
      ) =>
        io(typeof url === "string" ? url : undefined, {
          ...(typeof url === "object" ? url : options),
          reconnectionDelay: 20,
          reconnectionDelayMax: 20,
          randomizationFactor: 0,
        }),
    ),
  });
  try {
    client.start();
    await state(client, "ready");
    await original.close();
    let attempts = 0;
    replacement = await fixture(undefined, port, (_socket, next) => {
      if (++attempts === 1) held.resolve(() => next());
      else next();
    });
    const release = await held.promise;
    expect(await state(client, "error")).toMatchObject({ error: "timeout" });
    client.dispose();
    release();
    control = createTFRobotRemoteToolClient({
      baseUrl: replacement.baseUrl,
      sessionProvider,
      tools: [basicTool()],
    });
    control.start();
    await state(control, "ready");
    expect(client.getSnapshot().status).toBe("disposed");
    expect(replacement.registerCount).toBe(1);
  } finally {
    client.dispose();
    control?.dispose();
    await original.close();
    await replacement?.close();
  }
}, 15_000);
