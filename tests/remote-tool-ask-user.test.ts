import { expect, it, vi } from "vitest";
import {
  createAskUserRemoteTool,
  createRemoteToolClient,
} from "../packages/chat-kit/src/headless.js";
import { MemoryRemoteToolTransport } from "../packages/chat-testing/src/remote-tool.js";

const params = {
  title: "Choose",
  questions: [
    {
      question: "Which environment?",
      header: "Environment",
      multiSelect: false,
      options: [
        { label: "Local", description: "This device" },
        { label: "Cloud", description: "Remote" },
      ],
    },
    { question: "Why?", header: "Reason", options: [] },
    {
      question: "Features?",
      header: "Features",
      multiSelect: true,
      options: [
        { label: "A", description: "A" },
        { label: "B", description: "B" },
      ],
    },
  ],
};
const flush = async () => {
  for (let i = 0; i < 20; ++i) await Promise.resolve();
};
const setup = (
  resolveConversationId: Parameters<
    typeof createAskUserRemoteTool
  >[0]["resolveConversationId"] = ({ requestId }) =>
    requestId.startsWith("a") ? "A" : "B",
) => {
  const askUser = createAskUserRemoteTool({ resolveConversationId });
  const transport = new MemoryRemoteToolTransport();
  const client = createRemoteToolClient({ transport, tools: [askUser.tool] });
  client.start();
  transport.setConnectionState({ status: "ready" });
  const invoke = (requestId: string, input = params) => {
    const reply = vi.fn();
    transport.invoke({ requestId, toolName: "ask_user", params: input }, reply);
    return reply;
  };
  return { askUser, transport, client, invoke };
};
const answer = (requestId: string) => ({
  requestId,
  revision: requestId,
  action: "submit" as const,
  answers: { "0": "Local", "1": "Testing", "2": ["A", "B"] },
});

it("keeps concurrent requests in their original conversations and returns Front-compatible answers once", async () => {
  const { askUser, client, invoke } = setup();
  const a = invoke("a1"),
    b = invoke("b1");
  await flush();
  expect(
    askUser.getSnapshot().map((entry) => entry.request.conversationId),
  ).toEqual(["A", "B"]);
  expect(askUser.answer("B", answer("a1"))).toBe(false);
  expect(
    askUser.answer("A", { ...answer("a1"), answers: { "0": "Not an option" } }),
  ).toBe(false);
  expect(askUser.answer("A", answer("a1"))).toBe(true);
  expect(askUser.answer("A", answer("a1"))).toBe(false);
  expect(askUser.answer("B", answer("b1"))).toBe(true);
  await flush();
  expect(a).toHaveBeenCalledOnce();
  expect(b).toHaveBeenCalledOnce();
  expect(a).toHaveBeenCalledWith(
    expect.objectContaining({
      ok: true,
      resultForLlm:
        "1. Which environment?: Local\n2. Why?: Testing\n3. Features?: A, B",
      origin: expect.objectContaining({
        type: "askUser",
        response: { requestId: "a1", answers: answer("a1").answers },
      }),
    }),
  );
  expect(askUser.getSnapshot().map((entry) => entry.result?.status)).toEqual([
    "answered",
    "answered",
  ]);
  client.dispose();
  askUser.dispose();
});

it("expires at the provider deadline, keeps terminal feedback and rejects late answers", async () => {
  const { askUser, client, transport, invoke } = setup();
  const reply = invoke("a-timeout");
  await flush();
  const entry = askUser.getSnapshot()[0]!;
  transport.advanceTo(entry.deadlineAt - 1);
  expect(reply).not.toHaveBeenCalled();
  transport.advanceTo(entry.deadlineAt);
  await flush();
  expect(reply).toHaveBeenCalledWith({ ok: false, code: "timeout" });
  expect(askUser.getSnapshot()[0]?.result?.status).toBe("timeout");
  expect(askUser.answer("A", answer("a-timeout"))).toBe(false);
  client.dispose();
  askUser.dispose();
});

it("cancels, disconnects and disposes without reviving pending cards", async () => {
  const { askUser, client, transport, invoke } = setup();
  const cancel = invoke("a-cancel");
  await flush();
  expect(
    askUser.answer("A", {
      ...answer("a-cancel"),
      action: "cancel",
      answers: {},
    }),
  ).toBe(true);
  await flush();
  expect(cancel).toHaveBeenCalledWith({ ok: false, code: "cancelled" });
  invoke("a-disconnect");
  await flush();
  transport.setConnectionState({ status: "disconnected" });
  await flush();
  expect(askUser.getSnapshot()[1]?.result).toMatchObject({
    status: "failed",
    error: "disconnected",
  });
  transport.setConnectionState({ status: "ready" });
  const dispose = invoke("a-dispose");
  await flush();
  askUser.dispose();
  await flush();
  expect(dispose).toHaveBeenCalledWith({ ok: false, code: "disposed" });
  expect(askUser.getSnapshot()).toEqual([]);
  client.dispose();
});

it("requires host routing evidence, ignores model conversation fields and reports missing routing", async () => {
  const { askUser, client, invoke } = setup(() => undefined);
  const reply = invoke("a1", {
    ...params,
    conversationId: "A",
  } as typeof params);
  await flush();
  expect(reply).toHaveBeenCalledWith({
    ok: false,
    code: "conversation-unavailable",
  });
  expect(askUser.getSnapshot()).toEqual([]);
  expect(client.getSnapshot().lastCallError).toBe("conversation-unavailable");
  client.dispose();
  askUser.dispose();
});

it("does not display a late route resolution after timeout or disposal", async () => {
  let resolve!: (id: string) => void;
  const route = new Promise<string>((r) => {
    resolve = r;
  });
  const { askUser, client, transport, invoke } = setup(() => route);
  const reply = invoke("a1");
  await flush();
  transport.advanceTo(110000);
  await flush();
  resolve("A");
  await flush();
  expect(reply).toHaveBeenCalledWith({ ok: false, code: "timeout" });
  expect(askUser.getSnapshot()).toEqual([]);
  client.dispose();
  askUser.dispose();
});

it("validates bounded questions before displaying and isolates separate controllers", async () => {
  const first = setup(),
    second = setup();
  const invalid = first.invoke("a-bad", { ...params, questions: [] });
  await flush();
  expect(invalid).toHaveBeenCalledWith({
    ok: false,
    code: "invalid-parameters",
  });
  first.invoke("a1");
  await flush();
  expect(second.askUser.getSnapshot()).toEqual([]);
  const unsubscribe = first.askUser.subscribe(() => {
    throw new Error("Listener failed");
  });
  expect(first.askUser.answer("A", answer("a1"))).toBe(true);
  unsubscribe();
  first.client.dispose();
  second.client.dispose();
  first.askUser.dispose();
  second.askUser.dispose();
});
