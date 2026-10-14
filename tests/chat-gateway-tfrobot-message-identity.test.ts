import { describe, expect, it } from "vitest";

import type { MessageDto } from "../packages/chat-gateway-tfrobot/src/dto.js";
import { TFRobotMessageIdentities } from "../packages/chat-gateway-tfrobot/src/message-identity.js";

const message = (overrides: Partial<MessageDto> = {}): MessageDto => ({
  conversationId: 42,
  content: "User input",
  createTimestamp: 1_791_538_963_309,
  creator: { uid: "user-1", name: "User" },
  msgId: null,
  msgType: "text",
  role: "user",
  ...overrides,
});

describe("current-server provisional user message identities", () => {
  it("adopts fresh author display from a history cache DTO linked to a known persisted fact", () => {
    const mapper = new TFRobotMessageIdentities();
    const known = mapper.map(
      message({ msgId: 366, creator: { uid: "user-1", name: "Old" } }),
      "history",
    );
    const fresh = mapper.map(
      message({ creator: { uid: "user-1", name: "New" } }),
      "history",
    );
    expect(fresh.id).toBe(known.id);
    expect(fresh.author?.displayName).toBe("New");
  });

  it.each([
    [
      { uid: "admin", name: "Admin" },
      { uid: "user-1", name: "User" },
    ],
    [
      { uid: "user-1", name: "User", tenant: "A" },
      { uid: "user-1", name: "User", tenant: "B" },
    ],
  ])(
    "does not use stale identity facts after a known database ID is corrected: %j",
    (liveCreator, confirmedCreator) => {
      const mapper = new TFRobotMessageIdentities();
      const first = mapper.map(message({ msgId: 366, creator: liveCreator }));
      const corrected = mapper.map(
        message({ msgId: 366, creator: confirmedCreator }),
        "history",
      );
      expect(corrected.id).toBe(first.id);
      const late = mapper.map(message({ creator: liveCreator }));
      expect(late.id).not.toBe(corrected.id);
      expect(late.provenance?.kind).toBe("provisional");
    },
  );

  it("keeps a history-first cross-UID late echo as a separate unconfirmed projection", () => {
    const mapper = new TFRobotMessageIdentities();
    const history = mapper.map(message({ msgId: 366 }), "history");
    const late = mapper.map(
      message({ creator: { uid: "admin", name: "Admin" } }),
    );
    expect(late.id).not.toBe(history.id);
    expect(late.author?.id).toBe("admin");
    expect(late.provenance).toMatchObject({
      kind: "provisional",
      reviewRequired: true,
    });
    const newer = mapper.map(
      message({
        creator: { uid: "admin", name: "Admin" },
        createTimestamp: 1791538963310,
      }),
    );
    expect(newer.id).not.toBe(late.id);
    expect(
      newer.provenance?.kind === "provisional"
        ? newer.provenance.reviewRequired
        : undefined,
    ).not.toBe(true);
  });

  it("does not reuse a timestamp-derived provisional display ID across independent Gateway instances", () => {
    const old = new TFRobotMessageIdentities().map(
      message({ creator: { uid: "admin", name: "Admin" } }),
    );
    const latest = new TFRobotMessageIdentities().map(
      message({ creator: { uid: "user-1", name: "User" } }),
    );
    expect(latest.id).not.toBe(old.id);
  });

  it.each([false, true])(
    "ignores mutable author display in either delivery order: %s",
    (historyFirst) => {
      const mapper = new TFRobotMessageIdentities();
      const live = message({
        creator: { uid: "user-1", name: "Old", avatar: null },
      });
      const history = message({
        msgId: 366,
        creator: {
          uid: "user-1",
          name: "Updated",
          avatar: "https://example.invalid/avatar",
        },
      });
      const first = mapper.map(
        historyFirst ? history : live,
        historyFirst ? "history" : "live",
      );
      const second = mapper.map(
        historyFirst ? live : history,
        historyFirst ? "live" : "history",
      );
      expect(second.id).toBe(first.id);
      expect(second.author).toMatchObject({
        id: "user-1",
        displayName: "Updated",
        avatarUrl: "https://example.invalid/avatar",
      });
      expect(second.provenance).toEqual({
        kind: "persisted",
        id: "366",
        source: historyFirst ? "live" : "history",
      });
    },
  );

  it("keeps confirmed authors from the newer HTTP read across stale responses and late echoes", () => {
    const mapper = new TFRobotMessageIdentities();
    const older = mapper.beginHistoryRead();
    const newer = mapper.beginHistoryRead();
    mapper.map(
      message({ msgId: 366, creator: { uid: "user-1", name: "New" } }),
      "history",
      newer,
    );
    for (let index = 0; index < 300; index += 1)
      mapper.map(message({ msgId: 1000 + index, createTimestamp: index }));
    expect(
      mapper.map(
        message({ msgId: 366, creator: { uid: "user-1", name: "Old" } }),
        "history",
        older,
      ).author?.displayName,
    ).toBe("New");
    expect(mapper.map(message({ msgId: 366 })).author?.displayName).toBe("New");
  });

  it.each([false, true])(
    "correlates additive Server processing fields in either order: %s",
    (persistedFirst) => {
      const mapper = new TFRobotMessageIdentities();
      const provisional = message({
        additionalKwargs: { business: "retained" },
      });
      const persisted = message({
        msgId: 366,
        additionalKwargs: {
          business: "retained",
          chain_result: "result",
          __tf_parent_uuid: "parent",
          __tf_element_uuid: "element",
        },
      });
      const first = mapper.map(persistedFirst ? persisted : provisional);
      expect(mapper.map(persistedFirst ? provisional : persisted).id).toBe(
        first.id,
      );
      expect(mapper.map(persisted).id).toBe(first.id);
    },
  );

  it.each([
    "chain_result",
    "__tf_parent_uuid",
    "__tf_element_uuid",
    "business",
  ])("preserves conflicting existing values for %s", (key) => {
    const mapper = new TFRobotMessageIdentities();
    const provisional = mapper.map(
      message({ additionalKwargs: { [key]: "A" } }),
    );
    expect(
      mapper.map(message({ msgId: 366, additionalKwargs: { [key]: "B" } })).id,
    ).not.toBe(provisional.id);
  });

  it("does not bind ambiguous enrichment to either persisted fact", () => {
    const mapper = new TFRobotMessageIdentities();
    const original = mapper.map(message({ additionalKwargs: {} }));
    const first = mapper.map(
      message({ msgId: 366, additionalKwargs: { __tf_element_uuid: "A" } }),
    );
    const second = mapper.map(
      message({ msgId: 367, additionalKwargs: { __tf_element_uuid: "B" } }),
    );
    expect(first.id).toBe(original.id);
    expect(second.id).not.toBe(first.id);
    const ambiguous = mapper.map(message({ additionalKwargs: {} }));
    expect(ambiguous.id).not.toBe(first.id);
    expect(ambiguous.id).not.toBe(second.id);
    expect(mapper.map(message({ additionalKwargs: {} })).id).toBe(ambiguous.id);
  });
  it("keeps one identity across provisional and persisted delivery in either order", () => {
    for (const persistedFirst of [false, true]) {
      const mapper = new TFRobotMessageIdentities();
      const first = mapper.map(message({ msgId: persistedFirst ? 366 : null }));
      const second = mapper.map(
        message({ msgId: persistedFirst ? null : 366 }),
      );
      expect(second.id).toBe(first.id);
    }
  });

  it("preserves distinct database IDs even when every other field matches", () => {
    const mapper = new TFRobotMessageIdentities();
    const temporary = mapper.map(message());
    const first = mapper.map(message({ msgId: 366 }));
    const second = mapper.map(message({ msgId: 367 }));
    expect(first.id).toBe(temporary.id);
    expect(second.id).not.toBe(first.id);
    expect(mapper.map(message({ msgId: 366 })).id).toBe(first.id);
    expect(mapper.map(message({ msgId: 367 })).id).toBe(second.id);
  });

  it.each([
    { content: "A different input" },
    { creator: { uid: "user-2", name: "User" } },
    { createTimestamp: 1_791_538_963_310 },
    { conversationId: 43 },
  ])("does not correlate different message facts %j", (different) => {
    const mapper = new TFRobotMessageIdentities();
    const first = mapper.map(message());
    const second = mapper.map(message(different));
    expect(second.id).not.toBe(first.id);
    expect(mapper.map(message({ msgId: 366 })).id).toBe(first.id);
    expect(mapper.map(message({ ...different, msgId: 367 })).id).toBe(
      second.id,
    );
  });

  it("keeps aliases stable after recent signature eviction", () => {
    const mapper = new TFRobotMessageIdentities();
    const first = mapper.map(message());
    mapper.map(message({ msgId: 366 }));
    for (let index = 0; index < 300; index += 1) {
      mapper.map(message({ msgId: 1000 + index, createTimestamp: index }));
    }
    expect(mapper.map(message({ msgId: 366 })).id).toBe(first.id);
  });

  it("does not correlate full multipart contents that share a truncated display", () => {
    const mapper = new TFRobotMessageIdentities();
    const common = Array.from({ length: 20 }, () => ({
      type: "text",
      text: "Same displayed part",
    }));
    const first = mapper.map(
      message({
        msgType: "multipart",
        content: [...common, { type: "text", text: "A".repeat(262_145) }],
      }),
    );
    const second = mapper.map(
      message({
        msgId: 366,
        msgType: "multipart",
        content: [...common, { type: "text", text: "B".repeat(262_145) }],
      }),
    );
    expect(second.id).not.toBe(first.id);
  });

  it.each([false, true])(
    "retains business extensions in either order (persisted first: %s)",
    (persistedFirst) => {
      for (const [firstFields, secondFields] of [
        [{ businessSource: "A" }, { businessSource: "B" }],
        [
          { creator: { uid: "user-1", name: "User", tenant: "A" } },
          { creator: { uid: "user-1", name: "User", tenant: "B" } },
        ],
      ]) {
        const mapper = new TFRobotMessageIdentities();
        const first = mapper.map(
          message({ ...firstFields, msgId: persistedFirst ? 366 : null }),
        );
        const second = mapper.map(
          message({ ...secondFields, msgId: persistedFirst ? null : 366 }),
        );
        expect(second.id).not.toBe(first.id);
      }
    },
  );

  it.each([false, true])(
    "preserves raw role and optional/null differences (persisted first: %s)",
    (persistedFirst) => {
      const differences: readonly (readonly [
        Partial<MessageDto>,
        Partial<MessageDto>,
      ])[] = [
        [{ role: "user" }, { role: "USER" }],
        [{ attachments: undefined }, { attachments: null }],
        [{ additionalKwargs: undefined }, { additionalKwargs: null }],
        [{ reasoningContent: undefined }, { reasoningContent: null }],
        [{ creator: undefined }, { creator: null }],
        [{ creator: {} }, { creator: { uid: null } }],
      ];
      for (const [firstFields, secondFields] of differences) {
        const mapper = new TFRobotMessageIdentities();
        const first = mapper.map(
          message({ ...firstFields, msgId: persistedFirst ? 366 : null }),
        );
        const second = mapper.map(
          message({ ...secondFields, msgId: persistedFirst ? null : 366 }),
        );
        expect(second.id).not.toBe(first.id);
      }
    },
  );

  it("normalizes only opaque conversation and user identifiers", () => {
    const mapper = new TFRobotMessageIdentities();
    const first = mapper.map(message({ creator: { uid: 7 } }));
    const second = mapper.map(
      message({ conversationId: "42", creator: { uid: "7" }, msgId: 366 }),
    );
    expect(second.id).toBe(first.id);
  });

  it("does not bind an ambiguous provisional delivery to either database identity", () => {
    const mapper = new TFRobotMessageIdentities();
    const unrelated = mapper.map(message({ content: "Different content" }));
    const first = mapper.map(message({ msgId: 366 }));
    const second = mapper.map(message({ msgId: 367 }));
    const provisional = mapper.map(message());
    expect(
      new Set([unrelated.id, first.id, second.id, provisional.id]).size,
    ).toBe(4);
    expect(mapper.map(message()).id).toBe(provisional.id);
  });

  it("unbinds provisional delivery after two database IDs make a prior match ambiguous", () => {
    const mapper = new TFRobotMessageIdentities();
    mapper.map(message());
    const first = mapper.map(message({ msgId: 366 }));
    const second = mapper.map(message({ msgId: 367 }));
    const unbound = mapper.map(message());
    expect(unbound.id).not.toBe(first.id);
    expect(unbound.id).not.toBe(second.id);
    expect(mapper.map(message()).id).toBe(unbound.id);
  });

  it("does not infer identity for evolving assistant content", () => {
    const mapper = new TFRobotMessageIdentities();
    const first = mapper.map(message({ role: "assistant" }));
    const second = mapper.map(message({ role: "assistant", msgId: 366 }));
    expect(second.id).not.toBe(first.id);
  });

  it.each(["assistant", "system", "tool"])(
    "reserves explicit IDs for %s before or after a provisional user",
    (role) => {
      for (const otherFirst of [false, true]) {
        const mapper = new TFRobotMessageIdentities();
        const otherDto = message({ role, msgId: "message:42:1791538963309" });
        const first = mapper.map(otherFirst ? otherDto : message());
        const second = mapper.map(otherFirst ? message() : otherDto);
        expect(second.id).not.toBe(first.id);
        const persistedUser = mapper.map(message({ msgId: 366 }));
        expect(persistedUser.id).toBe(otherFirst ? second.id : first.id);
        expect(mapper.map(otherDto).id).toBe(otherFirst ? first.id : second.id);
      }
    },
  );

  it("keeps unidentified assistant streaming updates stable without content matching", () => {
    const mapper = new TFRobotMessageIdentities();
    mapper.map(message());
    const first = mapper.map(
      message({ role: "assistant", content: "Partial" }),
    );
    const second = mapper.map(message({ role: "assistant", content: "Final" }));
    expect(second.id).toBe(first.id);
    expect(first.id).not.toBe(mapper.map(message()).id);
  });

  it("clears all identity state with its conversation or instance", () => {
    const mapper = new TFRobotMessageIdentities();
    mapper.map(message());
    mapper.map(message({ msgId: 366 }));
    mapper.forgetConversation("42");
    expect(mapper.map(message({ msgId: 366 })).id).toBe("366");
    mapper.map(message({ conversationId: 43 }));
    mapper.clear();
    expect(mapper.map(message({ conversationId: 43, msgId: 367 })).id).toBe(
      "367",
    );
  });
});
