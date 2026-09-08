import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { ChatDocumentSource } from "@turingfocus/chat-runtime";

export interface ChatDocumentSourceProviderProps {
  readonly source?: ChatDocumentSource | undefined;
  /** Replace scope on authorization changes; in-flight candidates are discarded. */
  readonly scope?: unknown;
  readonly children?: ReactNode;
}
const Context = createContext<
  Omit<ChatDocumentSourceProviderProps, "children">
>({});
export function ChatDocumentSourceProvider({
  source,
  scope,
  children,
}: ChatDocumentSourceProviderProps): ReactNode {
  const value = useMemo(() => ({ source, scope }), [source, scope]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
export const useChatDocumentSource = () => useContext(Context);
