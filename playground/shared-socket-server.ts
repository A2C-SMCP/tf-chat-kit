import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Server, type Socket } from "socket.io";
import type { Plugin } from "vite";
import {
  SHARED_DEMO_PREFIX,
  SHARED_DEMO_SOCKET_PATH,
  type SharedSocketObservation,
} from "./src/shared-socket-contract.js";

interface DemoSession {
  readonly events: EventEmitter;
  readonly engines: Set<Socket["conn"]>;
  readonly messages: Record<string, unknown>[];
  chat?: Socket;
  tools?: Socket;
  registered: boolean;
  lastToolResult: string | null;
}

const reply = (
  response: ServerResponse,
  status: number,
  value: unknown,
): void => {
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(value));
};
const sameOrigin = (request: IncomingMessage): boolean => {
  try {
    return (
      request.headers["sec-fetch-site"] !== "cross-site" &&
      (request.headers.origin === undefined ||
        new URL(request.headers.origin).host === request.headers.host)
    );
  } catch {
    return false;
  }
};

const bodyOf = async (
  request: IncomingMessage,
): Promise<Record<string, unknown>> => {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    bytes += part.length;
    if (bytes > 8_192) throw new Error("Request too large");
    chunks.push(part);
  }
  const body = Buffer.concat(chunks).toString("utf8");
  const parsed: unknown = JSON.parse(body || "{}");
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("Invalid request");
  return parsed as Record<string, unknown>;
};

/** Private, local development fixture. Nothing from this server enters public packages. */
export const createSharedSocketDemoPlugin = (): Plugin => ({
  name: "chat-kit-shared-socket-demo",
  apply: "serve",
  configureServer(vite) {
    if (!vite.httpServer) return;
    const io = new Server(vite.httpServer, {
      path: SHARED_DEMO_SOCKET_PATH,
      transports: ["websocket"],
      serveClient: false,
      destroyUpgrade: false,
      allowRequest: (request, callback) => callback(null, sameOrigin(request)),
    });
    const sessions = new Map<string, DemoSession>();
    const engineId = (socket: Socket | undefined): string | null => {
      // Engine.IO's wire sid is runtime-readable; its bundled typings mark id private.
      const value: unknown = socket?.connected
        ? Reflect.get(socket.conn, "id")
        : null;
      return typeof value === "string" ? value : null;
    };
    const observation = (session: DemoSession): SharedSocketObservation => ({
      activeConnections: [...session.engines].filter(
        (engine) => engine.readyState === "open",
      ).length,
      totalConnections: session.engines.size,
      chatEngineId: engineId(session.chat),
      toolEngineId: engineId(session.tools),
      chatConnected: session.chat?.connected === true,
      toolsRegistered: session.tools?.connected === true && session.registered,
      lastToolResult: session.lastToolResult,
    });
    const publish = (session: DemoSession): void => {
      const state = observation(session);
      session.chat?.emit("demo_state", state);
      session.tools?.emit("demo_state", state);
      session.events.emit("updated");
    };
    for (const name of ["/chat", "/remote-tool"]) {
      const namespace = io.of(name);
      namespace.use((socket, next) =>
        next(
          sessions.has(String(socket.handshake.auth["token"]))
            ? undefined
            : new Error("Demo session unavailable"),
        ),
      );
      namespace.on("connection", (socket) => {
        const session = sessions.get(String(socket.handshake.auth["token"]));
        if (!session) {
          socket.disconnect();
          return;
        }
        session.engines.add(socket.conn);
        socket.conn.once("close", () => publish(session));
        if (name === "/chat") {
          session.chat = socket;
          socket.on("join_conversation", (_payload, ack) =>
            ack({ accepted: true, recoveryComplete: true }),
          );
        } else {
          session.tools = socket;
          socket.on(
            "register",
            (payload: { tools?: { toolName: string }[] }, ack) => {
              if (typeof ack !== "function") return;
              const names = Array.isArray(payload?.tools)
                ? payload.tools.map((tool) => tool?.toolName)
                : [];
              if (names.length !== 1 || names[0] !== "read_selection") {
                ack({
                  providerId: socket.id,
                  error: "Only the demo tool is supported",
                });
                return;
              }
              session.registered = true;
              ack({
                providerId: socket.id,
                registeredToolNames: names,
                error: null,
              });
              publish(session);
            },
          );
          socket.on("revoke", (_payload, ack) => {
            session.registered = false;
            if (typeof ack === "function")
              ack({
                providerId: socket.id,
                revokedToolNames: ["read_selection"],
                error: null,
              });
            publish(session);
          });
        }
        socket.on("disconnect", () => {
          if (session.chat === socket) delete session.chat;
          if (session.tools === socket) {
            delete session.tools;
            session.registered = false;
          }
          publish(session);
        });
        publish(session);
      });
    }
    vite.middlewares.use((request, response, next) => {
      const url = new URL(request.url ?? "/", "http://local");
      if (!url.pathname.startsWith(`${SHARED_DEMO_PREFIX}/`)) {
        next();
        return;
      }
      if (!sameOrigin(request)) {
        reply(response, 403, { error: "Origin rejected" });
        return;
      }
      void (async () => {
        if (
          url.pathname === `${SHARED_DEMO_PREFIX}/session` &&
          request.method === "POST"
        ) {
          if (sessions.size >= 100) {
            const idle = [...sessions].find(
              ([, value]) => observation(value).activeConnections === 0,
            );
            if (idle) sessions.delete(idle[0]);
            else {
              reply(response, 429, { error: "Too many demo sessions" });
              return;
            }
          }
          const id = randomUUID();
          sessions.set(id, {
            events: new EventEmitter(),
            engines: new Set(),
            messages: [],
            registered: false,
            lastToolResult: null,
          });
          reply(response, 200, { id });
          return;
        }
        const id =
          request.headers.authorization?.replace(/^Bearer /u, "") ?? "";
        const session = sessions.get(id);
        if (!session) {
          reply(response, 401, { error: "Demo session unavailable" });
          return;
        }
        if (request.method === "DELETE" && url.pathname.endsWith("/session")) {
          session.chat?.disconnect();
          session.tools?.disconnect();
          sessions.delete(id);
          reply(response, 200, { ok: true });
          return;
        }
        if (url.pathname.endsWith("/state") && request.method === "GET") {
          const until = url.searchParams.get("until");
          const matches = (): boolean =>
            until === "idle"
              ? observation(session).activeConnections === 0
              : until === "chat-off"
                ? !session.chat
                : until === "tools-off"
                  ? !session.tools
                  : true;
          if (!matches())
            await new Promise<void>((resolve) => {
              const finish = (): void => {
                clearTimeout(timer);
                session.events.off("updated", update);
                response.off("close", finish);
                resolve();
              };
              const update = (): void => {
                if (matches()) finish();
              };
              const timer = setTimeout(finish, 2_000);
              session.events.on("updated", update);
              response.once("close", finish);
            });
          reply(response, 200, observation(session));
          return;
        }
        if (url.pathname.endsWith("/interrupt") && request.method === "POST") {
          for (const engine of session.engines)
            if (engine.readyState === "open") engine.close();
          reply(response, 200, { ok: true });
          return;
        }
        if (url.pathname.endsWith("/invoke") && request.method === "POST") {
          if (!session.tools?.connected || !session.registered) {
            reply(response, 409, { error: "请先注册宿主工具" });
            return;
          }
          const result: unknown = await session.tools
            .timeout(4_000)
            .emitWithAck("remote_tool_invoke", {
              requestId: randomUUID(),
              providerId: session.tools.id,
              toolName: "read_selection",
              params: {},
            });
          const ack = result as { success?: boolean; resultForLlm?: string };
          session.lastToolResult =
            ack.success === true
              ? String(ack.resultForLlm).slice(0, 2_000)
              : "调用失败";
          publish(session);
          reply(response, 200, { result: session.lastToolResult });
          return;
        }
        let data: unknown;
        if (url.pathname.endsWith("/messages")) {
          if (request.method === "POST") {
            const body = await bodyOf(request);
            const text =
              typeof body["content"] === "string"
                ? body["content"].slice(0, 2_000)
                : "";
            if (!text.trim()) {
              reply(response, 400, { error: "请输入消息" });
              return;
            }
            const message = {
              msgId: randomUUID(),
              conversationId: "1",
              content: `本地机器人收到：${text}`,
              additionalKwargs: {},
              attachments: null,
              createTimestamp: Date.now(),
              creator: { uid: "demo-robot", name: "本地机器人", avatar: null },
              role: "assistant",
              msgType: "text",
            };
            session.messages.push(message);
            session.messages.splice(
              0,
              Math.max(0, session.messages.length - 30),
            );
            session.chat?.emit("chat_message", message);
            data = { taskId: randomUUID() };
          } else
            data = { messages: session.messages, events: [], cursor: null };
        } else if (url.pathname.endsWith("/status"))
          data = { working: false, taskId: null };
        else if (url.pathname.endsWith("/conversations"))
          data = {
            conversations: [
              {
                conversationId: "1",
                title: "共享连接验收",
                description: null,
                updateTimestamp: Date.now(),
              },
            ],
            cursor: null,
          };
        else {
          reply(response, 404, { error: "Unknown demo route" });
          return;
        }
        reply(response, 200, { code: 200, message: "Success", data });
      })().catch(() => {
        if (!response.writableEnded)
          reply(response, 400, { error: "本地演示请求失败，请重试" });
      });
    });
  },
});
