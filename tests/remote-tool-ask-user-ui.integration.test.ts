// @vitest-environment jsdom
import { createServer } from "node:http";
import { Server, type Socket } from "socket.io";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import {
  createAskUserRemoteTool,
  createTFRobotRemoteToolClient,
} from "../packages/chat-kit/src/headless.js";
import { ChatProvider } from "../packages/chat-kit/src/react.js";
import { ChatConversationView } from "../packages/chat-ui-antd/src/index.js";
import { createLoadedClient, deadlineAt } from "./support/chat-react.js";

it("routes a real RemoteTool invocation into its conversation card and returns a clicked answer over Socket.IO", async () => {
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
  const prior = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const { client, memory } = await createLoadedClient();
  const conversationA = memory.fixtures.conversation.id;
  const routing = new Map([
    ["request-a", conversationA],
    ["request-b", "B"],
  ]);
  const askUser = createAskUserRemoteTool({
    resolveConversationId: ({ requestId }) => routing.get(requestId),
  });
  const http = createServer();
  const server = new Server(http, { transports: ["websocket"] });
  let socket!: Socket;
  server.of("/remote-tool").on("connection", (connected) => {
    socket = connected;
    connected.on("register", (_input, reply) =>
      reply({
        providerId: connected.id,
        registeredToolNames: ["ask_user"],
        error: null,
      }),
    );
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  if (address === null || typeof address === "string")
    throw new Error("No listener");
  const remote = createTFRobotRemoteToolClient({
    baseUrl: `http://127.0.0.1:${address.port}`,
    sessionProvider: {
      getSession: () => ({ kind: "bearer", token: "local-test" }),
    },
    tools: [askUser.tool],
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const switchConversation = async (id: string) => {
    const source = memory.fixtures.initialSnapshot;
    memory.controller.setSnapshot({
      ...source,
      conversation: { ...source.conversation, id },
      timeline: [],
      run: null,
    });
    await act(async () => {
      await client.loadConversation({
        conversationId: id,
        deadlineAt: deadlineAt(),
      });
    });
  };
  try {
    remote.start();
    await vi.waitFor(() => expect(remote.getSnapshot().status).toBe("ready"));
    await act(async () => {
      root.render(
        createElement(
          ChatProvider,
          { client, askUser },
          createElement(ChatConversationView, { getDeadlineAt: deadlineAt }),
        ),
      );
    });
    const invoke = (requestId: string, question: string) =>
      socket.timeout(5000).emitWithAck("remote_tool_invoke", {
        requestId,
        providerId: socket.id,
        toolName: "ask_user",
        params: {
          questions: [
            {
              question,
              header: "Choose",
              options: [
                { label: "Yes", description: "Continue" },
                { label: "No", description: "Stop" },
              ],
            },
          ],
        },
      });
    let response!: Promise<unknown>;
    await act(async () => {
      response = invoke("request-a", "Question for A");
      await vi.waitFor(() => expect(askUser.getSnapshot()).toHaveLength(1));
    });
    expect(container.textContent).toContain("Question for A");
    expect(document.querySelector(".ant-modal")).toBeNull();
    await act(async () => {
      container.querySelector<HTMLInputElement>('input[value="Yes"]')!.click();
    });
    await switchConversation("B");
    expect(container.textContent).not.toContain("Question for A");
    let other!: Promise<unknown>;
    await act(async () => {
      other = invoke("request-b", "Question for B");
      await vi.waitFor(() => expect(askUser.getSnapshot()).toHaveLength(2));
    });
    expect(container.textContent).toContain("Question for B");
    await switchConversation(conversationA);
    expect(container.textContent).toContain("Question for A");
    expect(container.textContent).not.toContain("Question for B");
    expect(
      container.querySelector<HTMLInputElement>('input[value="Yes"]')!.checked,
    ).toBe(true);
    const submit = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Submit answers"),
    );
    expect(submit).toBeDefined();
    await act(async () => {
      submit!.click();
    });
    await expect(response).resolves.toMatchObject({
      requestId: "request-a",
      success: true,
      done: true,
      resultForLlm: "1. Question for A: Yes",
    });
    expect(container.textContent).toContain("answered");
    await switchConversation("B");
    await act(async () => {
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent === "Cancel")!
        .click();
    });
    await expect(other).resolves.toMatchObject({
      requestId: "request-b",
      success: false,
      error: "cancelled",
    });
    expect(container.textContent).toContain("cancelled");
  } finally {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    remote.dispose();
    askUser.dispose();
    await client.dispose({ deadlineAt: deadlineAt() });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", prior);
  }
}, 15000);
