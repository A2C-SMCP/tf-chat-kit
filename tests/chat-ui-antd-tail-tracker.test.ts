import { describe, expect, it, vi } from "vitest";

import {
  getTimelineItemKey,
  type Message,
  type TimelineItem,
} from "../packages/chat-protocol/src/index.js";
import {
  advanceTimelineTailState,
  createTimelineTailState,
} from "../packages/chat-ui-antd/src/timeline-tail-tracker.js";

const message = (id: string, createdAt: number): Message => ({
  kind: "message",
  id,
  conversationId: "tail-tracker",
  role: "assistant",
  content: { kind: "text", text: id },
  createdAt,
});

describe("@turingfocus/chat-ui-antd timeline tail tracking", () => {
  it("counts only chronological tail appends and ignores older history", () => {
    const initial: readonly TimelineItem[] = [
      message("message-1", 1),
      message("message-2", 2),
      message("message-3", 3),
    ];
    const baseline = createTimelineTailState("tail-tracker", initial);
    const appended = [
      ...initial,
      message("message-4", 4),
      message("message-5", 5),
    ];
    const realtime = advanceTimelineTailState(
      baseline,
      "tail-tracker",
      appended,
    );
    expect(realtime.addedAfterTail).toBe(2);

    const withHistory = [
      message("message-history-1", -1),
      message("message-history-2", 0),
      ...appended,
    ];
    const history = advanceTimelineTailState(
      realtime.state,
      "tail-tracker",
      withHistory,
    );
    expect(history.addedAfterTail).toBe(0);
  });

  it("keeps 5,000-item streaming replacements at one key read per update", () => {
    let items: readonly TimelineItem[] = Array.from(
      { length: 5_000 },
      (_value, index) => message(`message-${index}`, index),
    );
    let state = createTimelineTailState("tail-tracker", items);
    const readKey = vi.fn(getTimelineItemKey);

    for (let update = 0; update < 1_000; update += 1) {
      const replacement = {
        ...items[2_500]!,
        content: {
          kind: "text" as const,
          text: `stream replacement ${update}`,
        },
      };
      const nextItems = [...items];
      nextItems[2_500] = replacement;
      const transition = advanceTimelineTailState(
        state,
        "tail-tracker",
        nextItems,
        readKey,
      );
      expect(transition.addedAfterTail).toBe(0);
      state = transition.state;
      items = nextItems;
    }

    expect(readKey).toHaveBeenCalledTimes(1_000);
  });
});
