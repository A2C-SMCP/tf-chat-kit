import {
  getTimelineItemKey,
  type TimelineItem,
} from "@turingfocus/chat-protocol";

export interface TimelineTailState {
  readonly conversationId: string;
  readonly length: number;
  readonly tailKey: string | undefined;
}

export interface TimelineTailTransition {
  readonly addedAfterTail: number;
  readonly state: TimelineTailState;
}

type TimelineItemKeyReader = (item: TimelineItem) => string;

export const createTimelineTailState = (
  conversationId: string,
  items: readonly TimelineItem[],
  readKey: TimelineItemKeyReader = getTimelineItemKey,
): TimelineTailState => {
  const tail = items.at(-1);
  return {
    conversationId,
    length: items.length,
    tailKey: tail === undefined ? undefined : readKey(tail),
  };
};

/**
 * Counts only items inserted after the previously observed chronological tail.
 * Runtime upserts preserve unchanged item references and list order, so a
 * length-preserving streaming replacement is O(1), while an insertion scans at
 * most the number of added items plus the prior tail.
 */
export const advanceTimelineTailState = (
  previous: TimelineTailState,
  conversationId: string,
  items: readonly TimelineItem[],
  readKey: TimelineItemKeyReader = getTimelineItemKey,
): TimelineTailTransition => {
  const state = createTimelineTailState(conversationId, items, readKey);
  if (
    previous.conversationId !== conversationId ||
    previous.tailKey === undefined ||
    items.length <= previous.length
  ) {
    return { addedAfterTail: 0, state };
  }

  for (let index = previous.length - 1; index < items.length; index += 1) {
    const item = items[index]!;
    if (readKey(item) === previous.tailKey) {
      return {
        addedAfterTail: items.length - index - 1,
        state,
      };
    }
  }

  // Snapshot replacement or deletion is not an append. Avoid presenting its
  // unmatched items as new realtime messages.
  return { addedAfterTail: 0, state };
};
