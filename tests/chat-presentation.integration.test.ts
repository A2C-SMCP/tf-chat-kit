// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { ChatProvider } from "../packages/chat-react/src/index.js";
import {
  ChatTimelineItem,
  createChatRendererRegistry,
} from "../packages/chat-ui-antd/src/index.js";
import { createServer } from "node:http";
import { Server } from "socket.io";
import { expect, it, vi } from "vitest";
import { createTFRobotChatGateway } from "../packages/chat-gateway-tfrobot/src/index.js";
import { createChatClient } from "../packages/chat-runtime/src/index.js";

it("carries normalized history and terminal Socket.IO updates through the real adapter and Runtime", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const dto = {
    eventId: "browser",
    conversationId: "42",
    eventScene: "Tool",
    status: "running",
    createTimestamp: 10,
    transitionId: "start",
    content: {
      toolCall: { functionCall: { name: "browse", parameters: "{}" } },
    },
  };
  const displays = [
    {
      eventId: "preview",
      origin: { content: "const answer = 42;", language: "js" },
    },
    {
      eventId: "editor",
      origin: { original: "old", modified: "new", language: "text" },
    },
    { eventId: "shell", origin: { content: "terminal output", command: "ls" } },
    {
      eventId: "download",
      origin: { url: "https://example.com/report.pdf", filename: "report.pdf" },
    },
  ].map(({ eventId, origin }) => ({
    ...dto,
    eventId,
    status: "success",
    content: { toolReturn: { origin, meta: { success: true } } },
  }));
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    const data = path.endsWith("/messages")
      ? { messages: [], events: [dto, ...displays], cursor: null }
      : path.endsWith("/status")
        ? { working: false }
        : {
            conversations: [{ conversationId: "42", title: "Independent app" }],
            cursor: null,
          };
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ code: 200, message: "Success", data }));
  });
  const io = new Server(server, { transports: ["websocket"] });
  const namespace = io.of("/chat");
  namespace.on("connection", (socket) => {
    socket.on(
      "join_conversation",
      (_payload: unknown, ack: (value: unknown) => void) =>
        ack({ accepted: true }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("Missing fixture address");
  const origin = `http://127.0.0.1:${address.port}`;
  const gateway = createTFRobotChatGateway({
    baseUrl: origin,
    socketNamespaceUrl: `${origin}/chat`,
    sessionProvider: {
      getSession: () => ({ kind: "bearer", token: "test-session" }),
    },
    messageCreatorProvider: () => ({ uid: "reader", name: "Reader" }),
  });
  const client = createChatClient({ gateway });
  const container = document.createElement("div");
  const renderer = createRoot(container);
  try {
    const loaded = await client.loadConversation({
      conversationId: "42",
      deadlineAt: Date.now() + 5_000,
    });
    expect(loaded.ok).toBe(true);
    const completed = new Promise<void>((resolve) => {
      const subscription = client.subscribe((snapshot) => {
        const item = snapshot?.timeline.find((item) => item.id === "browser");
        if (item?.kind === "agent-event" && item.status === "success") {
          expect(item.eventCategory).toBe("tool");
          if (item.eventCategory === "tool")
            expect(
              item.transitions.at(-1)?.toolReturn?.presentation,
            ).toMatchObject({ kind: "browser", markdown: "# Complete" });
          expect(item.transitions).toHaveLength(2);
          subscription.dispose();
          resolve();
        }
      });
    });
    const terminal = {
      ...dto,
      status: "success",
      createTimestamp: 20,
      transitionId: "end",
      content: {
        ...dto.content,
        toolReturn: {
          origin: { url: "https://example.com", content: "# Complete" },
          meta: { success: true, done: true },
        },
      },
    };
    namespace.emit("chat_event", terminal);
    namespace.emit("chat_event", terminal);
    await completed;
    await act(async () => {
      renderer.render(
        createElement(
          ChatProvider,
          { client },
          createElement(
            "main",
            null,
            ...client.getSnapshot()!.timeline.map((item) =>
              createElement(ChatTimelineItem, {
                key: item.id,
                registry: createChatRendererRegistry(),
                item,
              }),
            ),
          ),
        ),
      );
    });
    await act(async () => {
      await vi.dynamicImportSettled();
    });
    const rendered = container.textContent ?? "";
    for (const expected of [
      "Complete",
      "const answer",
      "terminal output",
      "report.pdf",
    ])
      expect(rendered).toContain(expected);
    expect(
      container.querySelector('[aria-label="Read-only diff"]'),
    ).not.toBeNull();
    const tabs = container.querySelectorAll<HTMLElement>('[role="tab"]');
    expect(tabs).toHaveLength(2);
    await act(async () => tabs[0]?.click());
    expect(tabs[0]?.getAttribute("aria-selected")).toBe("true");
    await act(async () => tabs[1]?.click());
    expect(tabs[1]?.getAttribute("aria-selected")).toBe("true");
    expect(container.textContent).toContain("Complete");
  } finally {
    act(() => renderer.unmount());
    await client.dispose({ deadlineAt: Date.now() + 5_000 });
    await gateway.dispose({ deadlineAt: Date.now() + 5_000 });
    await new Promise<void>((resolve) => io.close(() => resolve()));
    vi.unstubAllGlobals();
  }
}, 10_000);
