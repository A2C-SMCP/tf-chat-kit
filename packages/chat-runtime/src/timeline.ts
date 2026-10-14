import {
  compareTimelineItems,
  getTimelineItemKey,
  type TimelineItem,
} from "@turingfocus/chat-protocol";

import { cloneImmutable, deepEqual } from "./immutable.js";

export interface TimelineState {
  readonly index: TimelineItemIndex;
  readonly items: readonly TimelineItem[];
}

interface TimelineItemIndex {
  readonly base: ReadonlyMap<string, TimelineItem>;
  readonly overlay: ReadonlyMap<string, TimelineItem>;
}

const MAX_INDEX_OVERLAY_SIZE = 64;

const durableMessageKey = (item: TimelineItem): string | undefined =>
  item.kind === "message" && item.provenance?.kind === "persisted"
    ? `durable-message:${JSON.stringify([item.conversationId, item.provenance.id])}`
    : undefined;

/** A known database fact can span display IDs; this grants no recovery assurance. */
export const getTimelineRecoveryKey = (item: TimelineItem): string =>
  durableMessageKey(item) ?? getTimelineItemKey(item);

/** Preserve legacy Gateway display-key overlap without accepting provisional coverage. */
export const getTimelineRecoveryKeys = (
  item: TimelineItem,
): readonly string[] => {
  if (item.kind === "message" && item.provenance?.kind === "provisional")
    return [];
  const durableKey = durableMessageKey(item);
  return durableKey === undefined
    ? [getTimelineItemKey(item)]
    : [getTimelineItemKey(item), durableKey];
};

const alignDurableDisplayIds = (
  candidates: readonly TimelineItem[],
  reference: readonly TimelineItem[],
): readonly TimelineItem[] => {
  const ids = new Map<string, string>();
  for (const item of reference) {
    const key = durableMessageKey(item);
    if (key !== undefined) ids.set(key, item.id);
  }
  return candidates.map((item) => {
    const key = durableMessageKey(item);
    const id = key === undefined ? undefined : ids.get(key);
    return id === undefined || id === item.id ? item : { ...item, id };
  });
};

/** Keep evolving content, but never downgrade a history-confirmed author. */
const withConfirmedAuthor = (
  preferred: TimelineItem,
  other: TimelineItem | undefined,
  preferOtherHistory = false,
): TimelineItem => {
  if (
    preferred.kind !== "message" ||
    other?.kind !== "message" ||
    other.provenance?.kind !== "persisted" ||
    other.provenance.source !== "history" ||
    (!preferOtherHistory &&
      preferred.provenance?.kind === "persisted" &&
      preferred.provenance.source === "history")
  )
    return preferred;
  return { ...preferred, author: other.author, provenance: other.provenance };
};

const buildIndex = (items: readonly TimelineItem[]): TimelineItemIndex => {
  const base = new Map<string, TimelineItem>();
  for (const item of items) {
    base.set(getTimelineItemKey(item), item);
    const durableKey = durableMessageKey(item);
    if (durableKey !== undefined) base.set(durableKey, item);
  }
  return { base, overlay: new Map() };
};

const findIndexedItem = (
  index: TimelineItemIndex,
  key: string,
): TimelineItem | undefined => index.overlay.get(key) ?? index.base.get(key);

const advanceIndex = (
  index: TimelineItemIndex,
  key: string,
  item: TimelineItem,
  items: readonly TimelineItem[],
): TimelineItemIndex => {
  const overlay = new Map(index.overlay);
  overlay.set(key, item);
  const durableKey = durableMessageKey(item);
  if (durableKey !== undefined) overlay.set(durableKey, item);
  return overlay.size < MAX_INDEX_OVERLAY_SIZE
    ? { base: index.base, overlay }
    : buildIndex(items);
};

const freezeItems = (items: readonly TimelineItem[]): readonly TimelineItem[] =>
  Object.freeze(items);

const createFromImmutableItems = (
  candidates: readonly TimelineItem[],
): TimelineState => {
  const byKey = new Map<string, TimelineItem>();
  for (const item of candidates) byKey.set(getTimelineItemKey(item), item);
  const items = freezeItems([...byKey.values()].sort(compareTimelineItems));
  return { items, index: buildIndex(items) };
};

export const createTimelineState = (
  items: readonly TimelineItem[],
): TimelineState =>
  createFromImmutableItems(items.map((item) => cloneImmutable(item)));

export const findEventTimelineItem = (
  state: TimelineState,
  eventId: string,
): TimelineItem | undefined => {
  return findIndexedItem(state.index, `event:${eventId}`);
};

const findLowerBound = (
  items: readonly TimelineItem[],
  item: TimelineItem,
): number => {
  let lower = 0;
  let upper = items.length;
  while (lower < upper) {
    const middle = Math.floor((lower + upper) / 2);
    const current = items[middle]!;
    if (compareTimelineItems(current, item) < 0) lower = middle + 1;
    else upper = middle;
  }
  return lower;
};

const findCurrentIndex = (
  items: readonly TimelineItem[],
  item: TimelineItem,
): number => {
  const index = findLowerBound(items, item);
  const candidate = items[index];
  return candidate !== undefined &&
    getTimelineItemKey(candidate) === getTimelineItemKey(item)
    ? index
    : -1;
};

export const upsertTimelineItem = (
  state: TimelineState,
  candidate: TimelineItem,
  authorOnly = false,
): TimelineState => {
  const durableKey = durableMessageKey(candidate);
  const current =
    findIndexedItem(state.index, getTimelineItemKey(candidate)) ??
    (durableKey === undefined
      ? undefined
      : findIndexedItem(state.index, durableKey));
  if (current !== undefined && candidate.id !== current.id)
    candidate = { ...candidate, id: current.id };
  const key = getTimelineItemKey(candidate);
  if (
    authorOnly &&
    (current?.kind !== "message" || candidate.kind !== "message")
  )
    return state;
  const projected =
    authorOnly && current?.kind === "message" && candidate.kind === "message"
      ? {
          ...current,
          author: candidate.author,
          provenance: candidate.provenance,
        }
      : candidate;
  const retainedCandidate =
    projected.kind === "message" &&
    projected.provenance?.kind === "provisional" &&
    projected.provenance.source !== "history" &&
    projected.provenance.reviewRequired !== false &&
    current?.kind === "message" &&
    current.provenance?.kind === "provisional" &&
    current.provenance.reviewRequired === true
      ? {
          ...projected,
          provenance: { ...projected.provenance, reviewRequired: true },
        }
      : projected;
  const item = cloneImmutable(
    retainedCandidate.kind === "message" &&
      retainedCandidate.provenance?.kind === "persisted" &&
      retainedCandidate.provenance.source === "history"
      ? retainedCandidate
      : withConfirmedAuthor(retainedCandidate, current),
  );

  if (current !== undefined) {
    if (deepEqual(current, item)) return state;
    const currentIndex = findCurrentIndex(state.items, current);
    if (currentIndex < 0) {
      throw new Error(`Timeline index is inconsistent for ${key}`);
    }

    if (compareTimelineItems(current, item) === 0) {
      const items = [...state.items];
      items[currentIndex] = item;
      const frozenItems = freezeItems(items);
      return {
        items: frozenItems,
        index: advanceIndex(state.index, key, item, frozenItems),
      };
    }

    const withoutCurrent = [...state.items];
    withoutCurrent.splice(currentIndex, 1);
    const insertionIndex = findLowerBound(withoutCurrent, item);
    withoutCurrent.splice(insertionIndex, 0, item);
    const items = freezeItems(withoutCurrent);
    return { items, index: advanceIndex(state.index, key, item, items) };
  }

  const insertionIndex = findLowerBound(state.items, item);
  const items = [...state.items];
  items.splice(insertionIndex, 0, item);
  const frozenItems = freezeItems(items);
  return {
    items: frozenItems,
    index: advanceIndex(state.index, key, item, frozenItems),
  };
};

/** Merge an older history page while preserving newer in-memory items. */
export const mergeHistoryTimeline = (
  current: TimelineState,
  history: readonly TimelineItem[],
  preferHistoryAuthor = false,
): TimelineState => {
  const byKey = new Map<string, TimelineItem>();
  for (const item of alignDurableDisplayIds(history, current.items)) {
    const immutable = cloneImmutable(item);
    byKey.set(getTimelineItemKey(immutable), immutable);
  }
  for (const item of current.items) {
    const key = getTimelineItemKey(item);
    byKey.set(
      key,
      withConfirmedAuthor(item, byKey.get(key), preferHistoryAuthor),
    );
  }

  const merged = createFromImmutableItems([...byKey.values()]);
  return deepEqual(merged.items, current.items) ? current : merged;
};

/**
 * Rebase a freshly loaded timeline onto changes published since the load began.
 * Current changes win per stable item key; otherwise the loaded value (including
 * a deletion) is adopted.
 */
export const rebaseTimelineState = (
  baseline: TimelineState,
  loaded: TimelineState,
  current: TimelineState,
): TimelineState => {
  const baselineByKey = new Map(
    baseline.items.map((item) => [getTimelineItemKey(item), item]),
  );
  const loadedByKey = new Map(
    alignDurableDisplayIds(loaded.items, current.items).map((item) => [
      getTimelineItemKey(item),
      item,
    ]),
  );
  const currentByKey = new Map(
    current.items.map((item) => [getTimelineItemKey(item), item]),
  );
  const keys = new Set([
    ...baselineByKey.keys(),
    ...loadedByKey.keys(),
    ...currentByKey.keys(),
  ]);
  const rebasedItems: TimelineItem[] = [];

  for (const key of keys) {
    const baselineItem = baselineByKey.get(key);
    const loadedItem = loadedByKey.get(key);
    const currentItem = currentByKey.get(key);
    const selected = deepEqual(currentItem, baselineItem)
      ? loadedItem
      : currentItem;
    const currentHistoryAuthorChanged =
      currentItem?.kind === "message" &&
      currentItem.provenance?.kind === "persisted" &&
      currentItem.provenance.source === "history" &&
      (baselineItem?.kind !== "message" ||
        !deepEqual(currentItem.author, baselineItem.author) ||
        !deepEqual(currentItem.provenance, baselineItem.provenance));
    if (selected !== undefined)
      rebasedItems.push(
        withConfirmedAuthor(selected, loadedItem, !currentHistoryAuthorChanged),
      );
  }

  const rebased = createFromImmutableItems(rebasedItems);
  if (deepEqual(rebased.items, current.items)) return current;
  if (deepEqual(rebased.items, loaded.items)) return loaded;
  return rebased;
};

/** Preserve unmatched transient projections without inventing identity or coverage. */
export const retainProvisionalTimeline = (
  latest: readonly TimelineItem[],
  previous: readonly TimelineItem[],
  reviewUnmatched = true,
): readonly TimelineItem[] => {
  const keys = new Set(latest.map(getTimelineItemKey));
  const unmatched = previous
    .filter(
      (item) =>
        item.kind === "message" &&
        item.provenance?.kind === "provisional" &&
        !keys.has(getTimelineItemKey(item)),
    )
    .map((item) =>
      item.kind === "message" &&
      item.provenance?.kind === "provisional" &&
      reviewUnmatched
        ? { ...item, provenance: { ...item.provenance, reviewRequired: true } }
        : item,
    );
  return unmatched.length === 0
    ? latest
    : mergeHistoryTimeline(createTimelineState(latest), unmatched).items;
};
