import { describe, expect, it } from "vitest";
import { createChatClient } from "../packages/chat-runtime/src/index.js";
import { createMemoryChatGateway } from "../packages/chat-testing/src/index.js";

import { messageDtoSchema } from "../packages/chat-gateway-tfrobot/src/dto.js";
import { TFRobotMessageIdentities } from "../packages/chat-gateway-tfrobot/src/message-identity.js";
import {
  chatSnapshotSchema,
  messageSchema,
} from "../packages/chat-protocol/src/index.js";
import {
  createTimelineState,
  mergeHistoryTimeline,
  upsertTimelineItem,
} from "../packages/chat-runtime/src/timeline.js";

const elementId = "28d9e235-607c-40dc-a984-dba615b62e49";
const otherElementId = "55b01bed-c317-445b-a3e3-040ea3fc4d7c";
const dto = (overrides: Record<string, unknown> = {}) =>
  messageDtoSchema.parse({
    conversationId: 42,
    msgId: null,
    elementId,
    role: "user",
    msgType: "text",
    content: "Same input",
    createTimestamp: 100,
    creator: { uid: "admin", name: "Admin" },
    ...overrides,
  });

describe("Server message identity", () => {
  it("supports explicit identities on verified transports without enabling legacy heuristics", () => {
    const identities = new TFRobotMessageIdentities(false);
    const first = identities.map(dto());
    expect(
      identities.map(dto({ msgId: 366, creator: { uid: "other" } }), "history")
        .id,
    ).toBe(first.id);
    const legacy = dto({ elementId: undefined });
    expect(identities.map(legacy)).not.toHaveProperty("provenance");
    expect(identities.map({ ...legacy, msgId: 368 }, "history").id).not.toBe(
      identities.map(legacy).id,
    );
  });
  it.each([false, true])(
    "joins cross-author deliveries by elementId in either order (history first=%s)",
    (historyFirst) => {
      const identities = new TFRobotMessageIdentities();
      const live = dto();
      const history = dto({
        msgId: 366,
        creator: { uid: "user-1", name: "History" },
        content: "Updated input",
        createTimestamp: 101,
      });
      const first = identities.map(
        historyFirst ? history : live,
        historyFirst ? "history" : "live",
      );
      const second = identities.map(
        historyFirst ? live : history,
        historyFirst ? "live" : "history",
      );
      expect(second.id).toBe(first.id);
      expect(second).toMatchObject({
        serverMessageId: elementId,
        author: { id: "user-1", displayName: "History" },
      });
      expect(first.raw ?? {}).not.toHaveProperty("elementId");
    },
  );

  it("keeps two identical sends separate before persistence without asserting durability", () => {
    const identities = new TFRobotMessageIdentities();
    const first = identities.map(dto());
    const second = identities.map(dto({ elementId: otherElementId }));
    expect(first.id).not.toBe(second.id);
    expect(first).toMatchObject({
      serverMessageId: elementId,
      provenance: { kind: "provisional" },
    });
    expect(identities.map(dto()).id).toBe(first.id);
  });

  it("retains explicit identities and history authors beyond the legacy signature window", () => {
    const identities = new TFRobotMessageIdentities();
    const first = identities.map(
      dto({ msgId: 366, creator: { uid: "u", name: "History" } }),
      "history",
    );
    for (let i = 0; i < 300; i++)
      identities.map(
        dto({ elementId: `opaque-server-id-${i}`, content: `Other ${i}` }),
      );
    expect(
      identities.map(dto({ creator: { uid: "admin", name: "Late" } })),
    ).toMatchObject({
      id: first.id,
      serverMessageId: elementId,
      author: { displayName: "History" },
    });
  });

  it("rejects conflicting server identities for one database fact", () => {
    const identities = new TFRobotMessageIdentities();
    identities.map(dto({ msgId: 366 }), "history");
    expect(() =>
      identities.map(dto({ msgId: 366, elementId: otherElementId }), "history"),
    ).toThrow();
    expect(() => identities.map(dto({ msgId: 367 }), "history")).toThrow();
  });

  it("does not guess an elementId link to a legacy transient item", () => {
    const identities = new TFRobotMessageIdentities();
    const legacy = identities.map(dto({ elementId: undefined }));
    expect(identities.map(dto()).id).not.toBe(legacy.id);
    expect(identities.map(dto({ elementId: undefined })).id).toBe(legacy.id);
  });

  it("upgrades a known legacy database alias and keeps it on later legacy delivery", () => {
    const identities = new TFRobotMessageIdentities();
    const old = identities.map(
      dto({ elementId: undefined, msgId: 366 }),
      "history",
    );
    expect(identities.map(dto({ msgId: 366 }), "history")).toMatchObject({
      id: old.id,
      serverMessageId: elementId,
    });
    expect(identities.map(dto({ elementId: null, msgId: 366 }))).toMatchObject({
      id: old.id,
      serverMessageId: elementId,
    });
  });

  it("preserves standard identity in schemas and merges different display keys across cache boundaries", () => {
    const first = messageSchema.parse({
      kind: "message",
      id: "cache-display",
      conversationId: "42",
      role: "user",
      serverMessageId: elementId,
      createdAt: 100,
      content: { kind: "text", text: "Input" },
      provenance: { kind: "provisional", source: "cache" },
    });
    expect(first).toHaveProperty("serverMessageId", elementId);
    const fresh = {
      ...first,
      id: "366",
      provenance: {
        kind: "persisted" as const,
        id: "366",
        source: "history" as const,
      },
      author: { id: "u", displayName: "History" },
    };
    const current = createTimelineState([first]);
    const merged = mergeHistoryTimeline(current, [fresh], true);
    expect(merged.items).toHaveLength(1);
    expect(Object.isFrozen(merged.items[0])).toBe(true);
    expect(merged.items[0]).toMatchObject({
      id: first.id,
      serverMessageId: elementId,
      author: fresh.author,
    });
    expect(
      upsertTimelineItem(merged, { ...fresh, id: "third-display" }).items,
    ).toHaveLength(1);
  });

  it("bridges an old database cache entry and an independently received server identity", () => {
    const identities = new TFRobotMessageIdentities();
    const old = identities.map(
      dto({
        elementId: undefined,
        msgId: 366,
        creator: { uid: "user-1", name: "Old" },
      }),
      "history",
    );
    const live = identities.map(dto());
    const history = identities.map(
      dto({ msgId: 366, creator: { uid: "user-1", name: "New" } }),
      "history",
    );
    expect(history.id).toBe(live.id);
    const state = createTimelineState([old, live]);
    expect(state.items).toHaveLength(2);
    expect(upsertTimelineItem(state, history).items).toHaveLength(1);
    expect(mergeHistoryTimeline(state, [history], true).items).toHaveLength(1);
    expect(mergeHistoryTimeline(state, [history], true).items[0]).toMatchObject(
      { author: { displayName: "New" } },
    );
  });

  it("preserves history authors when a live message bridges legacy database and server aliases", () => {
    const identities = new TFRobotMessageIdentities();
    const old = identities.map(
      dto({
        elementId: undefined,
        msgId: 366,
        creator: { uid: "user-1", name: "History" },
      }),
      "history",
    );
    const live = identities.map(dto());
    const bridged = identities.map(dto({ msgId: 366 }));
    expect(bridged).toMatchObject({ author: { displayName: "History" } });
    const state = createTimelineState([old, live]);
    // Runtime must also honor the other matching projection for custom Gateways.
    const result = upsertTimelineItem(state, {
      ...bridged,
      author: live.author,
    });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      author: { displayName: "History" },
    });
  });

  it.each(["load", "snapshot.replace"] as const)(
    "preserves the history author in a bulk %s bridge",
    async (entry) => {
      const memory = createMemoryChatGateway();
      const conversationId = memory.fixtures.conversation.id;
      const old = {
        ...new TFRobotMessageIdentities().map(
          dto({
            elementId: undefined,
            msgId: 366,
            creator: { uid: "user-1", name: "History" },
          }),
          "history",
        ),
        conversationId,
      };
      const live = {
        ...new TFRobotMessageIdentities().map(dto()),
        conversationId,
      };
      const bridge = {
        ...live,
        id: "bridge",
        provenance: {
          kind: "persisted" as const,
          id: "366",
          source: "live" as const,
        },
      };
      const snapshot = {
        ...memory.fixtures.initialSnapshot,
        timeline: [old, live, bridge],
      };
      expect(chatSnapshotSchema.safeParse(snapshot).success).toBe(true);
      expect(createTimelineState(snapshot.timeline).items).toMatchObject([
        {
          author: { displayName: "History" },
          provenance: { source: "history" },
        },
      ]);
      if (entry === "load") memory.controller.setSnapshot(snapshot);
      const client = createChatClient({
        gateway: memory.gateway,
        cache: false,
      });
      const options = () => ({ deadlineAt: Date.now() + 5000 });
      try {
        expect(
          (await client.loadConversation({ conversationId, ...options() })).ok,
        ).toBe(true);
        if (entry === "snapshot.replace")
          memory.controller.emitUpdate({ kind: "snapshot.replace", snapshot });
        expect(client.getSnapshot()!.timeline).toHaveLength(1);
        expect(client.getSnapshot()!.timeline[0]).toMatchObject({
          author: { displayName: "History" },
        });
      } finally {
        await client.dispose(options());
      }
    },
  );

  it.each([false, true])(
    "rejects a display collision across different database facts when one has a Server identity (reverse=%s)",
    (reverse) => {
      const first = new TFRobotMessageIdentities().map(
        dto({ msgId: 366 }),
        "history",
      );
      const second = {
        ...first,
        serverMessageId: undefined,
        provenance: {
          kind: "persisted" as const,
          id: "367",
          source: "history" as const,
        },
      };
      const items = reverse ? [second, first] : [first, second];
      expect(() =>
        upsertTimelineItem(createTimelineState([items[0]!]), items[1]!),
      ).toThrow(/Conflicting server message identity/u);
      expect(() => createTimelineState(items)).toThrow(
        /Conflicting server message identity/u,
      );
    },
  );

  it("does not accept an empty wire identity", () => {
    expect(() => dto({ elementId: "" })).toThrow();
    expect(() => dto({ elementId: 42 })).toThrow();
  });

  it("checks the conversation and uniqueness of outgoing snapshot records", () => {
    const base = {
      conversation: { id: "42", title: "Test" },
      timeline: [],
      run: null,
      capabilities: {
        interrupt: false,
        listConversations: false,
        liveUpdates: false,
        loadHistory: false,
        sendText: true,
      },
      pageInfo: { hasPreviousPage: false },
    };
    const outgoing = {
      id: "send-1",
      conversationId: "42",
      text: "Input",
      attachmentCount: 0,
      status: "sending",
    };
    expect(
      chatSnapshotSchema.parse({ ...base, outgoingMessages: [outgoing] }),
    ).toHaveProperty("outgoingMessages", [outgoing]);
    expect(
      chatSnapshotSchema.safeParse({
        ...base,
        outgoingMessages: [{ ...outgoing, conversationId: "other" }],
      }).success,
    ).toBe(false);
    expect(
      chatSnapshotSchema.safeParse({
        ...base,
        outgoingMessages: [outgoing, outgoing],
      }).success,
    ).toBe(false);
  });
});
