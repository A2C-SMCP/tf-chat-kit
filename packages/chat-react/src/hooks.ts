import { useCallback, useContext, useMemo, useSyncExternalStore } from "react";

import type { ChatClient } from "@turingfocus/chat-runtime";

import {
  ChatContext,
  type ChatContextValue,
  type ChatSnapshotValue,
} from "./context.js";

export type ChatSelector<T> = (snapshot: ChatSnapshotValue) => T;
export type ChatSelectorEquality<T> = (left: T, right: T) => boolean;

const useChatContext = (): ChatContextValue => {
  const context = useContext(ChatContext);
  if (context === null) {
    throw new Error("Chat hooks must be used within a ChatProvider");
  }
  return context;
};

const useChatSubscription = (
  client: ChatClient,
): ((onStoreChange: () => void) => () => void) =>
  useCallback(
    (onStoreChange) => {
      const subscription = client.subscribe(() => {
        onStoreChange();
      });
      return () => {
        subscription.dispose();
      };
    },
    [client],
  );

export const useChatClient = (): ChatClient => useChatContext().client;

export const useChatSnapshot = (): ChatSnapshotValue => {
  const { client, serverSnapshot } = useChatContext();
  const subscribe = useChatSubscription(client);
  const getSnapshot = useCallback(() => client.getSnapshot(), [client]);
  const getServerSnapshot = useCallback(() => serverSnapshot, [serverSnapshot]);

  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
};

const createSelectionReader = <T>(
  readSnapshot: () => ChatSnapshotValue,
  selector: ChatSelector<T>,
  isEqual: ChatSelectorEquality<T>,
): (() => T) => {
  let hasMemo = false;
  let memoizedSnapshot: ChatSnapshotValue;
  let memoizedSelection: T;

  return () => {
    const snapshot = readSnapshot();
    if (hasMemo && Object.is(snapshot, memoizedSnapshot)) {
      return memoizedSelection;
    }

    const selection = selector(snapshot);
    if (hasMemo && isEqual(memoizedSelection, selection)) {
      memoizedSnapshot = snapshot;
      return memoizedSelection;
    }

    hasMemo = true;
    memoizedSnapshot = snapshot;
    memoizedSelection = selection;
    return selection;
  };
};

/**
 * Subscribes to a selected slice. Equal selections retain their previous
 * reference so unrelated Runtime updates do not re-render the consumer.
 */
export const useChatSelector = <T>(
  selector: ChatSelector<T>,
  isEqual: ChatSelectorEquality<T> = Object.is,
): T => {
  const { client, serverSnapshot } = useChatContext();
  const subscribe = useChatSubscription(client);
  const readClientSnapshot = useCallback(() => client.getSnapshot(), [client]);
  const readServerSnapshot = useCallback(
    () => serverSnapshot,
    [serverSnapshot],
  );
  const getSelection = useMemo(
    () => createSelectionReader(readClientSnapshot, selector, isEqual),
    [isEqual, readClientSnapshot, selector],
  );
  const getServerSelection = useMemo(
    () => createSelectionReader(readServerSnapshot, selector, isEqual),
    [isEqual, readServerSnapshot, selector],
  );

  return useSyncExternalStore(subscribe, getSelection, getServerSelection);
};
