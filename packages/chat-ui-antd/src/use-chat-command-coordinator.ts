import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type { ChatError, Run } from "@turingfocus/chat-protocol";
import type { ChatProviderProps } from "@turingfocus/chat-react";

type ChatClient = ChatProviderProps["client"];

export type ChatUiCommand = "interrupt" | "sendText";

export interface ChatUiCommandFailure {
  readonly command: ChatUiCommand;
  readonly error: ChatError;
}

interface ChatViewScope {
  readonly client: ChatClient;
  readonly conversationId: string | null;
  readonly resetKey: string;
}

interface ChatRunScope {
  readonly canInterrupt: boolean;
  readonly run: Run | null;
  readonly view: ChatViewScope;
}

interface ChatUiCommandFailureEntry {
  readonly error: ChatError;
  readonly runScope?: ChatRunScope | undefined;
  readonly visible: boolean;
}

interface ChatUiCommandFailureState {
  readonly failures: Readonly<
    Partial<Record<ChatUiCommand, ChatUiCommandFailureEntry>>
  >;
  readonly viewScope: ChatViewScope | null;
}

interface ChatUiCommandRequest {
  readonly client: ChatClient;
  readonly command: ChatUiCommand;
  readonly conversationId: string;
  readonly requestId: number;
  readonly runId?: string | undefined;
  readonly runScope?: ChatRunScope | undefined;
  readonly viewScope: ChatViewScope;
}

interface UseChatCommandCoordinatorInput {
  readonly canInterrupt: boolean;
  readonly client: ChatClient;
  readonly conversationId: string | null;
  readonly getDeadlineAt: () => number;
  readonly onCommandError?:
    ((failure: ChatUiCommandFailure) => void) | undefined;
  readonly run: Run | null;
  readonly snapshotError: ChatError | undefined;
}

interface UseChatCommandCoordinatorResult {
  readonly dismissFailure: (command: ChatUiCommand) => void;
  readonly interrupt: () => Promise<boolean>;
  readonly sendText: (text: string) => Promise<boolean>;
  readonly viewResetKey: string;
  readonly visibleCommandFailures: readonly ChatUiCommandFailure[];
  readonly visibleSnapshotError: ChatError | undefined;
}

interface UseChatCommandScopesInput {
  readonly canInterrupt: boolean;
  readonly client: ChatClient;
  readonly conversationId: string | null;
  readonly run: Run | null;
}

interface ChatCommandScopes {
  readonly beginRequest: (
    command: ChatUiCommand,
    activeConversationId: string,
    runId?: string | undefined,
  ) => ChatUiCommandRequest;
  readonly isFailureRelevant: (request: ChatUiCommandRequest) => boolean;
  readonly isLatestRequest: (request: ChatUiCommandRequest) => boolean;
  readonly runScope: ChatRunScope;
  readonly viewScope: ChatViewScope;
}

const clientIdentityByInstance = new WeakMap<object, number>();
let nextClientIdentity = 0;

const getClientIdentity = (client: ChatClient): number => {
  const existing = clientIdentityByInstance.get(client);
  if (existing !== undefined) return existing;
  nextClientIdentity += 1;
  clientIdentityByInstance.set(client, nextClientIdentity);
  return nextClientIdentity;
};

const useCommitEffect =
  typeof window === "undefined" ? useEffect : useLayoutEffect;

const unexpectedCommandError = (conversationId: string): ChatError => ({
  code: "unknown",
  conversationId,
  message: "The chat command failed unexpectedly.",
  retryable: true,
});

const chatUiCommands: readonly ChatUiCommand[] = ["sendText", "interrupt"];

const sameChatError = (left: ChatError, right: ChatError): boolean =>
  left === right ||
  (left.code === right.code &&
    left.conversationId === right.conversationId &&
    left.message === right.message);

const createViewResetKey = (
  client: ChatClient,
  conversationId: string | null,
): string => {
  const clientIdentity = getClientIdentity(client);
  return conversationId === null
    ? `${clientIdentity}:none`
    : `${clientIdentity}:conversation:${conversationId.length}:${conversationId}`;
};

const useChatCommandScopes = ({
  canInterrupt,
  client,
  conversationId,
  run,
}: UseChatCommandScopesInput): ChatCommandScopes => {
  const viewScope = useMemo<ChatViewScope>(
    () => ({
      client,
      conversationId,
      resetKey: createViewResetKey(client, conversationId),
    }),
    [client, conversationId],
  );
  const runScope = useMemo<ChatRunScope>(
    () => ({ canInterrupt, run, view: viewScope }),
    [canInterrupt, run, viewScope],
  );
  const committedViewScope = useRef(viewScope);
  const committedRunScope = useRef(runScope);
  const mounted = useRef(true);
  const commandRequestIds = useRef<Record<ChatUiCommand, number>>({
    interrupt: 0,
    sendText: 0,
  });

  useCommitEffect(() => {
    committedViewScope.current = viewScope;
    committedRunScope.current = runScope;
  }, [runScope, viewScope]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      commandRequestIds.current.interrupt += 1;
      commandRequestIds.current.sendText += 1;
    };
  }, []);

  const isLatestRequest = useCallback(
    (request: ChatUiCommandRequest): boolean => {
      if (!mounted.current) return false;
      if (commandRequestIds.current[request.command] !== request.requestId) {
        return false;
      }
      if (
        committedViewScope.current !== request.viewScope ||
        request.client !== request.viewScope.client
      ) {
        return false;
      }
      return (
        request.client.getSnapshot()?.conversation.id === request.conversationId
      );
    },
    [],
  );

  const isFailureRelevant = useCallback(
    (request: ChatUiCommandRequest): boolean => {
      if (!isLatestRequest(request)) return false;
      if (request.command !== "interrupt") return true;
      if (
        request.runScope === undefined ||
        committedRunScope.current !== request.runScope
      ) {
        return false;
      }
      const current = request.client.getSnapshot();
      const activeRun = current?.run;
      return (
        current?.capabilities.interrupt === true &&
        activeRun !== null &&
        activeRun !== undefined &&
        activeRun.id === request.runId &&
        activeRun.canInterrupt &&
        activeRun.status === "running"
      );
    },
    [isLatestRequest],
  );

  const beginRequest = useCallback(
    (
      command: ChatUiCommand,
      activeConversationId: string,
      runId?: string | undefined,
    ): ChatUiCommandRequest => {
      const requestId = commandRequestIds.current[command] + 1;
      commandRequestIds.current[command] = requestId;
      return {
        client,
        command,
        conversationId: activeConversationId,
        requestId,
        viewScope,
        ...(command === "interrupt" ? { runId, runScope } : {}),
      };
    },
    [client, runScope, viewScope],
  );

  return {
    beginRequest,
    isFailureRelevant,
    isLatestRequest,
    runScope,
    viewScope,
  };
};

export const useChatCommandCoordinator = ({
  canInterrupt,
  client,
  conversationId,
  getDeadlineAt,
  onCommandError,
  run,
  snapshotError,
}: UseChatCommandCoordinatorInput): UseChatCommandCoordinatorResult => {
  const {
    beginRequest,
    isFailureRelevant,
    isLatestRequest,
    runScope,
    viewScope,
  } = useChatCommandScopes({
    canInterrupt,
    client,
    conversationId,
    run,
  });
  const [failureState, setFailureState] = useState<ChatUiCommandFailureState>({
    failures: {},
    viewScope: null,
  });

  const reportFailure = useCallback(
    (request: ChatUiCommandRequest, error: ChatError): boolean => {
      if (!isLatestRequest(request)) return true;
      const visible = isFailureRelevant(request);
      const failure = { command: request.command, error };
      setFailureState((current) => ({
        failures: {
          ...(current.viewScope === request.viewScope ? current.failures : {}),
          [request.command]: {
            error,
            runScope: request.runScope,
            visible,
          },
        },
        viewScope: request.viewScope,
      }));
      if (visible) onCommandError?.(failure);
      return !visible;
    },
    [isFailureRelevant, isLatestRequest, onCommandError],
  );

  const clearFailure = useCallback(
    (request: ChatUiCommandRequest): void => {
      if (!isLatestRequest(request)) return;
      setFailureState((current) => {
        if (current.viewScope !== request.viewScope) return current;
        const failure = current.failures[request.command];
        return failure === undefined
          ? current
          : {
              ...current,
              failures: {
                ...current.failures,
                [request.command]: { ...failure, visible: false },
              },
            };
      });
    },
    [isLatestRequest],
  );

  const dismissFailure = useCallback((command: ChatUiCommand): void => {
    setFailureState((current) => {
      const failure = current.failures[command];
      return failure === undefined
        ? current
        : {
            ...current,
            failures: {
              ...current.failures,
              [command]: { ...failure, visible: false },
            },
          };
    });
  }, []);

  const sendText = useCallback(
    async (text: string): Promise<boolean> => {
      if (conversationId === null) return false;
      const request = beginRequest("sendText", conversationId);
      let result: Awaited<ReturnType<ChatClient["sendText"]>> | undefined;
      try {
        result = await client.sendText({
          conversationId,
          deadlineAt: getDeadlineAt(),
          text,
        });
      } catch {
        return reportFailure(request, unexpectedCommandError(conversationId));
      }
      if (!result.ok) return reportFailure(request, result.error);
      clearFailure(request);
      return true;
    },
    [
      beginRequest,
      clearFailure,
      client,
      conversationId,
      getDeadlineAt,
      reportFailure,
    ],
  );

  const interrupt = useCallback(async (): Promise<boolean> => {
    if (conversationId === null) return false;
    const runId = run?.id;
    const request = beginRequest("interrupt", conversationId, runId);
    try {
      const result = await client.interrupt({
        conversationId,
        deadlineAt: getDeadlineAt(),
        ...(runId === undefined ? {} : { runId }),
      });
      if (!result.ok) return reportFailure(request, result.error);
    } catch {
      return reportFailure(request, unexpectedCommandError(conversationId));
    }
    clearFailure(request);
    return true;
  }, [
    beginRequest,
    clearFailure,
    client,
    conversationId,
    getDeadlineAt,
    reportFailure,
    run?.id,
  ]);

  const visibleCommandFailures =
    failureState.viewScope === viewScope
      ? chatUiCommands.flatMap((command) => {
          const entry = failureState.failures[command];
          if (
            entry === undefined ||
            !entry.visible ||
            (command === "interrupt" && entry.runScope !== runScope)
          ) {
            return [];
          }
          return [{ command, error: entry.error }];
        })
      : [];
  const trackedCommandFailures =
    failureState.viewScope === viewScope
      ? Object.values(failureState.failures)
      : [];
  const visibleSnapshotError =
    visibleCommandFailures.length === 0 &&
    snapshotError !== undefined &&
    !trackedCommandFailures.some(({ error }) =>
      sameChatError(error, snapshotError),
    )
      ? snapshotError
      : undefined;

  return {
    dismissFailure,
    interrupt,
    sendText,
    viewResetKey: viewScope.resetKey,
    visibleCommandFailures,
    visibleSnapshotError,
  };
};
