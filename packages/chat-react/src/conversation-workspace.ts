import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import {
  createConversationWorkspaceController,
  type ChatClient,
  type ConversationWorkspaceController,
  type ConversationWorkspaceControllerOptions,
  type ConversationWorkspaceSnapshot,
  type CreateWorkspaceConversationInput,
} from "@turingfocus/chat-runtime";

import { useChatClient } from "./hooks.js";

export interface UseConversationWorkspaceOptions {
  readonly getDeadlineAt: () => number;
  readonly initialSelection?: "first" | "none" | undefined;
  readonly onUnhandledError?: ((error: unknown) => void) | undefined;
  readonly orderConversations?: ConversationWorkspaceControllerOptions["orderConversations"];
  readonly pageSize?: number | undefined;
  /** Snapshot returned during SSR and before the effect-owned controller exists. */
  readonly serverSnapshot?: ConversationWorkspaceSnapshot | undefined;
}

export interface ConversationWorkspaceBinding {
  readonly controller: ConversationWorkspaceController | null;
  readonly ready: boolean;
  readonly snapshot: ConversationWorkspaceSnapshot;
  createConversation(
    input: CreateWorkspaceConversationInput,
  ): Promise<
    | Awaited<ReturnType<ConversationWorkspaceController["createConversation"]>>
    | undefined
  >;
  loadMore(): Promise<
    Awaited<ReturnType<ConversationWorkspaceController["loadMore"]>> | undefined
  >;
  refresh(): Promise<
    Awaited<ReturnType<ConversationWorkspaceController["refresh"]>> | undefined
  >;
  selectConversation(
    conversationId: string,
  ): Promise<
    | Awaited<ReturnType<ConversationWorkspaceController["selectConversation"]>>
    | undefined
  >;
}

interface WorkspaceConfiguration {
  readonly getDeadlineAt: () => number;
  readonly initialSelection: "first" | "none";
  readonly onUnhandledError: ((error: unknown) => void) | undefined;
  readonly orderConversations: ConversationWorkspaceControllerOptions["orderConversations"];
  readonly pageSize: number | undefined;
}

interface WorkspaceEntry {
  readonly client: ChatClient;
  readonly configuration: WorkspaceConfiguration;
  readonly controller: ConversationWorkspaceController;
}

const EMPTY_WORKSPACE_SNAPSHOT: ConversationWorkspaceSnapshot = Object.freeze({
  conversations: Object.freeze([]),
  creating: false,
  listStatus: "idle",
  selectionStatus: "idle",
});

const subscribeEmpty = (): (() => void) => () => undefined;

/**
 * Effect-owns the conversation workspace bound to the current ChatProvider.
 * Changing the ChatClient or configuration retires all old async work.
 */
export const useConversationWorkspace = (
  options: UseConversationWorkspaceOptions,
): ConversationWorkspaceBinding => {
  const client = useChatClient();
  const getDeadlineAtRef = useRef(options.getDeadlineAt);
  const onUnhandledErrorRef = useRef(options.onUnhandledError);
  const orderConversationsRef = useRef(options.orderConversations);
  getDeadlineAtRef.current = options.getDeadlineAt;
  onUnhandledErrorRef.current = options.onUnhandledError;
  orderConversationsRef.current = options.orderConversations;
  const getDeadlineAt = useCallback(() => getDeadlineAtRef.current(), []);
  const onUnhandledError = useCallback((error: unknown) => {
    onUnhandledErrorRef.current?.(error);
  }, []);
  const orderConversations = useCallback<
    NonNullable<ConversationWorkspaceControllerOptions["orderConversations"]>
  >(
    (conversations) =>
      orderConversationsRef.current?.(conversations) ?? conversations,
    [],
  );
  const configuration = useMemo<WorkspaceConfiguration>(
    () => ({
      getDeadlineAt,
      initialSelection: options.initialSelection ?? "first",
      onUnhandledError,
      orderConversations,
      pageSize: options.pageSize,
    }),
    [
      getDeadlineAt,
      options.initialSelection,
      options.pageSize,
      onUnhandledError,
      orderConversations,
    ],
  );
  const [entry, setEntry] = useState<WorkspaceEntry | null>(null);

  useEffect(() => {
    const controller = createConversationWorkspaceController({
      client,
      getDeadlineAt: configuration.getDeadlineAt,
      initialSelection: configuration.initialSelection,
      onUnhandledError: configuration.onUnhandledError,
      orderConversations: configuration.orderConversations,
      pageSize: configuration.pageSize,
    });
    const nextEntry = { client, configuration, controller };
    setEntry(nextEntry);
    void controller.start().catch((error: unknown) => {
      try {
        configuration.onUnhandledError?.(error);
      } catch {
        // A host diagnostic callback must not break effect cleanup.
      }
    });
    return () => {
      setEntry((current) => (current === nextEntry ? null : current));
      controller.dispose();
    };
  }, [client, configuration]);

  const activeEntry =
    entry?.client === client && entry.configuration === configuration
      ? entry
      : null;
  const subscribe = useCallback(
    (onStoreChange: () => void) =>
      activeEntry === null
        ? subscribeEmpty()
        : activeEntry.controller.subscribe(onStoreChange).dispose,
    [activeEntry],
  );
  const getSnapshot = useCallback(
    () => activeEntry?.controller.getSnapshot() ?? EMPTY_WORKSPACE_SNAPSHOT,
    [activeEntry],
  );
  const getServerSnapshot = useCallback(
    () => options.serverSnapshot ?? EMPTY_WORKSPACE_SNAPSHOT,
    [options.serverSnapshot],
  );
  const snapshot = useSyncExternalStore(
    subscribe,
    getSnapshot,
    getServerSnapshot,
  );

  const refresh = useCallback(
    () => activeEntry?.controller.refresh() ?? Promise.resolve(undefined),
    [activeEntry],
  );
  const loadMore = useCallback(
    () => activeEntry?.controller.loadMore() ?? Promise.resolve(undefined),
    [activeEntry],
  );
  const createConversation = useCallback(
    (input: CreateWorkspaceConversationInput) =>
      activeEntry?.controller.createConversation(input) ??
      Promise.resolve(undefined),
    [activeEntry],
  );
  const selectConversation = useCallback(
    (conversationId: string) =>
      activeEntry?.controller.selectConversation(conversationId) ??
      Promise.resolve(undefined),
    [activeEntry],
  );

  return useMemo(
    () => ({
      controller: activeEntry?.controller ?? null,
      createConversation,
      loadMore,
      ready: activeEntry !== null,
      refresh,
      selectConversation,
      snapshot,
    }),
    [
      activeEntry,
      createConversation,
      loadMore,
      refresh,
      selectConversation,
      snapshot,
    ],
  );
};
