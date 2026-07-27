import { describe, expect, it } from "vitest";

import type { Message } from "../packages/chat-protocol/src/index.js";
import {
  createTimelineState,
  mergeHistoryTimeline,
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
