// @vitest-environment jsdom

import { createServer } from "node:http";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { Server } from "socket.io";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { PlaygroundApp } from "../playground/src/app.js";
import { createRobotServerPlaygroundSession } from "../playground/src/robotserver-session.js";
import type { PlaygroundSession } from "../playground/src/playground-session.js";

beforeAll(() => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: () => ({
      matches: false,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
    }),
  });
});

const conversation = (id: number, title: string) => ({
  conversationId: id,
  title,
  description: null,
  updateTimestamp: Date.now(),
});

describe("Manager quick-chat creation through real local HTTP/Socket.IO", () => {
  it.each(["existing", "empty", "failure", "logout"] as const)(
    "creates an independent conversation (%s)",
    async (mode) => {
      const business = conversation(7, "Existing business conversation");
      const conversations = new Map<number, ReturnType<typeof conversation>>(
        mode === "empty" ? [] : [[7, business]],
      );
      const deleted: string[] = [];
      const sentTo: string[] = [];
      const exchanges: URLSearchParams[] = [];
      const creates: Array<{ title: string; authorized: boolean }> = [];
      let heldReply: (() => void) | undefined;
      const server = createServer((request, response) => {
        let body = "";
        request.on("data", (chunk: Buffer) => {
          body += chunk.toString();
        });
        request.on("end", () => {
          const url = new URL(request.url ?? "/", "http://localhost");
          const reply = (data: unknown, status = 200, envelope = false) => {
            if (response.destroyed || response.writableEnded) return;
            response.writeHead(status, { "Content-Type": "application/json" });
            response.end(
              JSON.stringify(
                envelope
                  ? {
                      code: status,
                      message: status === 200 ? "Success" : "Fixture failure",
                      data,
                    }
                  : data,
              ),
            );
          };
          const account = {
            accountId: "account-real",
            organizationId: "org-real",
            userId: "user-real",
            displayName: "真实组织",
          };
          if (
            url.pathname.startsWith("/api/v1/") &&
            url.pathname !== "/api/v1/oauth/token" &&
            request.headers.authorization !== "Bearer manager-fixture"
          ) {
            reply({ message: "Unauthorized" }, 401);
            return;
          }
          if (url.pathname === "/auth/login-by-password")
            reply({ account, token: "manager-fixture" });
          else if (url.pathname === "/api/v1/auth/me") reply(account);
          else if (url.pathname === "/api/v1/accounts/my")
            reply({ accounts: [account] });
          else if (url.pathname === "/api/v1/digital-employees")
            reply({
              data: {
                items: [
                  {
                    id: "de-local",
                    name: "通用",
                    robotAccountId: "robot-account",
                    robotId: "local-robot",
                    status: "running",
                    templateType: "tfrserver",
                  },
                ],
              },
            });
          else if (url.pathname.endsWith("/connection-info"))
            reply({
              data: {
                namespace: "local-ns",
                rid: "local-robot",
                robotType: "tfrobot",
                socketBaseURL: "https://robot.turingfocus.cn",
              },
            });
          else if (url.pathname === "/api/v1/oauth/token") {
            exchanges.push(new URLSearchParams(body));
            reply({ access_token: "robot-fixture", expires_in: 3_600 });
          } else if (request.headers.authorization !== "Bearer robot-fixture")
            reply(null, 401, true);
          else if (
            url.pathname === "/v1/chat/conversations" &&
            request.method === "GET"
          )
            reply(
              { conversations: [...conversations.values()], cursor: null },
              200,
              true,
            );
          else if (
            url.pathname === "/v1/chat/conversations" &&
            request.method === "POST"
          ) {
            const title = url.searchParams.get("title") ?? "";
            creates.push({
              title,
              authorized:
                request.headers.authorization === "Bearer robot-fixture",
            });
            if (mode === "failure" && creates.length === 1) {
              reply(null, 503, true);
              return;
            }
            const created = conversation(42, title);
            const complete = () => {
              conversations.set(42, created);
              reply(created, 200, true);
            };
            if (mode === "logout") heldReply = complete;
            else complete();
          } else if (
            url.pathname.endsWith("/messages") &&
            request.method === "GET"
          )
            reply({ messages: [], events: [], cursor: null }, 200, true);
          else if (url.pathname.endsWith("/status"))
            reply({ working: false, taskId: null }, 200, true);
          else if (
            url.pathname.endsWith("/messages") &&
            request.method === "POST"
          ) {
            sentTo.push(url.pathname.split("/").at(-2) ?? "");
            reply({ taskId: "local-run" }, 200, true);
          } else if (request.method === "DELETE") {
            const id = url.pathname.split("/").filter(Boolean).at(-1) ?? "";
            deleted.push(id);
            conversations.delete(Number(id));
            reply(
              { conversationId: Number(id), message: "deleted" },
              200,
              true,
            );
          } else reply(null, 404, true);
        });
      });
      const sockets = new Server(server, { transports: ["websocket"] });
      const socketTokens: unknown[] = [];
      sockets
        .of("/chat")
        .use((socket, next) => {
          if (socket.handshake.auth["token"] !== "robot-fixture")
            next(new Error("Unauthorized"));
          else next();
        })
        .on("connection", (socket) => {
          socketTokens.push(socket.handshake.auth["token"]);
          socket.on(
            "join_conversation",
            (_input, acknowledge: (value: unknown) => void) =>
              acknowledge({ accepted: true }),
          );
        });
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      const address = server.address();
      if (address === null || typeof address === "string")
        throw new Error("Missing fixture port");
      const origin = `http://127.0.0.1:${address.port}`;
      const nativeFetch = globalThis.fetch;
      // Forward Manager URLs to real TCP facilities; never fabricate fetch responses.
      vi.stubGlobal(
        "fetch",
        (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
          const url = new URL(
            typeof input === "string"
              ? input
              : input instanceof URL
                ? input.href
                : input.url,
          );
          if (url.hostname === "api-staging.turingfocus.cn") {
            const rewritten = `${origin}${url.pathname}${url.search}`;
            return nativeFetch(
              typeof input === "string" || input instanceof URL
                ? rewritten
                : new Request(rewritten, input),
              init,
            );
          }
          return nativeFetch(input, init);
        },
      );
      const sessions: PlaygroundSession[] = [];
      const container = document.createElement("div");
      document.body.append(container);
      const root = createRoot(container);
      const previousAct = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
      Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
      const click = async (text: string) => {
        const button = [
          ...document.querySelectorAll<HTMLButtonElement>("button"),
        ].find(
          (candidate) =>
            candidate.textContent?.includes(text) ||
            candidate.getAttribute("aria-label") === text,
        );
        expect(button, `Missing button ${text}`).toBeDefined();
        await act(async () => {
          button!.click();
          await Promise.resolve();
        });
      };
      try {
        await act(async () =>
          root.render(
            createElement(PlaygroundApp, {
              createRobotServerSession: (config) => {
                expect(config.credential).toBeUndefined();
                expect(config.sessionProvider).toBeDefined();
                const session = createRobotServerPlaygroundSession(
                  {
                    ...config,
                    httpBaseUrl: origin,
                    socketNamespaceUrl: `${origin}/chat`,
                    socketPath: "/socket.io",
                  },
                  { fetch: nativeFetch },
                );
                sessions.push(session);
                return session;
              },
            }),
          ),
        );
        await click("进入登录与机器人");
        const realMode = [...container.querySelectorAll("label")].find(
          (label) => label.textContent === "真实用户模式",
        );
        expect(realMode).toBeDefined();
        await act(async () => {
          realMode!.click();
        });
        await act(async () => {
          for (const [label, value] of [
            ["用户账号", "local-user"],
            ["用户密码", "transient-fixture"],
          ]) {
            const input = container.querySelector<HTMLInputElement>(
              `input[aria-label="${label}"]`,
            )!;
            Object.getOwnPropertyDescriptor(
              HTMLInputElement.prototype,
              "value",
            )!.set!.call(input, value);
            input.dispatchEvent(new Event("input", { bubbles: true }));
          }
        });
        await click("用户登录");
        await vi.waitFor(
          () => expect(sessions.at(-1)?.getState().listLoading).toBe(false),
          { timeout: 8_000 },
        );
        expect(sessions).toHaveLength(1);
        await vi.waitFor(() =>
          expect(container.textContent).toContain(
            mode === "empty" ? "已加载 0 个会话" : business.title,
          ),
        );
        expect(exchanges).toHaveLength(1);
        expect(exchanges[0]?.get("subject_token")).toBe("manager-fixture");
        expect(exchanges[0]?.get("audience")).toBe("robot:robot-account");
        await click("新建会话");
        expect(
          document.querySelector('[role="dialog"]')?.textContent,
        ).toContain("Playground");
        await click("确认新建");
        await vi.waitFor(() => expect(creates).toHaveLength(1));
        if (mode === "failure") {
          await vi.waitFor(() =>
            expect(sessions[0]?.getState().contentState.kind).toBe("error"),
          );
          expect(container.textContent).toContain(
            sessions[0]!.getState().status,
          );
          expect(document.querySelector('[role="dialog"]')).not.toBeNull();
          await click("确认新建");
        }
        if (mode === "logout") {
          await click("退出登录");
          heldReply?.();
          await vi.waitFor(() => expect(sessions[0]?.disposed).toBe(true));
          expect(container.textContent).not.toContain(
            "正在查看「[tf-chat-kit playground]",
          );
        } else {
          await vi.waitFor(
            () =>
              expect(sessions[0]?.getState().selectedConversationId).toBe("42"),
            { timeout: 8_000 },
          );
          await vi.waitFor(() =>
            expect(container.textContent).toContain(
              `正在查看「${creates.at(-1)?.title}」`,
            ),
          );
          expect(socketTokens.length).toBeGreaterThan(0);
          expect(socketTokens.every((token) => token === "robot-fixture")).toBe(
            true,
          );
        }
        expect(
          creates.every(
            (entry) =>
              entry.authorized &&
              entry.title.startsWith("[tf-chat-kit playground] "),
          ),
        ).toBe(true);
        expect(sentTo).toEqual([]);
        expect(container.innerHTML).not.toContain("robot-fixture");
        expect(container.innerHTML).not.toContain("manager-fixture");
      } finally {
        heldReply?.();
        try {
          await act(async () => root.unmount());
          await Promise.all(sessions.map((session) => session.dispose()));
          await vi.waitFor(
            () =>
              expect(sessions.every((session) => session.client.disposed)).toBe(
                true,
              ),
            { timeout: 8_000 },
          );
        } finally {
          container.remove();
          if (previousAct === undefined)
            Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
          else Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousAct);
          vi.unstubAllGlobals();
          await new Promise<void>((resolve) => sockets.close(() => resolve()));
          server.closeAllConnections();
          if (server.listening)
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
      }
      expect(deleted).toEqual(["42"]);
      if (mode !== "empty") expect(conversations.get(7)).toEqual(business);
    },
    20_000,
  );
});
