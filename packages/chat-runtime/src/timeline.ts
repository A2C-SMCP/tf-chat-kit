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

const buildIndex = (items: readonly TimelineItem[]): TimelineItemIndex => ({
  base: new Map(items.map((item) => [getTimelineItemKey(item), item])),
  overlay: new Map(),
});

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
): TimelineState => {
  const item = cloneImmutable(candidate);
  const key = getTimelineItemKey(item);
  const current = findIndexedItem(state.index, key);

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
): TimelineState => {
  const byKey = new Map<string, TimelineItem>();
  for (const item of history) {
    const immutable = cloneImmutable(item);
    byKey.set(getTimelineItemKey(immutable), immutable);
  }
  for (const item of current.items) {
    byKey.set(getTimelineItemKey(item), item);
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
    loaded.items.map((item) => [getTimelineItemKey(item), item]),
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
    if (selected !== undefined) rebasedItems.push(selected);
  }

  const rebased = createFromImmutableItems(rebasedItems);
  if (deepEqual(rebased.items, current.items)) return current;
  if (deepEqual(rebased.items, loaded.items)) return loaded;
  return rebased;
};
