import { createContext } from "react";

import type { AskUserRemoteTool, ChatClient } from "@turingfocus/chat-runtime";
import type { ChatAttachmentUploader } from "./attachment-upload.js";

export type ChatSnapshotValue = ReturnType<ChatClient["getSnapshot"]>;

export interface ChatContextValue {
  readonly client: ChatClient;
  readonly askUser?: AskUserRemoteTool | undefined;
  readonly attachmentUploader?: ChatAttachmentUploader | undefined;
  readonly serverSnapshot: ChatSnapshotValue;
}

export const ChatContext = createContext<ChatContextValue | null>(null);
