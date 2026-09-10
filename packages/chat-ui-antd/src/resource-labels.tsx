import { createContext, useContext, useMemo, type ReactNode } from "react";
import { defaultChatResourceLabels } from "./labels.js";
import type { ChatResourceLabels, ChatUiLabelOverrides } from "./types.js";

const ResourceLabelsContext = createContext(defaultChatResourceLabels);

export function useResourceLabels(
  labels?: ChatUiLabelOverrides,
): ChatResourceLabels {
  const inherited = useContext(ResourceLabelsContext);
  // Defaults contain every resource key; host overrides are partial.
  return { ...defaultChatResourceLabels, ...inherited, ...labels?.resource };
}

export function ResourceLabelsProvider({
  labels,
  children,
}: {
  readonly labels?: ChatUiLabelOverrides | undefined;
  readonly children: ReactNode;
}): ReactNode {
  const inherited = useContext(ResourceLabelsContext);
  const value = useMemo(
    () => ({ ...inherited, ...labels?.resource }),
    [inherited, labels?.resource],
  );
  return (
    <ResourceLabelsContext.Provider value={value}>
      {children}
    </ResourceLabelsContext.Provider>
  );
}
