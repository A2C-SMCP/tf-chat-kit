import { Chat, type UIMessage } from "@ai-sdk/react";
import type { ChatTransport, UIMessageChunk } from "ai";
import {
  applyUpdate,
  type ChatGateway,
  type ChatSnapshot,
  type ChatUpdate,
  type TimelineItem,
} from "./canonical.js";

type TfDataParts = {
  tfEvent: {
    kind: "event" | "unknown";
    eventType: string;
    status?: string;
    summary: string;
    raw?: Readonly<Record<string, unknown>>;
  };
};

export type TfUiMessage = UIMessage<{ conversationId: string }, TfDataParts>;

function itemToUiMessage(conversationId: string, item: TimelineItem): TfUiMessage {
  if (item.kind === "message") {
    return {
      id: item.id,
      role: item.role,
      metadata: { conversationId },
      parts: [{ type: "text", text: item.text, state: "done" }],
    };
  }

  return {
    id: item.id,
    role: "assistant",
    metadata: { conversationId },
    parts: [
      {
        type: "data-tfEvent",
        data: {
          kind: item.kind,
          eventType: item.eventType,
          ...(item.kind === "event" ? { status: item.status } : {}),
          summary: item.summary,
          ...(item.raw ? { raw: item.raw } : {}),
        },
      },
    ],
  };
}

export function snapshotToUiMessages(snapshot: ChatSnapshot): TfUiMessage[] {
  return snapshot.items.map((item) => itemToUiMessage(snapshot.conversationId, item));
}

export class GatewayChatTransport implements ChatTransport<TfUiMessage> {
  constructor(
    private readonly gateway: ChatGateway,
    private readonly conversationId: string,
  ) {}

  async sendMessages({ messages }: Parameters<ChatTransport<TfUiMessage>["sendMessages"]>[0]) {
    const last = messages.at(-1);
    const text = last?.parts.find((part) => part.type === "text");
    if (!text || text.type !== "text") throw new Error("text input required");
    await this.gateway.sendText(this.conversationId, text.text);

    const chunks: UIMessageChunk[] = [
      { type: "start", messageId: "request-scoped-response" },
      { type: "text-start", id: "text-1" },
      { type: "text-delta", id: "text-1", delta: "accepted" },
      { type: "text-end", id: "text-1" },
      { type: "finish", finishReason: "stop" },
    ];
    return new ReadableStream<UIMessageChunk>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    });
  }

  async reconnectToStream(): Promise<ReadableStream<UIMessageChunk> | null> {
    return null;
  }
}

/**
 * This bridge is intentionally complete enough to expose the integration cost:
 * AI SDK owns request-scoped response state, while independent REST/socket updates
 * still require a canonical snapshot, merge algorithm, subscription and disposal.
 */
export class TfAiSdkBridge {
  readonly chat: Chat<TfUiMessage>;
  private snapshot: ChatSnapshot | undefined;
  private unsubscribe: (() => void) | undefined;

  constructor(
    private readonly gateway: ChatGateway,
    private readonly conversationId: string,
  ) {
    this.chat = new Chat<TfUiMessage>({
      id: conversationId,
      messages: [],
      transport: new GatewayChatTransport(gateway, conversationId),
    });
  }

  async start(): Promise<void> {
    this.snapshot = await this.gateway.load(this.conversationId);
    this.chat.messages = snapshotToUiMessages(this.snapshot);
    this.unsubscribe = this.gateway.subscribe(this.conversationId, (update) => this.applyExternalUpdate(update));
  }

  private applyExternalUpdate(update: ChatUpdate): void {
    if (!this.snapshot) throw new Error("bridge not started");
    this.snapshot = applyUpdate(this.snapshot, update);
    this.chat.messages = snapshotToUiMessages(this.snapshot);
  }

  async sendText(text: string): Promise<void> {
    await this.chat.sendMessage({ text });
  }

  dispose(): void {
    this.unsubscribe?.();
    this.gateway.dispose();
  }
}
