import { describe, expect, it, vi } from "vitest";
import { DiagnosticStore } from "../packages/chat-runtime/src/diagnostics.js";
import { createChatClient } from "../packages/chat-runtime/src/index.js";
import {
  chatErrorSchema,
  formatChatDiagnostic,
  safeDiagnosticError,
  type ChatError,
} from "../packages/chat-protocol/src/index.js";
import { createMemoryChatGateway } from "../packages/chat-testing/src/index.js";
import { createLoadedClient, deadlineAt } from "./support/chat-react.js";

const error: ChatError = {
  code: "server",
  message: "private chat body Authorization: Bearer secret",
  details: { payload: "private response" },
  retryable: true,
  conversationId: "A",
};
describe("bounded safe diagnostics", () => {
  it("preserves the old schema and strips messages and arbitrary payloads", () => {
    expect(chatErrorSchema.parse(error).code).toBe("server");
    const safe = safeDiagnosticError({
      ...error,
      diagnostic: {
        requestId: "request-1",
        traceId: "trace-1",
        phase: "response",
      },
    });
    expect(safe).not.toHaveProperty("details");
    expect(JSON.stringify(safe)).not.toMatch(/private|Bearer|secret/);
    expect(safe.diagnostic?.requestId).toBe("request-1");
  });
  it("retains independent occurrences, counts repeats and freezes original context", () => {
    const store = new DiagnosticStore();
    store.record(
      { ...error, diagnostic: { generation: 1 } },
      "connection",
      { kind: "conversation", id: "A" },
      "one",
    );
    store.record(
      { ...error, diagnostic: { generation: 2 } },
      "connection",
      { kind: "conversation", id: "A" },
      "one",
    );
    store.record(error, "domain", { kind: "conversation", id: "A" }, "two");
    expect(store.read("A")).toHaveLength(2);
    expect(store.read("A")[0]).toMatchObject({
      count: 2,
      error: { diagnostic: { generation: 1 } },
    });
    store.resolve("one", "A");
    expect(store.read("A")[0]?.resolved).toBe(true);
    expect(store.read("A")[1]?.resolved).toBe(false);
    expect(store.read("B")).toHaveLength(0);
    expect(store.read("A")).toBe(store.read("A"));
    expect(formatChatDiagnostic(store.read("A")[0]!)).toContain(
      '"traceId": "Not provided"',
    );
    expect(formatChatDiagnostic(store.read("A")[0]!)).not.toContain("private");
  });
  it("bounds UTF-8 bytes, entry count and subscriptions per instance", () => {
    const onRecord = vi.fn(() => {
      throw new Error("host failure");
    });
    const store = new DiagnosticStore({ onRecord });
    const listener = vi.fn();
    store.subscribe(listener);
    for (let i = 0; i < 80; i++)
      store.record(
        {
          ...error,
          diagnostic: {
            requestId: "文".repeat(500),
            traceId: "字".repeat(500),
          },
        },
        "runtime",
        { kind: "conversation", id: "A" },
        `error-${i}`,
      );
    expect(store.read().length).toBeLessThanOrEqual(50);
    expect(store.read().at(-1)?.id).toBe("error-79");
    expect(Buffer.byteLength(JSON.stringify(store.read()))).toBeLessThanOrEqual(
      131072,
    );
    expect(
      store
        .read()
        .every((record) => Buffer.byteLength(JSON.stringify(record)) <= 8192),
    ).toBe(true);
    const second = new DiagnosticStore();
    expect(second.read()).toHaveLength(0);
    store.dispose();
    listener.mockClear();
    store.record(error, "runtime", { kind: "global" });
    expect(store.read()).toHaveLength(0);
    expect(listener).not.toHaveBeenCalled();
  });
  it("records load failure before any snapshot", async () => {
    const memory = createMemoryChatGateway();
    const client = createChatClient({
      cache: false,
      gateway: {
        ...memory.gateway,
        subscribe: memory.gateway.subscribe.bind(memory.gateway),
        dispose: memory.gateway.dispose.bind(memory.gateway),
        loadConversation: async () => ({ ok: false, error }),
      },
    });
    const result = await client.loadConversation({
      conversationId: memory.fixtures.conversation.id,
      deadlineAt: deadlineAt(),
    });
    expect(result.ok).toBe(false);
    expect(client.getSnapshot()).toBeNull();
    expect(client.getDiagnostics(memory.fixtures.conversation.id)).toHaveLength(
      1,
    );
    expect(
      client.getDiagnostics(memory.fixtures.conversation.id)[0]?.error
        .diagnostic?.operation,
    ).toBe("loadConversation");
    await client.dispose({ deadlineAt: deadlineAt() });
    expect(client.getDiagnostics()).toHaveLength(0);
  });
  it("does not double record structured events and their compatibility error callback", async () => {
    const { client, memory } = await createLoadedClient();
    const conversationId = memory.fixtures.conversation.id;
    memory.controller.emitUpdateToAll({
      kind: "error.reported",
      conversationId,
      error: { ...error, conversationId },
      source: "connection",
      scope: { kind: "subscription", id: "sub" },
      generation: 1,
      errorId: "one",
    });
    memory.controller.emitError({ ...error, conversationId });
    expect(client.getDiagnostics(conversationId)).toHaveLength(1);
    memory.controller.emitUpdateToAll({
      kind: "error.resolved",
      conversationId,
      errorId: "one",
    });
    expect(client.getDiagnostics(conversationId)[0]?.resolved).toBe(true);
    await client.dispose({ deadlineAt: deadlineAt() });
  });
});

it("keeps an oversize multibyte occurrence with a truncation marker", () => {
  const wide = "文".repeat(256);
  const onRecord = vi.fn();
  const store = new DiagnosticStore({ appVersion: wide, onRecord });
  store.record(
    {
      ...error,
      conversationId: wide,
      diagnostic: {
        operation: wide,
        phase: wide,
        reasonCode: wide,
        operationId: wide,
        errorId: wide,
        runId: wide,
        requestId: wide,
        traceId: wide,
        businessCode: wide,
      },
    },
    "runtime",
    { kind: "conversation", id: wide },
    wide,
  );
  expect(store.read()).toHaveLength(1);
  const record = store.read()[0]!;
  expect(record.truncated).toBe(true);
  expect(record.error.diagnostic?.operationId).toBe(wide);
  expect(Buffer.byteLength(JSON.stringify(record))).toBeLessThanOrEqual(8192);
  expect(onRecord).toHaveBeenCalledOnce();
});
it("records error-only third-party Gateway callbacks even when they already have an error ID", async () => {
  const { client, memory } = await createLoadedClient();
  const conversationId = memory.fixtures.conversation.id;
  memory.controller.emitError({
    ...error,
    conversationId,
    diagnostic: { errorId: "third-party" },
  });
  expect(client.getDiagnostics(conversationId)).toHaveLength(1);
  expect(client.getDiagnostics(conversationId)[0]?.id).toBe("third-party");
  memory.controller.emitError({
    ...error,
    conversationId,
    diagnostic: { errorId: "third-party" },
  });
  expect(client.getDiagnostics(conversationId)[0]?.count).toBe(2);
  expect(client.getSnapshot()?.activeErrors).toHaveLength(1);
  await client.dispose({ deadlineAt: deadlineAt() });
});
it("keeps a late unknown send result on its original conversation without updating the selected one", async () => {
  const { client, memory } = await createLoadedClient();
  const conversationId = memory.fixtures.conversation.id;
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.spyOn(memory.gateway, "sendText").mockImplementation(async () => {
    await held;
    return {
      ok: false,
      error: {
        code: "timeout",
        message: "timed out",
        retryable: true,
        conversationId,
      },
    };
  });
  const pending = client.sendText({
    conversationId,
    text: "private body",
    deadlineAt: deadlineAt(),
  });
  memory.controller.setSnapshot({
    ...memory.fixtures.initialSnapshot,
    conversation: { ...memory.fixtures.conversation, id: "B" },
    timeline: [],
    run: null,
  });
  await client.loadConversation({
    conversationId: "B",
    deadlineAt: deadlineAt(),
  });
  release();
  const result = await pending;
  expect(result.ok).toBe(false);
  expect(client.getSnapshot()?.conversation.id).toBe("B");
  expect(client.getSnapshot()?.error).toBeUndefined();
  expect(client.getDiagnostics("B")).toHaveLength(0);
  expect(
    client.getDiagnostics(conversationId)[0]?.error.diagnostic,
  ).toMatchObject({ operation: "sendText", outcome: "unknown" });
  await client.dispose({ deadlineAt: deadlineAt() });
});

it("binds envelope-only conversation errors and resolves them", async () => {
  const { client, memory } = await createLoadedClient();
  const conversationId = memory.fixtures.conversation.id;
  memory.controller.emitUpdateToAll({
    kind: "error.reported",
    conversationId,
    error: { code: "server", message: "private body", retryable: false },
    source: "domain",
    scope: { kind: "conversation", id: conversationId },
    generation: 1,
    errorId: "envelope",
  });
  expect(client.getDiagnostics(conversationId)).toHaveLength(1);
  memory.controller.emitUpdateToAll({
    kind: "error.resolved",
    conversationId,
    errorId: "envelope",
  });
  expect(client.getDiagnostics(conversationId)[0]?.resolved).toBe(true);
  await client.dispose({ deadlineAt: deadlineAt() });
});
it("captures embedded run errors once and retains resolved history", async () => {
  const memory = createMemoryChatGateway();
  const conversationId = memory.fixtures.conversation.id;
  const run = {
    id: "failed-run",
    conversationId,
    status: "failed" as const,
    canInterrupt: false,
    error: {
      code: "server" as const,
      message: "private body",
      retryable: false,
    },
  };
  const snapshot = { ...memory.fixtures.initialSnapshot, run };
  memory.controller.setSnapshot(snapshot);
  const { client } = await createLoadedClient(memory);
  expect(client.getDiagnostics(conversationId)).toHaveLength(1);
  memory.controller.emitUpdateToAll({ kind: "snapshot.replace", snapshot });
  expect(client.getDiagnostics(conversationId)[0]?.count).toBe(1);
  expect(JSON.stringify(client.getDiagnostics())).not.toContain("private body");
  memory.controller.emitUpdateToAll({
    kind: "snapshot.replace",
    snapshot: { ...snapshot, run: null },
  });
  expect(client.getDiagnostics(conversationId)[0]?.resolved).toBe(true);
  await client.dispose({ deadlineAt: deadlineAt() });
});
it.each(["\u0000", "\ud800"])(
  "bounds JSON-escaped characters in identity fields (%j)",
  (character) => {
    const wide = character.repeat(256);
    const store = new DiagnosticStore({ appVersion: wide });
    store.record(
      {
        ...error,
        conversationId: wide,
        diagnostic: {
          operation: wide,
          phase: wide,
          reasonCode: wide,
          operationId: wide,
          errorId: wide,
          runId: wide,
          requestId: wide,
          traceId: wide,
          businessCode: wide,
        },
      },
      "runtime",
      { kind: "conversation", id: wide },
      wide,
    );
    expect(store.read()).toHaveLength(1);
    expect(
      Buffer.byteLength(JSON.stringify(store.read()[0])),
    ).toBeLessThanOrEqual(8192);
  },
);

it("records an unscoped legacy update once as global", async () => {
  const { client, memory } = await createLoadedClient();
  memory.controller.emitUpdateToAll({
    kind: "error.reported",
    error: { code: "network", message: "private", retryable: true },
  });
  expect(client.getDiagnostics()).toHaveLength(1);
  expect(client.getDiagnostics()[0]?.scope.kind).toBe("global");
  expect(client.getDiagnostics(memory.fixtures.conversation.id)).toHaveLength(
    0,
  );
  const occurrenceId = client.getSnapshot()?.activeErrors?.[0]?.id;
  expect(occurrenceId).toBeDefined();
  memory.controller.emitUpdateToAll({
    kind: "error.resolved",
    conversationId: memory.fixtures.conversation.id,
    errorId: occurrenceId!,
  });
  expect(client.getDiagnostics()[0]?.resolved).toBe(true);
  await client.dispose({ deadlineAt: deadlineAt() });
});
