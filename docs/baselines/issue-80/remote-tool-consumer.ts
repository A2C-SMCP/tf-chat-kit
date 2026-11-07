import { createServer } from "node:http";
import { Server, type Socket } from "socket.io";
import {
  createTFRobotRemoteToolClient,
  createTFRobotChatClient,
  createTFRobotSocketConnection,
  createAskUserRemoteTool,
  defineRemoteTool,
} from "@turingfocus/chat-kit/headless";

/** This file is compiled and run in an isolated tarball consumer, without Front. */
export async function verifyRemoteToolConsumer(): Promise<void> {
  const http = createServer((request, response) => {
    response.setHeader("Content-Type", "application/json");
    const data = request.url?.includes("/status")
      ? { working: false, taskId: null }
      : request.url?.includes("/messages")
        ? { messages: [], events: [], cursor: null }
        : {
            conversations: [
              {
                conversationId: "1",
                title: "Packed chat",
                description: null,
                updateTimestamp: 1_800_000_000_000,
              },
            ],
            cursor: null,
          };
    response.end(JSON.stringify({ code: 200, message: "Success", data }));
  });
  const server = new Server(http, { transports: ["websocket"] });
  let chatSocket: Socket | undefined;
  let toolSocket: Socket | undefined;
  let connections = 0;
  server.engine.on("connection", () => {
    connections += 1;
  });
  server.of("/chat").on("connection", (socket) => {
    chatSocket = socket;
    socket.on(
      "join_conversation",
      (_payload: unknown, ack: (value: unknown) => void) =>
        ack({ accepted: true, recoveryComplete: true }),
    );
  });
  const askUser = createAskUserRemoteTool({
    resolveConversationId: ({ requestId }) =>
      requestId === "packed-ask" ? "host-conversation" : undefined,
  });
  const unsubscribe = askUser.subscribe(() => {
    const entry = askUser
      .getSnapshot()
      .find((candidate) => candidate.result === undefined);
    if (entry !== undefined)
      askUser.answer(entry.request.conversationId, {
        requestId: entry.request.requestId,
        revision: entry.request.revision,
        action: "submit",
        answers: { "0": "Headless answer" },
      });
  });
  let ask!: Promise<unknown>;
  let resolveResult!: (value: unknown) => void;
  let rejectResult!: (error: Error) => void;
  const result = new Promise<unknown>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  const timer = setTimeout(
    () => rejectResult(new Error("Packed RemoteTool timed out")),
    5_000,
  );
  server.of("/remote-tool").on("connection", (socket) => {
    toolSocket = socket;
    socket.on(
      "register",
      (_payload: unknown, reply: (value: unknown) => void) => {
        reply({
          providerId: socket.id,
          registeredToolNames: ["read_selection", "ask_user"],
          error: null,
        });
        ask = socket.timeout(4000).emitWithAck("remote_tool_invoke", {
          providerId: socket.id,
          requestId: "packed-ask",
          toolName: "ask_user",
          params: {
            questions: [
              { question: "Host question", header: "Input", options: [] },
            ],
          },
        });
        socket.emit(
          "remote_tool_invoke",
          {
            providerId: socket.id,
            requestId: "packed-call",
            toolName: "read_selection",
            params: { selection: "A1" },
          },
          resolveResult,
        );
      },
    );
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  if (address === null || typeof address === "string")
    throw new Error("No local listener");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const connection = createTFRobotSocketConnection({ serverUrl: baseUrl });
  const chat = createTFRobotChatClient({
    baseUrl,
    socketFactory: connection.socketFactory,
    sessionProvider: {
      getSession: () => ({ kind: "bearer", token: "packed-chat-session" }),
    },
    messageCreatorProvider: () => ({ uid: "host", name: "Host" }),
  });
  const client = createTFRobotRemoteToolClient({
    baseUrl,
    socketFactory: connection.socketFactory,
    sessionProvider: {
      getSession: () => ({ kind: "bearer", token: "local-consumer-session" }),
    },
    tools: [
      askUser.tool,
      defineRemoteTool({
        definition: {
          toolName: "read_selection",
          description: "Read host selection",
          parameters: { type: "object" },
          tags: ["Read"],
        },
        validate(params) {
          if (typeof params["selection"] !== "string")
            throw new Error("Selection required");
          return params["selection"];
        },
        execute(selection, { signal }) {
          if (signal.aborted) return { ok: false, code: "cancelled" };
          return { ok: true, resultForLlm: `Selected ${selection}` };
        },
      }),
    ],
  });
  try {
    const loaded = await chat.loadConversation({
      conversationId: "1",
      deadlineAt: Date.now() + 4_000,
    });
    if (!loaded.ok) throw new Error("Packed chat did not load");
    client.start();
    const response = (await result) as {
      success?: boolean;
      resultForLlm?: string;
      requestId?: string;
    };
    if (
      response.success !== true ||
      response.resultForLlm !== "Selected A1" ||
      response.requestId !== "packed-call"
    )
      throw new Error("Packed host tool did not return the expected answer");
    const askResponse = (await ask) as {
      success?: boolean;
      resultForLlm?: string;
    };
    if (
      askResponse.success !== true ||
      askResponse.resultForLlm !== "1. Host question: Headless answer"
    )
      throw new Error("Packed Ask User failed");
    if (
      !chatSocket ||
      !toolSocket ||
      chatSocket.conn !== toolSocket.conn ||
      connections !== 1
    )
      throw new Error("Packed namespaces did not share one connection");
    client.dispose();
    const received = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        subscription.dispose();
        reject(new Error("Packed chat did not survive tool disposal"));
      }, 2_000);
      const subscription = chat.subscribe(() => {
        if (
          chat.getSnapshot()?.timeline.some((item) => item.id === "packed-live")
        ) {
          clearTimeout(timeout);
          subscription.dispose();
          resolve();
        }
      });
    });
    chatSocket.emit("chat_message", {
      msgId: "packed-live",
      conversationId: "1",
      content: "Chat remains live",
      additionalKwargs: {},
      attachments: null,
      createTimestamp: 1_800_000_000_000,
      creator: { uid: "agent", name: "Agent", avatar: null },
      role: "assistant",
      msgType: "text",
    });
    await received;
  } finally {
    clearTimeout(timer);
    client.dispose();
    unsubscribe();
    askUser.dispose();
    await chat.dispose({ deadlineAt: Date.now() + 2_000 });
    connection.dispose();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
