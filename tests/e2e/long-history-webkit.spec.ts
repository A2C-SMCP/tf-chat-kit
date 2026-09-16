import { createServer } from "node:http";
import path from "node:path";
import { Server } from "socket.io";
import { expect, test } from "@playwright/test";

test.use({ browserName: "webkit" });

test("WebKit loads long tool history through real HTTP, Gateway and Runtime", async ({
  page,
}) => {
  const text = ` ${"A/B".repeat(66_667)} 汉字`;
  const secret = "history-session-fixture";
  const requests: string[] = [];
  let joins = 0;
  const server = createServer((request, response) => {
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.setHeader(
      "Access-Control-Allow-Headers",
      "authorization, content-type",
    );
    if (request.method === "OPTIONS") {
      response.writeHead(204).end();
      return;
    }
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    requests.push(pathname);
    if (request.headers.authorization !== `Bearer ${secret}`) {
      response.writeHead(401).end();
      return;
    }
    const data = pathname.endsWith("/messages")
      ? {
          messages: [],
          events: [
            {
              eventId: "long-tool",
              conversationId: "42",
              eventScene: "Tool",
              status: "success",
              createTimestamp: 10,
              transitionId: "end",
              content: {
                toolReturn: {
                  origin: `${text} token=embedded-secret ${secret}`,
                  meta: { success: true, done: true },
                },
              },
            },
          ],
          cursor: null,
        }
      : pathname.endsWith("/status")
        ? { working: false }
        : {
            conversations: [{ conversationId: "42", title: "Long history" }],
            cursor: null,
          };
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ code: 200, message: "Success", data }));
  });
  const io = new Server(server, { transports: ["websocket"] });
  io.of("/chat").on("connection", (socket) => {
    socket.on(
      "join_conversation",
      (_input: unknown, ack: (value: unknown) => void) => {
        joins += 1;
        ack({ accepted: true });
      },
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("No fixture address");
  try {
    await page.goto("/");
    const result = await page.evaluate(
      async ({ entry, origin, secret }) => {
        const { createTFRobotChatClient, sanitizeDiagnosticText } =
          (await import(
            /* @vite-ignore */ entry
          )) as typeof import("../../packages/chat-kit/src/headless.js");
        for (let i = 0; i < 3000; i++) sanitizeDiagnosticText("ordinary text");
        const client = createTFRobotChatClient({
          baseUrl: origin,
          socketNamespaceUrl: `${origin}/chat`,
          sessionProvider: {
            getSession: () => ({ kind: "bearer", token: secret }),
          },
          messageCreatorProvider: () => ({ uid: "reader", name: "Reader" }),
        });
        try {
          const start = performance.now();
          const loaded = await client.loadConversation({
            conversationId: "42",
            deadlineAt: Date.now() + 5000,
          });
          const elapsedMs = performance.now() - start;
          const snapshot = client.getSnapshot();
          const item = snapshot?.timeline.find(
            (item) => item.id === "long-tool",
          );
          const value =
            item?.kind === "agent-event" && item.eventCategory === "tool"
              ? item.transitions.at(-1)?.toolReturn?.result
              : undefined;
          return {
            loaded,
            elapsedMs,
            value,
            serialized: JSON.stringify(snapshot),
          };
        } finally {
          await client.dispose({ deadlineAt: Date.now() + 5000 });
        }
      },
      {
        entry: `/@fs/${path.resolve("packages/chat-kit/src/headless.ts")}`,
        origin: `http://127.0.0.1:${address.port}`,
        secret,
      },
    );
    expect(result.loaded).toMatchObject({ ok: true });
    expect(result.elapsedMs).toBeLessThan(5000);
    expect(result.value).toBe(`${text} token=[REDACTED] [REDACTED]`);
    expect(result.serialized).not.toContain(secret);
    expect(result.serialized).not.toContain("embedded-secret");
    expect(requests.some((route) => route.endsWith("/messages"))).toBe(true);
    expect(requests.some((route) => route.endsWith("/status"))).toBe(true);
    expect(joins).toBe(1);
    console.info(`WebKit long history: ${Math.round(result.elapsedMs)} ms`);
  } finally {
    await new Promise<void>((resolve) => io.close(() => resolve()));
    server.closeAllConnections();
    if (server.listening)
      await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
