import { describe, expect, it } from "vitest";

import type { Message } from "../packages/chat-protocol/src/index.js";
import {
  createTimelineState,
  mergeHistoryTimeline,
  rebaseTimelineState,
  upsertTimelineItem,
} from "../packages/chat-runtime/src/timeline.js";

const message = (
  id: string,
  createdAt: number,
  text: string = id,
): Message => ({
  kind: "message",
  id,
  conversationId: "conversation-timeline",
  role: "assistant",
  content: { kind: "text", text },
  createdAt,
});

describe("Runtime timeline index", () => {
  it("keeps one display identity per durable fact across paging and subsequent updates", () => {
    const cached: Message = {
      ...message("old-instance-alias", 10, "Cached content"),
      provenance: { kind: "persisted", id: "366", source: "cache" },
    };
    const fresh: Message = {
      ...message("366", 10, "Fresh content"),
      provenance: { kind: "persisted", id: "366", source: "history" },
      author: { id: "u", displayName: "Fresh author" },
    };
    const current = createTimelineState([cached]);
    const rebased = rebaseTimelineState(
      current,
      createTimelineState([fresh]),
      current,
    );
    expect(rebased.items).toHaveLength(1);
    expect(rebased.items[0]).toMatchObject({
      id: cached.id,
      content: fresh.content,
      author: fresh.author,
    });
    const realtime = {
      ...fresh,
      provenance: { ...fresh.provenance!, source: "live" as const },
      content: { kind: "text" as const, text: "New live content" },
    };
    const updated = upsertTimelineItem(rebased, realtime);
    expect(updated.items).toHaveLength(1);
    expect(updated.items[0]).toMatchObject({
      id: cached.id,
      content: realtime.content,
      author: fresh.author,
    });
    const olderFact: Message = {
      ...fresh,
      id: "another-alias",
      provenance: { kind: "persisted", id: "367", source: "history" },
    };
    expect(
      mergeHistoryTimeline(updated, [fresh, olderFact]).items,
    ).toHaveLength(2);
  });

  it("never inserts content through an author-only recovery update", () => {
    const update: Message = {
      ...message("same", 20, "Older REST content"),
      author: { id: "u", displayName: "Updated" },
      provenance: { kind: "persisted", id: "42", source: "history" },
    };
    const empty = createTimelineState([]);
    expect(upsertTimelineItem(empty, update, true)).toBe(empty);
    const live = { ...message("same", 10, "Newest realtime content") };
    expect(
      upsertTimelineItem(createTimelineState([live]), update, true).items,
    ).toMatchObject([
      {
        content: live.content,
        createdAt: live.createdAt,
        author: update.author,
        provenance: update.provenance,
      },
    ]);
  });

  it("adopts history-confirmed author through handoff and older pages without losing concurrent content", () => {
    const live: Message = {
      ...message("same", 10, "Concurrent text"),
      role: "user",
      provenance: { kind: "provisional" },
      author: { id: "u", displayName: "Old" },
    };
    const history: Message = {
      ...live,
      content: { kind: "text", text: "History text" },
      provenance: { kind: "persisted", id: "db", source: "history" },
      author: {
        id: "u",
        displayName: "Updated",
        avatarUrl: "https://example.invalid/avatar",
      },
    };
    const current = createTimelineState([live]);
    for (const result of [
      mergeHistoryTimeline(current, [history], true),
      rebaseTimelineState(
        createTimelineState([]),
        createTimelineState([history]),
        current,
      ),
    ])
      expect(result.items).toMatchObject([
        {
          author: history.author,
          content: live.content,
          provenance: history.provenance,
        },
      ]);
    const confirmed = createTimelineState([history]);
    expect(upsertTimelineItem(confirmed, live).items).toMatchObject([
      { author: history.author, content: live.content },
    ]);
    const newer = { ...history, author: { id: "u", displayName: "Newest" } };
    expect(mergeHistoryTimeline(confirmed, [newer], true).items).toMatchObject([
      { author: newer.author },
    ]);
    expect(
      mergeHistoryTimeline(createTimelineState([newer]), [history]).items,
    ).toMatchObject([{ author: newer.author }]);
  });

  it("keeps a newer concurrent history author when an older reload completes late", () => {
    const baselineItem: Message = {
      ...message("same", 10),
      role: "user",
      provenance: { kind: "persisted", id: "42", source: "history" },
      author: { id: "u", displayName: "Old" },
    };
    const baseline = createTimelineState([baselineItem]);
    const current = createTimelineState([
      { ...baselineItem, author: { id: "u", displayName: "New" } },
    ]);
    expect(
      rebaseTimelineState(baseline, baseline, current).items,
    ).toMatchObject([{ author: { displayName: "New" } }]);
  });

  it("keeps divergent states independent across index compaction", () => {
    const base = createTimelineState(
      Array.from({ length: 100 }, (_, index) =>
        message(`base-${index}`, index),
      ),
    );
    let left = base;
    let right = base;

    for (let index = 0; index < 80; index += 1) {
      left = upsertTimelineItem(left, message(`left-${index}`, 1_000 + index));
      right = upsertTimelineItem(
        right,
        message(`right-${index}`, 2_000 + index),
      );
    }

    const leftUpdated = upsertTimelineItem(
      left,
      message("base-50", 3_000, "moved-left"),
    );
    const rightUpdated = upsertTimelineItem(
      right,
      message("base-50", 50, "updated-right"),
    );

    expect(base.items).toHaveLength(100);
    expect(leftUpdated.items).toHaveLength(180);
    expect(rightUpdated.items).toHaveLength(180);
    expect(leftUpdated.items.some(({ id }) => id === "right-0")).toBe(false);
    expect(rightUpdated.items.some(({ id }) => id === "left-0")).toBe(false);
    expect(leftUpdated.items.at(-1)).toMatchObject({
      id: "base-50",
      content: { text: "moved-left" },
    });
    expect(rightUpdated.items.find(({ id }) => id === "base-50")).toMatchObject(
      {
        content: { text: "updated-right" },
      },
    );
  });

  it("keeps the supported 5k timeline plus 1k-update burst within the Node 24 CI baseline", () => {
    let state = createTimelineState(
      Array.from({ length: 5_000 }, (_, index) =>
        message(`base-${index}`, index),
      ),
    );
    const startedAt = performance.now();

    for (let index = 0; index < 1_000; index += 1) {
      state = upsertTimelineItem(
        state,
        message(`appended-${index}`, 10_000 + index),
      );
    }

    const elapsedMs = performance.now() - startedAt;
    expect(state.items).toHaveLength(6_000);
    // Local baseline is below 50ms; this margin guards regressions without
    // treating shared-runner scheduling noise as an algorithm failure.
    expect(elapsedMs).toBeLessThan(2_000);
  });

  it("merges the supported 5k history page into 5k current items while retaining identity", () => {
    const current = createTimelineState(
      Array.from({ length: 5_000 }, (_, index) =>
        message(`current-${index}`, 5_000 + index),
      ),
    );
    const history = Array.from({ length: 5_000 }, (_, index) =>
      message(`history-${index}`, index),
    );
    const retained = current.items[0]!;
    const startedAt = performance.now();

    const merged = mergeHistoryTimeline(current, history);

    const elapsedMs = performance.now() - startedAt;
    expect(merged.items).toHaveLength(10_000);
    expect(merged.items[5_000]).toBe(retained);
    // Local baseline is below 50ms; retain generous shared-CI headroom.
    expect(elapsedMs).toBeLessThan(2_000);
  });
});
