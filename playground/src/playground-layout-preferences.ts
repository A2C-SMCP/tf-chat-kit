export const PLAYGROUND_EVENT_DETAIL_SPLIT_RATIO_STORAGE_KEY =
  "tf-chat-kit.playground.event-detail-split-ratio.v1";

export const DEFAULT_PLAYGROUND_EVENT_DETAIL_SPLIT_RATIO = 0.56;
const MIN_PLAYGROUND_EVENT_DETAIL_SPLIT_RATIO = 0.2;
const MAX_PLAYGROUND_EVENT_DETAIL_SPLIT_RATIO = 0.8;

export interface PlaygroundLayoutPreferenceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const browserStorage = (): PlaygroundLayoutPreferenceStorage | undefined => {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
};

export const readPlaygroundEventDetailSplitRatio = (
  storage: PlaygroundLayoutPreferenceStorage | undefined = browserStorage(),
): number => {
  if (storage === undefined) {
    return DEFAULT_PLAYGROUND_EVENT_DETAIL_SPLIT_RATIO;
  }

  try {
    const stored = storage.getItem(
      PLAYGROUND_EVENT_DETAIL_SPLIT_RATIO_STORAGE_KEY,
    );
    if (stored === null || stored.trim().length === 0) {
      return DEFAULT_PLAYGROUND_EVENT_DETAIL_SPLIT_RATIO;
    }
    const ratio = Number(stored);
    return Number.isFinite(ratio) &&
      ratio >= MIN_PLAYGROUND_EVENT_DETAIL_SPLIT_RATIO &&
      ratio <= MAX_PLAYGROUND_EVENT_DETAIL_SPLIT_RATIO
      ? ratio
      : DEFAULT_PLAYGROUND_EVENT_DETAIL_SPLIT_RATIO;
  } catch {
    return DEFAULT_PLAYGROUND_EVENT_DETAIL_SPLIT_RATIO;
  }
};

export const writePlaygroundEventDetailSplitRatio = (
  ratio: number,
  storage: PlaygroundLayoutPreferenceStorage | undefined = browserStorage(),
): boolean => {
  if (
    storage === undefined ||
    !Number.isFinite(ratio) ||
    ratio < MIN_PLAYGROUND_EVENT_DETAIL_SPLIT_RATIO ||
    ratio > MAX_PLAYGROUND_EVENT_DETAIL_SPLIT_RATIO
  ) {
    return false;
  }

  try {
    storage.setItem(
      PLAYGROUND_EVENT_DETAIL_SPLIT_RATIO_STORAGE_KEY,
      String(ratio),
    );
    return true;
  } catch {
    return false;
  }
};
