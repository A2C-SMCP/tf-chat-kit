import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
import { Server as SocketIoServer, type Socket } from "socket.io";
import { expect, it, vi } from "vitest";
import { createTFRobotChatGateway } from "../packages/chat-gateway-tfrobot/src/index.js";
import { createChatClient } from "../packages/chat-runtime/src/index.js";
import { getGeneratedEventTexts } from "../packages/chat-protocol/src/index.js";
import { eventDtoSchema } from "../packages/chat-gateway-tfrobot/src/dto.js";

it("carries generated output through real HTTP/Socket, history reload and duplicate updates", async () => {
  const longText =
    "**找到文件了**\n\n" +
    "这是一段需要在窄窗格完整阅读的模型生成正文。".repeat(35) +
    "\n\n" +
    "continuous_word_".repeat(60) +
    "\n\n```text\n" +
    "model_output_line ".repeat(30) +
    "\n```\n\n长段落验收结束";
  const cases = [
    {
      id: "text",
      scene: "LLM",
      result: { generations: [{ text: longText }] },
      expected: [longText],
    },
    {
      id: "tool-only",
      scene: "LLM",
      result: {
        generations: [
          { text: "", tool_calls: [{ function: { name: "search_files" } }] },
        ],
      },
      expected: [],
    },
    {
      id: "mixed",
      scene: "LLM",
      result: {
        generations: [
          {
            text: "继续核对",
            tool_calls: [{ function: { name: "read_file" } }],
          },
        ],
      },
      expected: ["继续核对"],
    },
    {
      id: "memory",
      scene: "Memory",
      result: { generations: [{ text: "internal recall" }] },
      expected: null,
    },
  ];
  // Optional legacy-field compatibility uses controlled DTOs, not a required Server extension.
  const exported: unknown = cases.map((testCase) => ({
    eventId: testCase.id,
    conversationId: "42",
    eventScene: testCase.scene,
    status: "success",
    createTimestamp: 1000,
    content: "diagnostic summary",
    generatedTexts: testCase.expected,
  }));
  expect(Array.isArray(exported)).toBe(true);
  const history = (exported as unknown[]).map((dto) =>
    eventDtoSchema.parse(dto),
  );
  expect(history.map((dto) => dto.generatedTexts)).toEqual(
    cases.map((testCase) => testCase.expected),
  );
  const output = process.env["TF_CHAT_GENERATED_EVENTS_OUT"];
  if (output) writeFileSync(output, JSON.stringify(history, null, 2) + "\n");
  const server = createServer((request, response) => {
    expect(request.headers.authorization).toBe("Bearer fixture-session");
    const url = new URL(request.url!, "http://localhost");
    const data = url.pathname.endsWith("/messages")
      ? { messages: [], events: history, cursor: null }
      : url.pathname.endsWith("/status")
        ? { working: false, taskId: null }
        : {
            conversations: [{ conversationId: 42, title: "Generated output" }],
            cursor: null,
          };
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ code: 200, message: "Success", data }));
  });
  const sockets: Socket[] = [];
  const io = new SocketIoServer(server, { transports: ["websocket"] });
  io.of("/chat").on("connection", (socket) => {
    sockets.push(socket);
    socket.on("join_conversation", (_payload, ack) => ack());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing port");
  const origin = `http://127.0.0.1:${address.port}`;
  const client = createChatClient({
    gateway: createTFRobotChatGateway({
      baseUrl: origin,
      messageCreatorProvider: () => ({ uid: "user", name: "Fixture" }),
      socketNamespaceUrl: `${origin}/chat`,
      serverProfile: { kind: "current-server" },
      sessionProvider: {
        getSession: () => ({ kind: "bearer", token: "fixture-session" }),
      },
    }),
  });
  const options = () => ({ deadlineAt: Date.now() + 10_000 });
  try {
    expect(
      (await client.loadConversation({ ...options(), conversationId: "42" }))
        .ok,
    ).toBe(true);
    expect(client.getSnapshot()!.timeline).toHaveLength(4);
    expect(client.getSnapshot()!.timeline.map(getGeneratedEventTexts)).toEqual(
      expect.arrayContaining([
        cases[0]!.expected,
        [],
        cases[2]!.expected,
        undefined,
      ]),
    );
    const live = {
      ...history[0]!,
      eventId: "live",
      createTimestamp: 2000,
      generatedTexts: ["**实时发现**"],
    };
    for (let index = 0; index < 3; index++)
      sockets[0]!.emit("chat_event", live);
    await vi.waitFor(() =>
      expect(client.getSnapshot()!.timeline).toHaveLength(5),
    );
    expect(
      getGeneratedEventTexts(client.getSnapshot()!.timeline.at(-1)!),
    ).toEqual(["**实时发现**"]);
    sockets[0]!.emit("chat_event", {
      ...live,
      status: "running",
      createTimestamp: 1500,
      generatedTexts: null,
    });
    history.push(live);
    expect(
      (await client.loadConversation({ ...options(), conversationId: "42" }))
        .ok,
    ).toBe(true);
    expect(client.getSnapshot()!.timeline).toHaveLength(5);
    expect(
      getGeneratedEventTexts(client.getSnapshot()!.timeline.at(-1)!),
    ).toEqual(["**实时发现**"]);
  } finally {
    await client.dispose(options());
    await new Promise<void>((resolve) => io.close(() => resolve()));
    if (server.listening)
      await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}, 40_000);
