import {
  createChatClient,
  type ChatClient,
} from "../../packages/chat-runtime/src/index.js";
import {
  createMemoryChatGateway,
  type MemoryGatewayHarness,
} from "../../packages/chat-testing/src/index.js";

export const deadlineAt = (): number => Date.now() + 60_000;

export const createLoadedClient = async (
  memory = createMemoryChatGateway(),
): Promise<{ client: ChatClient; memory: MemoryGatewayHarness }> => {
  const client = createChatClient({ gateway: memory.gateway });
  const loaded = await client.loadConversation({
    conversationId: memory.fixtures.conversation.id,
    deadlineAt: deadlineAt(),
  });
  if (!loaded.ok) throw new Error(loaded.error.message);
  return { client, memory };
};

export const flushMicrotasks = async (): Promise<void> => {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
};
