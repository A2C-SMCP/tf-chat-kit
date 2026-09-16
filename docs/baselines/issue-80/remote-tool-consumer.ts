import { createServer } from "node:http";
import { Server } from "socket.io";
import {
  createTFRobotRemoteToolClient,
  createAskUserRemoteTool,
  defineRemoteTool,
} from "@turingfocus/chat-kit/headless";

/** This file is compiled and run in an isolated tarball consumer, without Front. */
export async function verifyRemoteToolConsumer(): Promise<void> {
  const http = createServer();
  const server = new Server(http, { transports: ["websocket"] });
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
    socket.on(
      "register",
      (_payload: unknown, reply: (value: unknown) => void) => {
        reply({
          providerId: socket.id,
          registeredToolNames: ["read_selection", "ask_user"],
          error: null,
        });
        ask = socket
          .timeout(4000)
          .emitWithAck("remote_tool_invoke", {
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
  const client = createTFRobotRemoteToolClient({
    baseUrl: `http://127.0.0.1:${address.port}`,
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
  } finally {
    clearTimeout(timer);
    client.dispose();
    unsubscribe();
    askUser.dispose();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
