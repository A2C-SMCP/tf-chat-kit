import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from "react";

import type {
  InteractionClient,
  InteractionClientSnapshot,
  InteractionEntry,
  InteractionResponseInput,
} from "@turingfocus/chat-runtime";

/** UI-facing projection of one Runtime interaction entry. */
export type InteractionView = InteractionEntry;
/** Runtime snapshot; the single source of truth for queue and countdown state. */
export type InteractionSnapshot = InteractionClientSnapshot;

const EMPTY_INTERACTION_SNAPSHOT: InteractionClientSnapshot = Object.freeze({
  connection: "disconnected",
  entries: Object.freeze({}),
  activeId: null,
  now: 0,
});

const NOOP_UNSUBSCRIBE = (): void => undefined;

/** UI-local answer draft. It survives ack-timeout retries and inline/modal switches. */
export interface InteractionDraft {
  readonly selected: readonly string[];
  readonly customText: string;
}

export interface InteractionQueueState {
  readonly active: InteractionView | null;
  readonly waiting: readonly InteractionView[];
  readonly connection: InteractionClientSnapshot["connection"];
  readonly now: number;
  readonly liveCount: number;
  readonly activate: (interactionId: string) => void;
  readonly respond: (
    interactionId: string,
    input: InteractionResponseInput,
  ) => boolean;
  readonly getDraft: (interactionId: string) => InteractionDraft | undefined;
  readonly setDraft: (
    interactionId: string,
    draft: InteractionDraft | undefined,
  ) => void;
}

const EMPTY_QUEUE_STATE: InteractionQueueState = Object.freeze({
  active: null,
  waiting: Object.freeze([]),
  connection: "disconnected",
  now: 0,
  liveCount: 0,
  activate: () => undefined,
  respond: () => false,
  getDraft: () => undefined,
  setDraft: () => undefined,
});

interface InteractionClientContextValue {
  readonly client: InteractionClient | null;
}

const InteractionClientContext =
  createContext<InteractionClientContextValue | null>(null);
const InteractionQueueContext = createContext<InteractionQueueState | null>(
  null,
);

export interface InteractionProviderProps {
  /**
   * Host-owned interaction client. `undefined` inherits the nearest provider;
   * `null` explicitly disables interaction UI for this subtree.
   */
  readonly client?: InteractionClient | null | undefined;
  readonly children?: ReactNode | undefined;
}

const InteractionQueueSubscriber = ({
  client,
  children,
}: {
  readonly client: InteractionClient;
  readonly children?: ReactNode | undefined;
}) => {
  const subscribe = useCallback(
    (onStoreChange: () => void) => client.subscribe(onStoreChange),
    [client],
  );
  const getSnapshot = useCallback(() => client.getSnapshot(), [client]);
  const getServerSnapshot = useCallback(() => EMPTY_INTERACTION_SNAPSHOT, []);
  const snapshot = useSyncExternalStore(
    subscribe,
    getSnapshot,
    getServerSnapshot,
  );
  const activate = useCallback(
    (interactionId: string): void => {
      client.activate(interactionId);
    },
    [client],
  );
  const respond = useCallback(
    (interactionId: string, input: InteractionResponseInput): boolean =>
      client.respond(interactionId, input),
    [client],
  );
  const drafts = useRef(new Map<string, InteractionDraft>());
  const previousClient = useRef(client);
  if (previousClient.current !== client) {
    previousClient.current = client;
    drafts.current.clear();
  }
  useEffect(() => {
    const liveIds = new Set(
      Object.values(snapshot.entries)
        .filter((entry) => entry.status !== "closed")
        .map((entry) => entry.interactionId),
    );
    for (const interactionId of drafts.current.keys()) {
      if (!liveIds.has(interactionId)) drafts.current.delete(interactionId);
    }
  }, [snapshot.entries]);
  const getDraft = useCallback(
    (interactionId: string) => drafts.current.get(interactionId),
    [],
  );
  const setDraft = useCallback(
    (interactionId: string, draft: InteractionDraft | undefined): void => {
      if (draft === undefined) drafts.current.delete(interactionId);
      else drafts.current.set(interactionId, draft);
    },
    [],
  );
  const queue = useMemo<InteractionQueueState>(() => {
    const live = Object.values(snapshot.entries).filter(
      (entry) => entry.status !== "closed",
    );
    const active =
      snapshot.activeId === null
        ? null
        : (snapshot.entries[snapshot.activeId] ?? null);
    const activeLive =
      active !== null && active.status !== "closed" ? active : null;
    const waiting = live.filter(
      (entry) => entry.interactionId !== activeLive?.interactionId,
    );
    return {
      active: activeLive,
      waiting,
      connection: snapshot.connection,
      now: snapshot.now,
      liveCount: live.length,
      activate,
      respond,
      getDraft,
      setDraft,
    };
  }, [activate, getDraft, respond, setDraft, snapshot]);

  return (
    <InteractionQueueContext.Provider value={queue}>
      {children}
    </InteractionQueueContext.Provider>
  );
};

/**
 * Host-owned Interaction subscription. The provider never creates, retries or
 * disposes the client; identity changes belong to the host.
 */
export const InteractionProvider = ({
  client,
  children,
}: InteractionProviderProps) => {
  const parent = useContext(InteractionClientContext);
  const resolved = client === undefined ? (parent?.client ?? null) : client;
  const value = useMemo<InteractionClientContextValue>(
    () => ({ client: resolved }),
    [resolved],
  );

  return (
    <InteractionClientContext.Provider value={value}>
      {resolved === null ? (
        <InteractionQueueContext.Provider value={EMPTY_QUEUE_STATE}>
          {children}
        </InteractionQueueContext.Provider>
      ) : (
        <InteractionQueueSubscriber client={resolved}>
          {children}
        </InteractionQueueSubscriber>
      )}
    </InteractionClientContext.Provider>
  );
};

export const useInteractionClient = (): InteractionClient | null => {
  const context = useContext(InteractionClientContext);
  return context?.client ?? null;
};

export const useHasInteractionClient = (): boolean =>
  useInteractionClient() !== null;

export const useInteractionSnapshot = (): InteractionClientSnapshot => {
  const client = useInteractionClient();
  const subscribe = useCallback(
    (onStoreChange: () => void) =>
      client?.subscribe(onStoreChange) ?? NOOP_UNSUBSCRIBE,
    [client],
  );
  const getSnapshot = useCallback(
    () => client?.getSnapshot() ?? EMPTY_INTERACTION_SNAPSHOT,
    [client],
  );
  const getServerSnapshot = useCallback(() => EMPTY_INTERACTION_SNAPSHOT, []);
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
};

/** Active/waiting projection. Active selection and EDF order are runtime-owned. */
export const useInteractionQueue = (): InteractionQueueState => {
  const context = useContext(InteractionQueueContext);
  return context ?? EMPTY_QUEUE_STATE;
};
