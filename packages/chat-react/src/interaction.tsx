import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
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
  /**
   * Increments when the client or draft scope changes. Consumers include it in
   * card keys so a mounted editor cannot submit old input to a new client.
   */
  readonly clientGeneration: number;
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
  clientGeneration: 0,
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
  /**
   * Opaque host identity scope for answer drafts (for example
   * `managerChatIdentityScope(identity)`). Drafts are discarded when it
   * changes, so an answer typed for one account, organization or robot is
   * never submitted under another. When omitted, drafts are scoped to the
   * client instance and discarded when that instance changes.
   */
  readonly scope?: string | undefined;
  readonly children?: ReactNode | undefined;
}

interface StoredDraft {
  /** Client instance or identity scope; compared by reference/equality. */
  readonly key: unknown;
  readonly draft: InteractionDraft;
}

const InteractionQueueSubscriber = ({
  client,
  scope,
  generation,
  children,
}: {
  readonly client: InteractionClient;
  readonly scope: string | undefined;
  readonly generation: number;
  readonly children?: ReactNode | undefined;
}) => {
  // Same identity + new client keeps drafts; a new identity or an unscoped
  // client replacement never exposes an old draft.
  const draftKey: unknown = scope === undefined ? client : scope;
  const drafts = useRef(new Map<string, StoredDraft>());
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
  useEffect(() => {
    const liveIds = new Set(
      Object.values(snapshot.entries)
        .filter((entry) => entry.status !== "closed")
        .map((entry) => entry.interactionId),
    );
    for (const [interactionId, stored] of drafts.current) {
      if (stored.key !== draftKey || !liveIds.has(interactionId))
        drafts.current.delete(interactionId);
    }
  }, [draftKey, snapshot.entries]);
  const getDraft = useCallback(
    (interactionId: string): InteractionDraft | undefined => {
      const stored = drafts.current.get(interactionId);
      return stored !== undefined && stored.key === draftKey
        ? stored.draft
        : undefined;
    },
    [draftKey],
  );
  const setDraft = useCallback(
    (interactionId: string, draft: InteractionDraft | undefined): void => {
      if (draft === undefined) drafts.current.delete(interactionId);
      else drafts.current.set(interactionId, { draft, key: draftKey });
    },
    [draftKey],
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
      clientGeneration: generation,
      activate,
      respond,
      getDraft,
      setDraft,
    };
  }, [activate, generation, getDraft, respond, setDraft, snapshot]);

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
  scope,
  children,
}: InteractionProviderProps) => {
  const parent = useContext(InteractionClientContext);
  const resolved = client === undefined ? (parent?.client ?? null) : client;
  const value = useMemo<InteractionClientContextValue>(
    () => ({ client: resolved }),
    [resolved],
  );
  const draftKey: unknown =
    resolved === null ? null : scope === undefined ? resolved : scope;
  const [clientKeyState, setClientKeyState] = useState<{
    key: unknown;
    generation: number;
  }>(() => ({ key: draftKey, generation: 0 }));
  if (clientKeyState.key !== draftKey) {
    setClientKeyState({
      key: draftKey,
      generation: clientKeyState.generation + 1,
    });
  }

  // Inheritance is wholesale: children keep using the parent's subscription,
  // draft store, scope and generation. A nested provider must not create a
  // second store, or inline and modal cards would lose each other's drafts.
  if (client === undefined && parent !== null) return <>{children}</>;

  return (
    <InteractionClientContext.Provider value={value}>
      {resolved === null ? (
        <InteractionQueueContext.Provider value={EMPTY_QUEUE_STATE}>
          {children}
        </InteractionQueueContext.Provider>
      ) : (
        <InteractionQueueSubscriber
          client={resolved}
          generation={clientKeyState.generation}
          scope={scope}
        >
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
