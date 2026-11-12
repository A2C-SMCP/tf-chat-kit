import { createChatClient } from "@turingfocus/chat-runtime";
import {
  createChatContractFixtures,
  createMemoryChatGateway,
} from "@turingfocus/chat-testing";
import type {
  Message,
  TimelineItem,
  ToolAgentEvent,
} from "@turingfocus/chat-protocol";

export const conversationId = "showcase-conversation";
export const deadline = () => Date.now() + 15_000;
const timestamp = Date.UTC(2026, 10, 11, 8);
export function message(
  text: string,
  role: Message["role"] = "assistant",
  id = "answer",
): Message {
  return {
    kind: "message",
    id,
    conversationId,
    role,
    content: { kind: "text", text },
    createdAt: timestamp,
  };
}
export const toolEvent: ToolAgentEvent = {
  kind: "agent-event",
  id: "tool-sum",
  conversationId,
  eventCategory: "tool",
  eventType: "tool",
  status: "success",
  createdAt: timestamp,
  transitions: [
    {
      id: "tool-start",
      status: "running",
      occurredAt: timestamp,
      toolCall: { name: "add", arguments: { a: 12, b: 30 } },
    },
    {
      id: "tool-end",
      status: "success",
      occurredAt: timestamp + 500,
      toolReturn: { result: 42, success: true },
    },
  ],
};
export const unknownEvent: TimelineItem = {
  kind: "unknown-event",
  id: "future-event",
  conversationId,
  originalType: "future.event",
  summary: "暂不支持的事件，保留安全摘要",
  createdAt: timestamp,
};
export const markdown =
  "## 本周发布计划\n\n支持 **Markdown**、[文档链接](https://github.com/A2C-SMCP/tf-chat-kit) 和代码：\n\n```ts\nconst result = 12 + 30;\n```\n\n| 项目 | 状态 |\n| --- | --- |\n| 问询 UI | 可体验 |\n| 聊天组件 | 可复用 |";
export const sampleTimeline: readonly TimelineItem[] = [
  message("请帮我整理发布计划。", "user", "question"),
  toolEvent,
  message(markdown),
  unknownEvent,
];

export async function createChatScene() {
  const fixtures = createChatContractFixtures({ conversationId });
  const memory = createMemoryChatGateway({ fixtures });
  memory.controller.setSnapshot({
    ...fixtures.initialSnapshot,
    conversation: { ...fixtures.conversation, title: "发布计划讨论" },
    timeline: sampleTimeline,
    run: null,
  });
  const client = createChatClient({ gateway: memory.gateway });
  const result = await client.loadConversation({
    conversationId,
    deadlineAt: deadline(),
  });
  if (!result.ok) {
    await client.dispose({ deadlineAt: deadline() });
    throw new Error(result.error.message);
  }
  return {
    client,
    memory,
    dispose: () =>
      client.dispose({ deadlineAt: deadline() }).then(() => undefined),
  };
}
export type ChatScene = Awaited<ReturnType<typeof createChatScene>>;
