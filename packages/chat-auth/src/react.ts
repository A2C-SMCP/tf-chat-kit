import {
  createContext,
  createElement,
  useContext,
  useCallback,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { AuthClient, AuthSnapshot } from "./headless.js";

export interface AuthProviderProps {
  readonly client: AuthClient;
  readonly children?: ReactNode;
}

export type AuthSelector<T> = (snapshot: AuthSnapshot) => T;

const AuthContext = createContext<AuthClient | null>(null);

export const AuthProvider = ({ client, children }: AuthProviderProps) =>
  createElement(AuthContext.Provider, { value: client }, children);

export const useAuth = (): AuthClient => {
  const client = useContext(AuthContext);
  if (client === null)
    throw new Error("useAuth must be used inside AuthProvider");
  return client;
};

export const useAuthSelector = <T>(selector: AuthSelector<T>): T => {
  const client = useAuth();
  const subscribe = useCallback(
    (listener: () => void) => client.subscribe(listener),
    [client],
  );
  const getSnapshot = useCallback(() => client.getSnapshot(), [client]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return selector(snapshot);
};
