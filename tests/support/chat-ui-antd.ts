import type { ChatConversationListItem } from "../../packages/chat-ui-antd/src/index.js";

export const createConversationItems = (
  count: number,
): readonly ChatConversationListItem[] =>
  Array.from({ length: count }, (_value, index) => ({
    id: `conversation-${index + 1}`,
    title: `Conversation ${index + 1}`,
    description: `Description ${index + 1}`,
    updatedAt: Date.UTC(2026, 6, index + 1),
  }));
