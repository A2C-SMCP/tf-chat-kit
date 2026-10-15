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

const serverMessageKey = (item: TimelineItem): string | undefined =>
  item.kind === "message" && item.serverMessageId !== undefined
    ? `server-message:${JSON.stringify([item.conversationId, item.serverMessageId])}`
    : undefined;

const identityKeys = (item: TimelineItem): readonly string[] =>
  [
    serverMessageKey(item),
    durableMessageKey(item),
    getTimelineItemKey(item),
  ].filter((key): key is string => key !== undefined);

/** Internal conflict marker so untrusted display caches can be discarded precisely. */
export class TimelineIdentityConflictError extends Error {
  constructor() {
    super("Conflicting server message identity");
  }
}

const checkMessageIdentity = (
  item: TimelineItem,
  other: TimelineItem | undefined,
): void => {
  if (item.kind !== "message" || other?.kind !== "message") return;
  if (
    (item.serverMessageId !== undefined &&
      other.serverMessageId !== undefined &&
      item.serverMessageId !== other.serverMessageId) ||
    ((item.serverMessageId !== undefined ||
      other.serverMessageId !== undefined) &&
      item.provenance?.kind === "persisted" &&
      other.provenance?.kind === "persisted" &&
      item.provenance.id !== other.provenance.id)
  )
    throw new TimelineIdentityConflictError();
};

/** A known database fact can span display IDs; this grants no recovery assurance. */
export const getTimelineRecoveryKey = (item: TimelineItem): string =>
  (item.kind === "message" && item.provenance?.kind === "persisted"
    ? serverMessageKey(item)
    : undefined) ??
  durableMessageKey(item) ??
  getTimelineItemKey(item);

/** Preserve legacy Gateway display-key overlap without accepting provisional coverage. */
export const getTimelineRecoveryKeys = (
  item: TimelineItem,
): readonly string[] => {
  if (item.kind === "message" && item.provenance?.kind === "provisional")
    return [];
  return identityKeys(item);
};

const alignDurableDisplayIds = (
  candidates: readonly TimelineItem[],
  reference: readonly TimelineItem[],
): readonly TimelineItem[] => {
  const aliases = new Map<string, TimelineItem>();
  for (const item of reference)
    for (const key of identityKeys(item)) aliases.set(key, item);
  return candidates.map((item) => {
    const matched = identityKeys(item)
      .map((key) => aliases.get(key))
      .find((match) => match !== undefined);
    checkMessageIdentity(item, matched);
    return matched === undefined || matched.id === item.id
      ? item
      : { ...item, id: matched.id };
  });
};

/** Keep evolving content, but never downgrade a history-confirmed author. */
const withConfirmedAuthor = (
  preferred: TimelineItem,
  other: TimelineItem | undefined,
  preferOtherHistory = false,
): TimelineItem => {
  checkMessageIdentity(preferred, other);
  if (
    preferred.kind === "message" &&
    other?.kind === "message" &&
    preferred.serverMessageId === undefined &&
    other.serverMessageId !== undefined
  )
    preferred = { ...preferred, serverMessageId: other.serverMessageId };
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
    for (const key of identityKeys(item)) base.set(key, item);
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
  for (const alias of identityKeys(item)) overlay.set(alias, item);
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
  const aliases = new Map<string, TimelineItem>();
  for (const item of candidates) {
    const matches = [
      ...new Set(
        identityKeys(item)
          .map((key) => aliases.get(key))
          .filter((match): match is TimelineItem => match !== undefined),
      ),
    ];
    for (const match of matches) checkMessageIdentity(item, match);
    const existing = matches[0];
    const projection =
      existing === undefined
        ? item
        : matches.reduce(
            (preferred, match) => withConfirmedAuthor(preferred, match),
            { ...item, id: existing.id },
          );
    const candidate = Object.isFrozen(projection)
      ? projection
      : cloneImmutable(projection);
    for (const match of matches) byKey.delete(getTimelineItemKey(match));
    byKey.set(getTimelineItemKey(candidate), candidate);
    for (const key of [
      ...matches.flatMap(identityKeys),
      ...identityKeys(candidate),
    ])
      aliases.set(key, candidate);
  }
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
  const matches = [
    ...new Set(
      identityKeys(candidate)
        .map((key) => findIndexedItem(state.index, key))
        .filter((item): item is TimelineItem => item !== undefined),
    ),
  ];
  for (const match of matches) checkMessageIdentity(candidate, match);
  const current = matches[0];
  if (
    candidate.kind === "message" &&
    current?.kind === "message" &&
    candidate.serverMessageId === undefined &&
    current.serverMessageId !== undefined
  )
    candidate = { ...candidate, serverMessageId: current.serverMessageId };
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
          serverMessageId: candidate.serverMessageId ?? current.serverMessageId,
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
      : matches.reduce(
          (preferred, match) => withConfirmedAuthor(preferred, match),
          retainedCandidate,
        ),
  );

  if (matches.length > 1) {
    // A newly received database alias can bridge a pre-upgrade cache entry and
    // an already observed server identity. Remove both projections atomically.
    const matchedKeys = new Set(matches.map(getTimelineItemKey));
    return createFromImmutableItems([
      ...state.items.filter(
        (entry) => !matchedKeys.has(getTimelineItemKey(entry)),
      ),
      item,
    ]);
  }
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

  let merged = createFromImmutableItems([...byKey.values()]);
  if (preferHistoryAuthor) {
    // A newly confirmed fact can bridge several old display keys. Select its
    // author across the whole alias group, rather than Map insertion order.
    const authors = new Map<string, TimelineItem>();
    for (const item of history) {
      if (
        item.kind === "message" &&
        item.provenance?.kind === "persisted" &&
        item.provenance.source === "history"
      )
        for (const key of identityKeys(item)) authors.set(key, item);
    }
    merged = createFromImmutableItems(
      merged.items.map((item) => {
        const author = identityKeys(item)
          .map((key) => authors.get(key))
          .find((value) => value !== undefined);
        return withConfirmedAuthor(item, author, true);
      }),
    );
  }
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
  const keys = new Set(latest.flatMap(identityKeys));
  const unmatched = previous
    .filter(
      (item) =>
        item.kind === "message" &&
        item.provenance?.kind === "provisional" &&
        !identityKeys(item).some((key) => keys.has(key)),
    )
    .map((item) =>
      item.kind === "message" &&
      item.provenance?.kind === "provisional" &&
      reviewUnmatched &&
      item.serverMessageId === undefined
        ? { ...item, provenance: { ...item.provenance, reviewRequired: true } }
        : item,
    );
  return unmatched.length === 0
    ? latest
    : mergeHistoryTimeline(createTimelineState(latest), unmatched).items;
};
