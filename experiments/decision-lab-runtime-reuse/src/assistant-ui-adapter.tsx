import {
  AssistantRuntimeProvider,
  useExternalStoreRuntime,
  type AssistantRuntime,
  type AppendMessage,
  type ThreadMessageLike,
} from "@assistant-ui/react";
import { useCallback, useEffect, useSyncExternalStore, type ReactNode } from "react";
import type { ReferenceChatClient, TimelineItem } from "./canonical.js";

function itemToThreadMessage(item: TimelineItem): ThreadMessageLike {
  if (item.kind === "message") {
    return {
      id: item.id,
      role: item.role,
      createdAt: new Date(item.timestamp),
      content: [{ type: "text", text: item.text }],
    };
  }

  return {
    id: item.id,
    role: "assistant",
    createdAt: new Date(item.timestamp),
    content: [
      {
        type: "text",
        text: `[${item.eventType}] ${item.summary}`,
      },
    ],
    metadata: {
      custom: {
        tfEvent: item,
      },
    },
  };
}

export function AssistantUiProbe({
  client,
  onRuntime,
  children,
}: {
  client: ReferenceChatClient;
  onRuntime: (runtime: AssistantRuntime) => void;
  children?: ReactNode;
}) {
  const subscribe = useCallback(
    (onStoreChange: () => void) => client.subscribe(onStoreChange),
    [client],
  );
  const getSnapshot = useCallback(() => client.getSnapshot(), [client]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const runtime = useExternalStoreRuntime<TimelineItem>({
    messages: snapshot.items,
    convertMessage: itemToThreadMessage,
    isRunning: snapshot.run.status === "running",
    async onNew(message: AppendMessage) {
      const text = message.content.find((part) => part.type === "text");
      if (!text || text.type !== "text") throw new Error("text input required");
      await client.sendText(text.text);
    },
    async onCancel() {
      await client.interrupt();
    },
  });

  useEffect(() => onRuntime(runtime), [onRuntime, runtime]);
  return <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>;
}

export const assistantUiExternalResponsibilities = [
  "ChatClient-to-React subscription adapter",
  "REST/socket history and live merge",
  "multi-instance authentication isolation",
  "gateway lifecycle and disposal",
] as const;
