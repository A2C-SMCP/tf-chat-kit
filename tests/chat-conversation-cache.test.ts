import { describe, expect, it, vi } from "vitest";
import {
  createChatClient,
  createConversationWorkspaceController,
  type ConversationCacheStorage,
  type ConversationCacheEvent,
} from "../packages/chat-runtime/src/index.js";
import { createMemoryChatGateway } from "../packages/chat-testing/src/index.js";
import type {
  ChatSnapshot,
  GatewayRequestOptions,
  Message,
} from "../packages/chat-protocol/src/index.js";
import { deadlineAt, flushMicrotasks } from "./support/chat-react.js";

class AtomicStorage implements ConversationCacheStorage {
  readonly scopes = new Map<string, string>();
  #tail: Promise<void> = Promise.resolve();
  async read(scope: string): Promise<string | null> {
    await this.#tail;
    return this.scopes.get(scope) ?? null;
  }
  update(
    scope: string,
    transform: (current: string | null) => string | null,
  ): Promise<void> {
    const task = this.#tail.then(() => {
      const next = transform(this.scopes.get(scope) ?? null);
      if (next === null) this.scopes.delete(scope);
      else this.scopes.set(scope, next);
    });
    this.#tail = task.catch(() => undefined);
    return task;
  }
}

const options = (): GatewayRequestOptions => ({ deadlineAt: deadlineAt() });
const snapshotFor = (base: ChatSnapshot, id: string): ChatSnapshot => ({
  ...base,
  conversation: { ...base.conversation, id },
  timeline: base.timeline.map((item) => ({ ...item, conversationId: id })),
  run: base.run === null ? null : { ...base.run, conversationId: id },
});
const message = (
  id: string,
  conversationId: string,
  createdAt: number,
  text = id,
): Message => ({
  kind: "message",
  id,
  conversationId,
  createdAt,
  role: "assistant",
  content: { kind: "text", text },
});

describe("conversation cache", () => {
  it("keeps interleaved history and live changes when an older reload response arrives", async () => {
    const memory = createMemoryChatGateway();
    const a = memory.fixtures.conversation.id;
    const base = {
      ...memory.fixtures.initialSnapshot,
      timeline: [message("head", a, 2)],
      pageInfo: { hasPreviousPage: true, previousCursor: "older" },
    };
    memory.controller.setSnapshot(base);
    const client = createChatClient({ gateway: memory.gateway });
    await client.loadConversation({ ...options(), conversationId: a });
    const hold = memory.controller.holdNext("loadConversation");
    const reload = client.loadConversation({ ...options(), conversationId: a });
    await hold.started;
    memory.controller.setSnapshot({
      ...base,
      timeline: [message("history", a, 1)],
      pageInfo: { hasPreviousPage: false },
    });
    expect(
      (
        await client.loadConversation({
          ...options(),
          conversationId: a,
          previousCursor: "older",
        })
      ).ok,
    ).toBe(true);
    memory.controller.emitUpdateToAll({
      kind: "timeline.upsert",
      conversationId: a,
      item: message("head", a, 2, "Live revision"),
    });
    memory.controller.setSnapshot(base);
    hold.release();
    expect((await reload).ok).toBe(true);
    expect(client.getSnapshot()?.timeline.map((item) => item.id)).toEqual([
      "history",
      "head",
    ]);
    expect(client.getSnapshot()?.timeline[1]).toMatchObject({
      content: { text: "Live revision" },
    });
    expect(client.getSnapshot()?.pageInfo.hasPreviousPage).toBe(false);
    memory.controller.emitUpdateToAll({
      kind: "snapshot.replace",
      snapshot: base,
    });
    expect(client.getSnapshot()?.timeline.map((item) => item.id)).toEqual([
      "history",
      "head",
    ]);
    await client.dispose(options());
  });

  it("persists an inactive conversation's cleared draft after its send is acknowledged", async () => {
    const storage = new AtomicStorage();
    const memory = createMemoryChatGateway();
    const a = memory.fixtures.conversation.id;
    memory.controller.setSnapshot(
      snapshotFor(memory.fixtures.initialSnapshot, "b"),
    );
    const client = createChatClient({
      gateway: memory.gateway,
      cache: { storage },
    });
    await client.loadConversation({ ...options(), conversationId: a });
    client.setComposerDraft({ conversationId: a, text: "Send once" });
    const hold = memory.controller.holdNext("sendText");
    const sending = client.sendComposerDraft({
      ...options(),
      conversationId: a,
      clientMessageId: "one-send",
    });
    await hold.started;
    await client.loadConversation({ ...options(), conversationId: "b" });
    hold.release();
    expect((await sending).ok).toBe(true);
    await client.flushCache(options());
    await client.dispose(options());
    const secondMemory = createMemoryChatGateway();
    const second = createChatClient({
      gateway: secondMemory.gateway,
      cache: { storage },
    });
    await second.loadConversation({ ...options(), conversationId: a });
    expect(second.getComposerDraft(a).text).toBe("");
    expect(
      memory.controller.calls.filter((call) => call.operation === "sendText"),
    ).toHaveLength(1);
    await second.dispose(options());
  });

  it("exposes failed explicit clears instead of reporting false success", async () => {
    const memory = createMemoryChatGateway();
    const storage: ConversationCacheStorage = {
      read: async () => null,
      update: async () => {
        throw new Error("Storage unavailable");
      },
    };
    const client = createChatClient({
      gateway: memory.gateway,
      cache: { storage },
    });
    await client.loadConversation({
      ...options(),
      conversationId: memory.fixtures.conversation.id,
    });
    await expect(client.clearCache(options())).rejects.toThrow(
      "Storage unavailable",
    );
    expect(client.getCacheState().storageError).toBe(true);
    await client.dispose(options());
  });

  it("defaults to isolated memory caching and publishes A before its reload completes", async () => {
    const memory = createMemoryChatGateway();
    const client = createChatClient({ gateway: memory.gateway });
    const a = memory.fixtures.conversation.id;
    memory.controller.setSnapshot(
      snapshotFor(memory.fixtures.initialSnapshot, "b"),
    );
    await client.loadConversation({ ...options(), conversationId: a });
    client.setComposerDraft({ conversationId: a, text: "Draft A" });
    await client.loadConversation({ ...options(), conversationId: "b" });
    const held = memory.controller.holdNext("loadConversation");
    const loading = client.loadConversation({
      ...options(),
      conversationId: a,
    });
    try {
      await held.started;
      expect(client.getSnapshot()?.conversation.id).toBe(a);
      expect(client.getCacheState()).toMatchObject({
        source: "memory",
        status: "syncing",
        freshness: "fresh",
      });
      expect(client.getComposerDraft(a).text).toBe("Draft A");
      expect(client.getSnapshot()?.run).toBeNull();
      expect(client.getSnapshot()?.pendingInteraction).toBeUndefined();
      expect(
        (
          await client.sendText({
            ...options(),
            conversationId: a,
            text: "Must not send",
          })
        ).ok,
      ).toBe(false);
      held.release();
      expect((await loading).ok).toBe(true);
      expect(client.getCacheState().status).toBe("ready");
    } finally {
      held.release();
      await loading;
      await client.dispose(options());
    }
  });

  it("retains cached workspace content on sync failure and retries without granting offline commands", async () => {
    const memory = createMemoryChatGateway();
    const client = createChatClient({ gateway: memory.gateway });
    const controller = createConversationWorkspaceController({
      client,
      getDeadlineAt: deadlineAt,
    });
    const a = memory.fixtures.conversation.id;
    memory.controller.setSnapshot(
      snapshotFor(memory.fixtures.initialSnapshot, "b"),
    );
    await controller.selectConversation(a);
    await controller.selectConversation("b");
    memory.controller.failNext("loadConversation", {
      code: "network",
      message: "Offline",
      retryable: true,
    });
    const result = await controller.selectConversation(a);
    expect(result.ok).toBe(false);
    expect(controller.getSnapshot()).toMatchObject({
      selectedConversationId: a,
      selectionStatus: "ready",
    });
    expect(client.getCacheState()).toMatchObject({
      status: "error",
      source: "memory",
    });
    expect(client.getSnapshot()?.lifecycle?.status).toBe("offline");
    expect((await controller.selectConversation(a)).ok).toBe(true);
    expect(client.getCacheState().status).toBe("ready");
    controller.dispose();
    await client.dispose(options());
  });

  it("preserves explicitly disabled loading and does not share defaults between clients", async () => {
    for (const cache of [false, undefined] as const) {
      const memory = createMemoryChatGateway();
      const client = createChatClient({
        gateway: memory.gateway,
        ...(cache === undefined ? {} : { cache }),
      });
      const held = memory.controller.holdNext("loadConversation");
      const loading = client.loadConversation({
        ...options(),
        conversationId: memory.fixtures.conversation.id,
      });
      await held.started;
      expect(client.getSnapshot()).toBeNull();
      expect(client.getCacheState().source).toBe("none");
      if (cache === false)
        expect(client.getCacheState().status).toBe("disabled");
      held.release();
      await loading;
      await client.dispose(options());
    }
  });

  it("reports expiry and evicts by capacity", async () => {
    let now = 1000;
    const events: ConversationCacheEvent[] = [];
    const memory = createMemoryChatGateway();
    const client = createChatClient({
      gateway: memory.gateway,
      cache: {
        maxConversations: 1,
        staleAfterMs: 10,
        expireAfterMs: 20,
        now: () => now,
        onEvent: (event) => events.push(event),
      },
    });
    const a = memory.fixtures.conversation.id;
    memory.controller.setSnapshot(
      snapshotFor(memory.fixtures.initialSnapshot, "b"),
    );
    await client.loadConversation({ ...options(), conversationId: a });
    await client.loadConversation({ ...options(), conversationId: "b" });
    expect(events).toContainEqual(
      expect.objectContaining({ kind: "evicted", conversationId: a }),
    );
    now += 30;
    memory.controller.failNext("loadConversation", {
      code: "network",
      message: "Offline",
      retryable: true,
    });
    await client.loadConversation({ ...options(), conversationId: "b" });
    expect(events).toContainEqual(
      expect.objectContaining({ kind: "expired", conversationId: "b" }),
    );
    await client.dispose(options());
  });

  it("restores a versioned record and draft in a new instance, without persisting resource credentials", async () => {
    const storage = new AtomicStorage();
    const memory = createMemoryChatGateway();
    const a = memory.fixtures.conversation.id;
    const client = createChatClient({
      gateway: memory.gateway,
      cache: { storage },
    });
    await client.loadConversation({ ...options(), conversationId: a });
    client.setComposerDraft({
      conversationId: a,
      text: "Remember me",
      attachments: [
        {
          uri: "https://private.test/file?token=do-not-persist",
          mimeType: "text/plain",
        },
      ],
    });
    memory.controller.emitUpdateToAll({
      kind: "timeline.upsert",
      conversationId: a,
      item: {
        ...message("resource", a, Date.now()),
        content: {
          kind: "media",
          mediaType: "image",
          summary: "image",
          resource: { uri: "https://private.test/image?signature=secret" },
        },
      },
    });
    await client.flushCache(options());
    await client.dispose(options());
    const encoded = storage.scopes.get("default")!;
    expect(encoded).not.toContain("do-not-persist");
    expect(encoded).not.toContain("signature=secret");
    const secondMemory = createMemoryChatGateway();
    const second = createChatClient({
      gateway: secondMemory.gateway,
      cache: { storage },
    });
    const held = secondMemory.controller.holdNext("loadConversation");
    const loading = second.loadConversation({
      ...options(),
      conversationId: a,
    });
    try {
      await held.started;
      expect(second.getCacheState()).toMatchObject({
        source: "storage",
        status: "syncing",
        unavailableAttachments: 1,
      });
      expect(second.getComposerDraft(a)).toMatchObject({
        text: "Remember me",
        attachments: [],
      });
      expect(second.getSnapshot()?.run).toBeNull();
      expect(
        secondMemory.controller.calls.some(
          (call) =>
            call.operation === "sendText" || call.operation === "sendMessage",
        ),
      ).toBe(false);
      held.release();
      await loading;
      secondMemory.controller.setSnapshot(
        snapshotFor(secondMemory.fixtures.initialSnapshot, "b"),
      );
      await second.loadConversation({ ...options(), conversationId: "b" });
      await second.loadConversation({ ...options(), conversationId: a });
      expect(second.getCacheState().unavailableAttachments).toBe(1);
    } finally {
      held.release();
      await loading;
      await second.dispose(options());
    }
  });

  it("revalidates opaque attachment identities before making them sendable", async () => {
    const storage = new AtomicStorage();
    const resolver = {
      identify: () => "file-42",
      resolve: vi.fn(async () => ({
        uri: "https://files.test/fresh",
        mimeType: "text/plain",
      })),
    };
    const memory = createMemoryChatGateway();
    const client = createChatClient({
      gateway: memory.gateway,
      cache: { storage, attachments: resolver },
    });
    const a = memory.fixtures.conversation.id;
    await client.loadConversation({ ...options(), conversationId: a });
    client.setComposerDraft({
      conversationId: a,
      text: "Draft",
      attachments: [
        {
          uri: "https://files.test/expired?signature=old",
          mimeType: "text/plain",
        },
      ],
    });
    await client.dispose(options());
    const nextMemory = createMemoryChatGateway();
    const next = createChatClient({
      gateway: nextMemory.gateway,
      cache: { storage, attachments: resolver },
    });
    await next.loadConversation({ ...options(), conversationId: a });
    await flushMicrotasks();
    expect(resolver.resolve).toHaveBeenCalled();
    expect(next.getComposerDraft(a).attachments).toEqual([
      { uri: "https://files.test/fresh", mimeType: "text/plain" },
    ]);
    await next.dispose(options());
  });

  it.each([
    "broken",
    JSON.stringify({ version: 999 }),
    JSON.stringify({
      version: 1,
      epoch: 0,
      entries: { bad: { revision: 1, record: {} } },
    }),
  ])("falls back safely for invalid storage %s", async (raw) => {
    const storage = new AtomicStorage();
    storage.scopes.set("default", raw);
    const memory = createMemoryChatGateway();
    const client = createChatClient({
      gateway: memory.gateway,
      cache: { storage },
    });
    expect(
      (
        await client.loadConversation({
          ...options(),
          conversationId: memory.fixtures.conversation.id,
        })
      ).ok,
    ).toBe(true);
    expect(client.getSnapshot()?.conversation.id).toBe(
      memory.fixtures.conversation.id,
    );
    await client.dispose(options());
  });

  it("keeps scopes separate and rejects writes from a client whose scope has been cleared", async () => {
    const storage = new AtomicStorage();
    const firstMemory = createMemoryChatGateway();
    const secondMemory = createMemoryChatGateway();
    const first = createChatClient({
      gateway: firstMemory.gateway,
      cache: { storage, scope: "one" },
    });
    const second = createChatClient({
      gateway: secondMemory.gateway,
      cache: { storage, scope: "two" },
    });
    const a = firstMemory.fixtures.conversation.id;
    await first.loadConversation({ ...options(), conversationId: a });
    first.setComposerDraft({ conversationId: a, text: "Private one" });
    await first.flushCache(options());
    await second.loadConversation({ ...options(), conversationId: a });
    expect(second.getCacheState().source).toBe("none");
    expect(second.getComposerDraft(a).text).toBe("");
    const peerMemory = createMemoryChatGateway();
    const events: ConversationCacheEvent[] = [];
    const peer = createChatClient({
      gateway: peerMemory.gateway,
      cache: { storage, scope: "one", onEvent: (event) => events.push(event) },
    });
    await peer.loadConversation({ ...options(), conversationId: a });
    await peer.flushCache(options());
    await first.clearCache(options());
    peer.setComposerDraft({ conversationId: a, text: "Must not resurrect" });
    await peer.flushCache(options());
    expect(storage.scopes.get("one")).not.toContain("Must not resurrect");
    expect(events).toContainEqual(
      expect.objectContaining({ kind: "write-conflict" }),
    );
    await Promise.all([
      first.dispose(options()),
      second.dispose(options()),
      peer.dispose(options()),
    ]);
  });

  it("deletion invalidates pending restoration and persistence", async () => {
    const storage = new AtomicStorage();
    const memory = createMemoryChatGateway();
    const client = createChatClient({
      gateway: memory.gateway,
      cache: { storage },
    });
    const a = memory.fixtures.conversation.id;
    await client.loadConversation({ ...options(), conversationId: a });
    await client.flushCache(options());
    const held = memory.controller.holdNext("loadConversation");
    const loading = client.loadConversation({
      ...options(),
      conversationId: a,
    });
    await held.started;
    expect(
      (await client.deleteConversation({ ...options(), conversationId: a })).ok,
    ).toBe(true);
    held.release();
    await loading;
    await client.flushCache(options());
    expect(client.getSnapshot()).toBeNull();
    expect(storage.scopes.get("default")).not.toContain('"conversationId"');
    await client.dispose(options());
  });

  it("bridges a latest-page gap and retains older cached history without duplicate or regressed messages", async () => {
    const memory = createMemoryChatGateway();
    const a = memory.fixtures.conversation.id;
    const initial = {
      ...memory.fixtures.initialSnapshot,
      timeline: [message("old", a, 1), message("middle", a, 2)],
      pageInfo: { hasPreviousPage: true, previousCursor: "older" },
    };
    memory.controller.setSnapshot(initial);
    const client = createChatClient({ gateway: memory.gateway });
    await client.loadConversation({ ...options(), conversationId: a });
    const load = vi
      .spyOn(memory.gateway, "loadConversation")
      .mockImplementation(async (input) => ({
        ok: true,
        value: {
          ...initial,
          timeline:
            input.previousCursor === undefined
              ? [message("new", a, 4)]
              : [message("middle", a, 2, "server edit"), message("gap", a, 3)],
          pageInfo: {
            hasPreviousPage: true,
            previousCursor:
              input.previousCursor === undefined ? "gap-page" : "older",
          },
        },
      }));
    const result = await client.loadConversation({
      ...options(),
      conversationId: a,
    });
    expect(result.ok).toBe(true);
    expect(client.getSnapshot()?.timeline.map((item) => item.id)).toEqual([
      "old",
      "middle",
      "gap",
      "new",
    ]);
    expect(client.getSnapshot()?.timeline[1]).toMatchObject({
      content: { text: "server edit" },
    });
    expect(client.getSnapshot()?.pageInfo.previousCursor).toBe("older");
    expect(load).toHaveBeenCalledTimes(2);
    load.mockRestore();
    await client.dispose(options());
  });
  it("retains a gap cursor when a realtime latest page has no overlap", async () => {
    const memory = createMemoryChatGateway();
    const a = memory.fixtures.conversation.id;
    memory.controller.setSnapshot({
      ...memory.fixtures.initialSnapshot,
      timeline: [message("old", a, 1)],
      pageInfo: { hasPreviousPage: false },
    });
    const client = createChatClient({ gateway: memory.gateway });
    await client.loadConversation({ ...options(), conversationId: a });
    memory.controller.emitUpdateToAll({
      kind: "snapshot.replace",
      snapshot: {
        ...memory.fixtures.initialSnapshot,
        timeline: [message("new", a, 3)],
        pageInfo: { hasPreviousPage: true, previousCursor: "gap" },
      },
    });
    expect(client.getSnapshot()?.timeline.map((item) => item.id)).toEqual([
      "old",
      "new",
    ]);
    expect(client.getSnapshot()?.pageInfo).toEqual({
      hasPreviousPage: true,
      previousCursor: "gap",
    });
    await client.dispose(options());
  });

  it("preserves server deletion results and workspace completion when storage fails", async () => {
    const storage = new AtomicStorage();
    const memory = createMemoryChatGateway();
    const client = createChatClient({
      gateway: memory.gateway,
      cache: { storage },
    });
    const a = memory.fixtures.conversation.id;
    const workspace = createConversationWorkspaceController({
      client,
      getDeadlineAt: deadlineAt,
    });
    await workspace.selectConversation(a);
    await client.flushCache(options());
    vi.spyOn(storage, "update").mockRejectedValue(new Error("storage-down"));
    expect((await workspace.deleteConversation(a)).ok).toBe(true);
    expect(workspace.getSnapshot().deletingConversationIds).toEqual([]);
    expect(client.getCacheState().storageError).toBe(true);
    workspace.dispose();
    await client.dispose(options());
  });

  it("persists edits to restored drafts while server synchronization is offline", async () => {
    const storage = new AtomicStorage();
    const memory = createMemoryChatGateway();
    const a = memory.fixtures.conversation.id;
    const first = createChatClient({
      gateway: memory.gateway,
      cache: { storage },
    });
    await first.loadConversation({ ...options(), conversationId: a });
    first.setComposerDraft({ conversationId: a, text: "before" });
    await first.dispose(options());
    const next = createMemoryChatGateway();
    next.controller.failNext("loadConversation", {
      code: "network",
      message: "offline",
      retryable: true,
    });
    const second = createChatClient({
      gateway: next.gateway,
      cache: { storage },
    });
    await second.loadConversation({ ...options(), conversationId: a });
    second.setComposerDraft({ conversationId: a, text: "after-offline" });
    await second.flushCache(options());
    expect(storage.scopes.get("default")).toContain("after-offline");
    await second.dispose(options());
  });

  it("accepts authoritative tool transitions after restoring a display-only event", async () => {
    const storage = new AtomicStorage();
    const memory = createMemoryChatGateway();
    const a = memory.fixtures.conversation.id;
    const head = message("head", a, 2);
    memory.controller.setSnapshot({
      ...memory.fixtures.initialSnapshot,
      timeline: [
        {
          kind: "agent-event",
          eventCategory: "tool",
          eventType: "Tool",
          id: "tool-a",
          conversationId: a,
          createdAt: 1,
          status: "running",
          transitions: [
            {
              id: "start",
              status: "running",
              occurredAt: 1,
              toolReturn: { result: "sensitive-tool-payload" },
            },
          ],
        },
        head,
      ],
      pageInfo: { hasPreviousPage: false },
    });
    const first = createChatClient({
      gateway: memory.gateway,
      cache: { storage },
    });
    await first.loadConversation({ ...options(), conversationId: a });
    await first.dispose(options());
    expect(storage.scopes.get("default")).not.toContain(
      "sensitive-tool-payload",
    );
    const next = createMemoryChatGateway();
    next.controller.setSnapshot({
      ...next.fixtures.initialSnapshot,
      timeline: [head],
      pageInfo: { hasPreviousPage: true, previousCursor: "previous" },
    });
    const second = createChatClient({
      gateway: next.gateway,
      cache: { storage },
    });
    expect(
      (await second.loadConversation({ ...options(), conversationId: a })).ok,
    ).toBe(true);
    next.controller.emitUpdateToAll({
      kind: "event.transition.upsert",
      conversationId: a,
      event: {
        id: "tool-a",
        eventCategory: "tool",
        eventType: "Tool",
        transition: {
          id: "end",
          status: "success",
          occurredAt: 3,
          toolReturn: { success: true, result: "done" },
        },
      },
    });
    expect(
      second.getSnapshot()?.timeline.find((item) => item.id === "tool-a"),
    ).toMatchObject({ status: "success" });
    expect(second.getSnapshot()?.error).toBeUndefined();
    await second.dispose(options());
  });

  it("does not let a cache listener's newer selection be superseded by the outer load", async () => {
    const memory = createMemoryChatGateway();
    const a = memory.fixtures.conversation.id;
    memory.controller.setSnapshot(
      snapshotFor(memory.fixtures.initialSnapshot, "b"),
    );
    const client = createChatClient({ gateway: memory.gateway });
    let newer: ReturnType<typeof client.loadConversation> | undefined;
    const listener = client.subscribeCacheState(() => {
      if (client.getCacheState().conversationId === a && newer === undefined)
        newer = client.loadConversation({ ...options(), conversationId: "b" });
    });
    expect(
      (await client.loadConversation({ ...options(), conversationId: a })).ok,
    ).toBe(false);
    expect((await newer)?.ok).toBe(true);
    expect(client.getSnapshot()?.conversation.id).toBe("b");
    listener.dispose();
    await client.dispose(options());
  });
  it("does not restore an old disk record while its clearing transaction is pending", async () => {
    const storage = new AtomicStorage();
    const memory = createMemoryChatGateway();
    const a = memory.fixtures.conversation.id;
    const first = createChatClient({
      gateway: memory.gateway,
      cache: { storage },
    });
    await first.loadConversation({ ...options(), conversationId: a });
    await first.dispose(options());
    const next = createMemoryChatGateway();
    const second = createChatClient({
      gateway: next.gateway,
      cache: { storage },
    });
    next.controller.failNext("loadConversation", {
      code: "network",
      message: "offline",
      retryable: true,
    });
    await second.loadConversation({ ...options(), conversationId: a });
    await second.flushCache(options());
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const update = storage.update.bind(storage);
    vi.spyOn(storage, "update").mockImplementation(async (...args) => {
      await barrier;
      await update(...args);
    });
    const clearing = second.clearConversationCache(a, options());
    next.controller.failNext("loadConversation", {
      code: "network",
      message: "offline",
      retryable: true,
    });
    await second.loadConversation({ ...options(), conversationId: a });
    expect(second.getCacheState().source).toBe("none");
    expect(second.getSnapshot()?.timeline).toEqual([]);
    release();
    await clearing;
    await second.dispose(options());
  });
  it("retains pending attachment keys through synchronization and a selection change", async () => {
    const storage = new AtomicStorage();
    let resolve!: (value: { uri: string; mimeType: string }) => void;
    const pending = new Promise<{ uri: string; mimeType: string }>((done) => {
      resolve = done;
    });
    const attachments = {
      identify: () => "stable-file",
      resolve: () => pending,
    };
    const memory = createMemoryChatGateway();
    const a = memory.fixtures.conversation.id;
    const first = createChatClient({
      gateway: memory.gateway,
      cache: { storage, attachments },
    });
    await first.loadConversation({ ...options(), conversationId: a });
    first.setComposerDraft({
      conversationId: a,
      text: "attachment draft",
      attachments: [
        {
          uri: "https://files.test/old?signature=secret",
          mimeType: "text/plain",
        },
      ],
    });
    await first.dispose(options());
    const next = createMemoryChatGateway();
    next.controller.setSnapshot(
      snapshotFor(next.fixtures.initialSnapshot, "b"),
    );
    const second = createChatClient({
      gateway: next.gateway,
      cache: { storage, attachments },
    });
    await second.loadConversation({ ...options(), conversationId: a });
    await second.loadConversation({ ...options(), conversationId: "b" });
    await second.flushCache(options());
    expect(storage.scopes.get("default")).toContain("stable-file");
    expect(second.getComposerDraft(a).attachments).toEqual([]);
    resolve({ uri: "https://files.test/fresh", mimeType: "text/plain" });
    await flushMicrotasks();
    expect(second.getComposerDraft(a).attachments).toEqual([
      { uri: "https://files.test/fresh", mimeType: "text/plain" },
    ]);
    expect(second.getSnapshot()?.conversation.id).toBe("b");
    await second.dispose(options());
  });
  it.each(["clear", "delete"] as const)(
    "does not strand B synchronization when %s invalidates A",
    async (operation) => {
      const memory = createMemoryChatGateway();
      const a = memory.fixtures.conversation.id;
      memory.controller.setSnapshot(
        snapshotFor(memory.fixtures.initialSnapshot, "b"),
      );
      const client = createChatClient({ gateway: memory.gateway });
      await client.loadConversation({ ...options(), conversationId: a });
      await client.loadConversation({ ...options(), conversationId: "b" });
      const held = memory.controller.holdNext("loadConversation");
      const loading = client.loadConversation({
        ...options(),
        conversationId: "b",
      });
      await held.started;
      if (operation === "clear")
        await client.clearConversationCache(a, options());
      else
        expect(
          (await client.deleteConversation({ ...options(), conversationId: a }))
            .ok,
        ).toBe(true);
      held.release();
      expect((await loading).ok).toBe(true);
      expect(client.getCacheState()).toMatchObject({
        conversationId: "b",
        status: "ready",
      });
      await client.dispose(options());
    },
  );
  it("reports hard-expired persisted records and closes cache subscriptions on disposal", async () => {
    const storage = new AtomicStorage();
    const memory = createMemoryChatGateway();
    const a = memory.fixtures.conversation.id;
    const first = createChatClient({
      gateway: memory.gateway,
      cache: { storage, now: () => 100 },
    });
    await first.loadConversation({ ...options(), conversationId: a });
    first.setComposerDraft({ conversationId: a, text: "expired draft" });
    await first.dispose(options());
    const next = createMemoryChatGateway();
    const events: ConversationCacheEvent[] = [];
    const second = createChatClient({
      gateway: next.gateway,
      cache: {
        storage,
        now: () => 100 + 86400000,
        onEvent: (event) => events.push(event),
      },
    });
    const subscription = second.subscribeCacheState(() => undefined);
    await second.loadConversation({ ...options(), conversationId: a });
    expect(events).toContainEqual({
      kind: "expired",
      conversationId: a,
      hadDraft: true,
    });
    await second.dispose(options());
    expect(subscription.closed).toBe(true);
  });
  it.each(["one", "all"] as const)(
    "keeps server conversations in Workspace when clearing %s offline cache",
    async (kind) => {
      const memory = createMemoryChatGateway();
      const a = memory.fixtures.conversation.id;
      memory.controller.setSnapshot(
        snapshotFor(memory.fixtures.initialSnapshot, "b"),
      );
      const client = createChatClient({ gateway: memory.gateway });
      const workspace = createConversationWorkspaceController({
        client,
        getDeadlineAt: deadlineAt,
      });
      await workspace.selectConversation(a);
      await workspace.selectConversation("b");
      memory.controller.failNext("loadConversation", {
        code: "network",
        message: "offline",
        retryable: true,
      });
      await workspace.selectConversation(a);
      const ids = workspace.getSnapshot().conversations.map((item) => item.id);
      expect(client.getSnapshot()?.timeline.length).toBeGreaterThan(0);
      if (kind === "one") await client.clearConversationCache(a, options());
      else await client.clearCache(options());
      expect(
        workspace.getSnapshot().conversations.map((item) => item.id),
      ).toEqual(ids);
      expect(workspace.getSnapshot().selectedConversationId).toBe(a);
      expect(client.getSnapshot()?.timeline).toEqual([]);
      expect((await workspace.selectConversation(a)).ok).toBe(true);
      expect(client.getSnapshot()?.timeline.length).toBeGreaterThan(0);
      workspace.dispose();
      await client.dispose(options());
    },
  );
  it.each([{ maxItems: 1 }, { maxBytes: 1 }])(
    "does not cache an oversized entry with %j while preserving its active view",
    async (limits) => {
      const memory = createMemoryChatGateway();
      const a = memory.fixtures.conversation.id;
      memory.controller.setSnapshot({
        ...memory.fixtures.initialSnapshot,
        timeline: [message("first", a, 1), message("second", a, 2)],
      });
      memory.controller.setSnapshot(
        snapshotFor(memory.fixtures.initialSnapshot, "b"),
      );
      const events: ConversationCacheEvent[] = [];
      const client = createChatClient({
        gateway: memory.gateway,
        cache: { ...limits, onEvent: (event) => events.push(event) },
      });
      await client.loadConversation({ ...options(), conversationId: a });
      expect(client.getSnapshot()?.timeline.map((item) => item.id)).toEqual([
        "first",
        "second",
      ]);
      await client.loadConversation({ ...options(), conversationId: "b" });
      const held = memory.controller.holdNext("loadConversation");
      const loading = client.loadConversation({
        ...options(),
        conversationId: a,
      });
      await held.started;
      expect(client.getCacheState().source).toBe("none");
      expect(events).toContainEqual(
        expect.objectContaining({ kind: "evicted", conversationId: a }),
      );
      held.release();
      expect((await loading).ok).toBe(true);
      await client.dispose(options());
    },
  );
});
