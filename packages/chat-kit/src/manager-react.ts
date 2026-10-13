import {
  createElement,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { ChatProvider } from "@turingfocus/chat-react";
import {
  createManagerChatController,
  type ManagerChatController,
  type ManagerChatControllerOptions,
  type ManagerChatSnapshot,
} from "./manager.js";

/** Subscribes to a host-owned controller; hiding a view does not log out. */
export const useManagerChat = <Robot>(
  controller: ManagerChatController<Robot>,
): ManagerChatSnapshot =>
  useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
export interface ManagerChatProviderProps<Robot> {
  /** Stable factory. Resources are created in effects, including StrictMode replay. */
  readonly create: () => ManagerChatControllerOptions<Robot>;
  readonly robot?: Robot | undefined;
  /** Explicit platform choice; changing it releases the previous chat client. */
  readonly platformId?: number | undefined;
  readonly children?: ReactNode;
  readonly fallback?:
    ((snapshot: ManagerChatSnapshot) => ReactNode) | undefined;
  readonly onDisposeError?: ((error: unknown) => void) | undefined;
}
export function ManagerChatProvider<Robot>({
  create,
  robot,
  platformId,
  children,
  fallback,
  onDisposeError,
}: ManagerChatProviderProps<Robot>) {
  const [controller, setController] = useState<ManagerChatController<Robot>>();
  useEffect(() => {
    const owned = createManagerChatController(create());
    setController(owned);
    return () => {
      void owned.dispose().catch((error) => onDisposeError?.(error));
    };
  }, [create, onDisposeError]);
  if (!controller) return fallback?.({ status: "idle" }) ?? null;
  return createElement(ManagerChatBinding<Robot>, {
    controller,
    robot,
    platformId,
    children,
    fallback,
  });
}
function ManagerChatBinding<Robot>({
  controller,
  robot,
  platformId,
  children,
  fallback,
}: Omit<ManagerChatProviderProps<Robot>, "create"> & {
  readonly controller: ManagerChatController<Robot>;
}) {
  const snapshot = useManagerChat(controller);
  useEffect(() => {
    void controller.select(robot, { platformId });
    return () => {
      void controller.select(undefined);
    };
  }, [controller, robot, platformId]);
  return snapshot.status === "ready" && snapshot.client
    ? createElement(ChatProvider, { client: snapshot.client }, children)
    : (fallback?.(snapshot) ?? null);
}
