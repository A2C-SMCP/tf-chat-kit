import { createContext } from "react";

import type { ChatClient } from "@turingfocus/chat-runtime";

export type ChatSnapshotValue = ReturnType<ChatClient["getSnapshot"]>;

export interface ChatContextValue {
  readonly client: ChatClient;
  readonly serverSnapshot: ChatSnapshotValue;
}

export const ChatContext = createContext<ChatContextValue | null>(null);
