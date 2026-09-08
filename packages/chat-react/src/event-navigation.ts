import { useEffect, useState } from "react";

export type ChatEventNavigationMode = "manual" | "follow-latest";
export interface UseChatEventNavigationOptions {
  readonly eventIds: readonly string[];
  readonly selectedEventId: string | null;
  readonly onSelect: (id: string | null) => void;
  /** Conversation/client identity; changing it returns navigation to manual. */
  readonly scope: unknown;
}
export interface ChatEventNavigationBinding {
  readonly mode: ChatEventNavigationMode;
  readonly index: number;
  readonly count: number;
  readonly canPrevious: boolean;
  readonly canNext: boolean;
  select(index: number): void;
  pause(): void;
  followLatest(): void;
}

export function useChatEventNavigation({
  eventIds,
  selectedEventId,
  onSelect,
  scope,
}: UseChatEventNavigationOptions): ChatEventNavigationBinding {
  const [state, setState] = useState({
    scope,
    mode: "manual" as ChatEventNavigationMode,
  });
  useEffect(() => {
    setState((current) =>
      current.scope === scope ? current : { scope, mode: "manual" },
    );
  }, [scope]);
  const mode = state.scope === scope ? state.mode : "manual";
  const index =
    selectedEventId === null ? -1 : eventIds.indexOf(selectedEventId);
  const latest = eventIds.at(-1) ?? null;
  useEffect(() => {
    if (mode === "follow-latest" && selectedEventId !== latest)
      onSelect(latest);
  }, [mode, latest, selectedEventId, onSelect]);
  return {
    mode,
    index,
    count: eventIds.length,
    canPrevious: index > 0,
    canNext: eventIds.length > 0 && index < eventIds.length - 1,
    select(next) {
      const id = eventIds[Math.trunc(next)];
      if (id === undefined) return;
      setState({ scope, mode: "manual" });
      onSelect(id);
    },
    pause() {
      setState({ scope, mode: "manual" });
    },
    followLatest() {
      setState({ scope, mode: "follow-latest" });
      onSelect(latest);
    },
  };
}
