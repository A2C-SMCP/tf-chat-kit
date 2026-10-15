import { describe, expect, it, vi } from "vitest";
import { createLoadedClient, deadlineAt } from "./support/chat-react.js";
import { createMemoryChatGateway } from "../packages/chat-testing/src/index.js";
import { createChatClient } from "../packages/chat-runtime/src/index.js";
import type {
  GatewayResult,
  SendTextSuccess,
} from "../packages/chat-protocol/src/index.js";

const serverMessageId = "28d9e235-607c-40dc-a984-dba615b62e49";
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
};

describe("Runtime outgoing observations", () => {
  it.each([false, true])(
    "clears an acknowledged send only when its matching DTO is received (live first=%s)",
    async (liveFirst) => {
      const { client, memory } = await createLoadedClient();
      const ack = deferred<GatewayResult<SendTextSuccess>>();
      vi.spyOn(memory.gateway, "sendText").mockReturnValue(ack.promise);
      const conversationId = memory.fixtures.conversation.id;
      const initialItems = client.getSnapshot()!.timeline.length;
      const sent = client.sendText({
        conversationId,
        text: "Only once",
        deadlineAt: deadlineAt(),
      });
      expect(client.getSnapshot()!.timeline).toHaveLength(initialItems);
      expect(client.getSnapshot()!.outgoingMessages).toMatchObject([
        { status: "sending", text: "Only once" },
      ]);
      const emit = () =>
        memory.controller.emitUpdate({
          kind: "timeline.upsert",
          conversationId,
          item: {
            kind: "message",
            id: "server-display",
            conversationId,
            role: "user",
            serverMessageId,
            content: { kind: "text", text: "Only once" },
            createdAt: 100,
            provenance: { kind: "provisional", source: "live" },
          },
        });
      if (liveFirst) emit();
      ack.resolve({ ok: true, value: { runId: "run", serverMessageId } });
      await sent;
      if (!liveFirst) {
        expect(client.getSnapshot()!.outgoingMessages).toMatchObject([
          { status: "accepted", serverMessageId },
        ]);
        emit();
      }
      expect(client.getSnapshot()!.outgoingMessages ?? []).toHaveLength(0);
      expect(client.getSnapshot()!.timeline).toHaveLength(initialItems + 1);
      await client.dispose({ deadlineAt: deadlineAt() });
    },
  );

  it.each(["network", "timeout", "unknown", "authorization"] as const)(
    "retains a dismissible %s outcome without resending",
    async (code) => {
      const { client, memory } = await createLoadedClient();
      memory.controller.failNext("sendText", {
        code,
        message: "Fixture failure",
        retryable: true,
      });
      await client.sendText({
        conversationId: memory.fixtures.conversation.id,
        text: "Retain this",
        deadlineAt: deadlineAt(),
      });
      const message = client.getSnapshot()!.outgoingMessages![0]!;
      expect(message.status).toBe(
        code === "authorization" ? "failed" : "unknown",
      );
      client.dismissOutgoingMessage(message.id);
      expect(client.getSnapshot()!.outgoingMessages ?? []).toHaveLength(0);
      expect(
        memory.controller.calls.filter((call) => call.operation === "sendText"),
      ).toHaveLength(1);
      await client.dispose({ deadlineAt: deadlineAt() });
    },
  );

  it("does not resurrect a late receipt after switching away and back", async () => {
    const { client, memory } = await createLoadedClient();
    const ack = deferred<GatewayResult<SendTextSuccess>>();
    vi.spyOn(memory.gateway, "sendText").mockReturnValue(ack.promise);
    const conversationId = memory.fixtures.conversation.id;
    const sent = client.sendText({
      conversationId,
      text: "Old session",
      deadlineAt: deadlineAt(),
    });
    const created = await client.createConversation({
      title: "Other",
      deadlineAt: deadlineAt(),
    });
    if (!created.ok) throw new Error("Creation failed");
    await client.loadConversation({
      conversationId: created.value.id,
      deadlineAt: deadlineAt(),
    });
    await client.loadConversation({ conversationId, deadlineAt: deadlineAt() });
    ack.resolve({ ok: true, value: { runId: "run", serverMessageId } });
    await sent;
    expect(client.getSnapshot()!.outgoingMessages ?? []).toHaveLength(0);
    await client.dispose({ deadlineAt: deadlineAt() });
  });

  it("retains an in-flight receipt across a same-conversation reload", async () => {
    const { client, memory } = await createLoadedClient();
    const ack = deferred<GatewayResult<SendTextSuccess>>();
    vi.spyOn(memory.gateway, "sendText").mockReturnValue(ack.promise);
    const conversationId = memory.fixtures.conversation.id;
    const sent = client.sendText({
      conversationId,
      text: "Reload",
      deadlineAt: deadlineAt(),
    });
    await client.loadConversation({ conversationId, deadlineAt: deadlineAt() });
    expect(client.getSnapshot()!.outgoingMessages).toMatchObject([
      { status: "sending" },
    ]);
    ack.resolve({ ok: true, value: { runId: "run", serverMessageId } });
    await sent;
    expect(client.getSnapshot()!.outgoingMessages).toMatchObject([
      { status: "accepted" },
    ]);
    await client.dispose({ deadlineAt: deadlineAt() });
  });

  it("does not dispatch after a synchronous outgoing listener disposes the client", async () => {
    const { client, memory } = await createLoadedClient();
    const send = vi.spyOn(memory.gateway, "sendText");
    client.subscribe((snapshot) => {
      if (snapshot.outgoingMessages?.length)
        void client.dispose({ deadlineAt: deadlineAt() });
    });
    const result = await client.sendText({
      conversationId: memory.fixtures.conversation.id,
      text: "Cancelled",
      deadlineAt: deadlineAt(),
    });
    expect(result.ok).toBe(false);
    expect(send).not.toHaveBeenCalled();
    expect(client.getSnapshot()).toBeNull();
  });

  it("discards a conflicting disk identity and still synchronizes through the Gateway", async () => {
    const memory = createMemoryChatGateway();
    const conversationId = memory.fixtures.conversation.id;
    const events: string[] = [];
    const snapshot = {
      ...memory.fixtures.initialSnapshot,
      timeline: ["366", "367"].map((id) => ({
        kind: "message",
        id,
        conversationId,
        serverMessageId,
        role: "user",
        content: { kind: "text", text: "Corrupt cache" },
        createdAt: 100,
        provenance: { kind: "persisted", id, source: "cache" },
      })),
    };
    const record = {
      version: 1,
      scope: "default",
      conversationId,
      savedAt: Date.now(),
      snapshot,
      draft: { text: "", attachmentKeys: [], unavailableAttachments: 0 },
    };
    const wire = JSON.stringify({
      version: 1,
      epoch: 0,
      entries: { [conversationId]: { revision: 1, record } },
    });
    const client = createChatClient({
      gateway: memory.gateway,
      cache: {
        storage: { read: async () => wire, update: async () => {} },
        onEvent: (event) => {
          events.push(event.kind);
        },
      },
    });
    try {
      await expect(
        client.loadConversation({ conversationId, deadlineAt: deadlineAt() }),
      ).resolves.toMatchObject({ ok: true });
      expect(events).toContain("invalid-record");
      expect(
        memory.controller.calls.some(
          (call) => call.operation === "loadConversation",
        ),
      ).toBe(true);
      expect(client.getSnapshot()!.timeline).not.toContainEqual(
        expect.objectContaining({ serverMessageId }),
      );
    } finally {
      await client.dispose({ deadlineAt: deadlineAt() });
    }
  });

  it.each(["display", "bridge"] as const)(
    "ignores internally conflicting %s cache aliases",
    async (shape) => {
      const memory = createMemoryChatGateway();
      const conversationId = memory.fixtures.conversation.id;
      const events: string[] = [];
      const message = (id: string, serverId: string | undefined) => ({
        kind: "message" as const,
        id,
        conversationId,
        role: "user" as const,
        ...(serverId === undefined ? {} : { serverMessageId: serverId }),
        content: { kind: "text" as const, text: "Cached" },
        createdAt: 100,
        provenance: { kind: "provisional" as const, source: "live" as const },
      });
      const timeline =
        shape === "display"
          ? [message("same", "A"), message("same", "B")]
          : [
              message("first", "A"),
              message("second", "B"),
              message("first", undefined),
              message("second", "A"),
            ];
      const wire = JSON.stringify({
        version: 1,
        epoch: 0,
        entries: {
          [conversationId]: {
            revision: 1,
            record: {
              version: 1,
              scope: "default",
              conversationId,
              savedAt: Date.now(),
              snapshot: { ...memory.fixtures.initialSnapshot, timeline },
              draft: {
                text: "",
                attachmentKeys: [],
                unavailableAttachments: 0,
              },
            },
          },
        },
      });
      const client = createChatClient({
        gateway: memory.gateway,
        cache: {
          storage: { read: async () => wire, update: async () => {} },
          onEvent: (event) => events.push(event.kind),
        },
      });
      try {
        await expect(
          client.loadConversation({ conversationId, deadlineAt: deadlineAt() }),
        ).resolves.toMatchObject({ ok: true });
        expect(events).toContain("invalid-record");
        expect(
          memory.controller.calls.some(
            (call) => call.operation === "loadConversation",
          ),
        ).toBe(true);
      } finally {
        await client.dispose({ deadlineAt: deadlineAt() });
      }
    },
  );

  it.each(["server", "database", "display"] as const)(
    "prefers network history over a conflicting cached %s identity",
    async (conflict) => {
      const memory = createMemoryChatGateway();
      const conversationId = memory.fixtures.conversation.id;
      const events: string[] = [];
      const message = (
        id: string,
        serverId: string | undefined,
        databaseId: string,
      ) => ({
        kind: "message" as const,
        id,
        conversationId,
        role: "user" as const,
        serverMessageId: serverId,
        content: { kind: "text" as const, text: "Authoritative" },
        createdAt: 100,
        provenance: {
          kind: "persisted" as const,
          id: databaseId,
          source: "history" as const,
        },
      });
      const network = message(
        "network",
        conflict === "display" ? undefined : "A",
        "366",
      );
      const cached = message(
        conflict === "display" ? "network" : "cached",
        conflict === "server" ? "B" : "A",
        conflict === "database" || conflict === "display" ? "367" : "366",
      );
      const snapshot = {
        ...memory.fixtures.initialSnapshot,
        timeline: [network],
        pageInfo: { hasPreviousPage: true, previousCursor: "older" },
      };
      memory.controller.setSnapshot(snapshot);
      const wire = JSON.stringify({
        version: 1,
        epoch: 0,
        entries: {
          [conversationId]: {
            revision: 1,
            record: {
              version: 1,
              scope: "default",
              conversationId,
              savedAt: Date.now(),
              snapshot: { ...snapshot, timeline: [cached] },
              draft: {
                text: "",
                attachmentKeys: [],
                unavailableAttachments: 0,
              },
            },
          },
        },
      });
      const client = createChatClient({
        gateway: memory.gateway,
        cache: {
          storage: { read: async () => wire, update: async () => {} },
          onEvent: (event) => events.push(event.kind),
        },
      });
      try {
        await expect(
          client.loadConversation({ conversationId, deadlineAt: deadlineAt() }),
        ).resolves.toMatchObject({ ok: true });
        expect(events).toContain("invalid-record");
        expect(client.getSnapshot()!.timeline).toEqual([network]);
        memory.controller.emitUpdate({
          kind: "timeline.upsert",
          conversationId,
          item: {
            ...network,
            content: { kind: "text", text: "Live after handoff" },
          },
        });
        expect(client.getSnapshot()!.timeline[0]).toMatchObject({
          content: { text: "Live after handoff" },
        });
        await expect(
          client.sendText({
            conversationId,
            text: "Still writable",
            deadlineAt: deadlineAt(),
          }),
        ).resolves.toMatchObject({ ok: true });
      } finally {
        await client.dispose({ deadlineAt: deadlineAt() });
      }
    },
  );

  it("does not cache or replay pending/accepted sends", async () => {
    let encoded: string | null = null;
    const memory = createMemoryChatGateway();
    memory.controller.setSendTextResult({
      ok: true,
      value: { runId: "run", serverMessageId },
    });
    const storage = {
      read: async () => encoded,
      update: async (
        _scope: string,
        transform: (current: string | null) => string | null,
      ) => {
        encoded = transform(encoded);
      },
    };
    const client = createChatClient({
      gateway: memory.gateway,
      cache: { storage },
    });
    const conversationId = memory.fixtures.conversation.id;
    await client.loadConversation({ conversationId, deadlineAt: deadlineAt() });
    await client.sendText({
      conversationId,
      text: "Unconfirmed local text",
      deadlineAt: deadlineAt(),
    });
    await client.flushCache({ deadlineAt: deadlineAt() });
    expect(encoded).not.toContain("outgoingMessages");
    expect(encoded).not.toContain("Unconfirmed local text");
    await client.dispose({ deadlineAt: deadlineAt() });
  });
});
