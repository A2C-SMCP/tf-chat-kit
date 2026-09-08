import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  useCallback,
  type ReactNode,
} from "react";
import {
  type ChatResourcePort,
  type ChatResolvedResource,
  type MessageResource,
} from "@turingfocus/chat-runtime";
import { ChatContext } from "./context.js";

interface ResourceContextValue {
  readonly port?: ChatResourcePort | undefined;
  readonly scope?: unknown;
}
const ResourceContext = createContext<ResourceContextValue>({});

export interface ChatResourceProviderProps extends ResourceContextValue {
  readonly children?: ReactNode;
}
/** Change scope when authorization changes without replacing the ChatClient. */
export function ChatResourceProvider({
  port,
  scope,
  children,
}: ChatResourceProviderProps): ReactNode {
  const value = useMemo(() => ({ port, scope }), [port, scope]);
  return (
    <ResourceContext.Provider value={value}>
      {children}
    </ResourceContext.Provider>
  );
}

export function useChatResourcePort() {
  const context = useContext(ResourceContext);
  const client = useContext(ChatContext)?.client;
  const subscribe = useCallback(
    (notify: () => void) => {
      const subscription = client?.subscribeState(notify);
      return () => subscription?.dispose();
    },
    [client],
  );
  const conversationId = useSyncExternalStore(
    subscribe,
    () => client?.getSnapshot()?.conversation.id,
    () => undefined,
  );
  return useMemo(
    () => ({ ...context, client, conversationId }),
    [context, client, conversationId],
  );
}

export interface ChatResourceBinding {
  readonly url?: string | undefined;
  readonly status: "loading" | "ready" | "unavailable";
  retry(): void;
}

export function useChatResource(
  resource: MessageResource,
): ChatResourceBinding {
  const { port, scope, client, conversationId } = useChatResourcePort();
  const [attempt, setAttempt] = useState(0);
  const { uri, name, mimeType, size } = resource;
  const key = useMemo(
    () => ({
      port,
      scope,
      client,
      conversationId,
      resource: { uri, name, mimeType, size },
      attempt,
    }),
    [port, scope, client, conversationId, uri, name, mimeType, size, attempt],
  );
  const [state, setState] = useState<{
    key: typeof key;
    url?: string;
    status: ChatResourceBinding["status"];
  }>();
  useEffect(() => {
    const controller = new AbortController();
    let resolved: ChatResolvedResource | undefined;
    const release = (value: ChatResolvedResource): void => {
      try {
        value.dispose?.();
      } catch {
        /* Host release errors must not break React cleanup. */
      }
    };
    void Promise.resolve()
      .then(() => {
        if (controller.signal.aborted) return undefined;
        if (port?.resolve !== undefined)
          return port.resolve({
            resource: key.resource,
            purpose: "display",
            conversationId,
            signal: createResourceCancellationSignal(controller.signal),
          });
        const url = getSafeChatResourceUrl(key.resource.uri);
        return url === undefined ? undefined : { url };
      })
      .then((value) => {
        if (controller.signal.aborted) {
          if (value !== undefined) release(value);
          return;
        }
        resolved = value;
        const url =
          value === undefined ? undefined : getSafeChatResourceUrl(value.url);
        setState({
          key,
          ...(url === undefined ? {} : { url }),
          status: url === undefined ? "unavailable" : "ready",
        });
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setState({ key, status: "unavailable" });
      });
    return () => {
      controller.abort();
      if (resolved !== undefined) release(resolved);
    };
  }, [key, port, conversationId]);
  const publicUrl =
    port?.resolve === undefined
      ? getSafeChatResourceUrl(resource.uri)
      : undefined;
  return {
    ...(state?.key === key
      ? { status: state.status, url: state.url }
      : publicUrl === undefined
        ? { status: "loading" as const }
        : { status: "ready" as const, url: publicUrl }),
    retry: () => setAttempt((value) => value + 1),
  };
}

/** Private schemes must be resolved by the host; executable/data URLs are never displayed. */
export const getSafeChatResourceUrl = (
  uri: string,
  options?: {
    readonly baseUrl?: string | undefined;
    readonly allowMailto?: boolean | undefined;
  },
): string | undefined => {
  try {
    const url = new URL(uri, options?.baseUrl);
    return (["http:", "https:", "blob:"].includes(url.protocol) ||
      (options?.allowMailto === true && url.protocol === "mailto:")) &&
      !url.username &&
      !url.password
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
};

export const createResourceCancellationSignal = (signal: {
  readonly aborted: boolean;
  addEventListener(
    type: "abort",
    listener: () => void,
    options: { readonly once: boolean },
  ): void;
  removeEventListener(type: "abort", listener: () => void): void;
}) => ({
  get aborted(): boolean {
    return signal.aborted;
  },
  subscribe(listener: () => void): () => void {
    if (signal.aborted) listener();
    else signal.addEventListener("abort", listener, { once: true });
    return () => signal.removeEventListener("abort", listener);
  },
});
