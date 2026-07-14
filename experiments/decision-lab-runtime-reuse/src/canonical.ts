export type MessageItem = {
  readonly kind: "message";
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly timestamp: number;
};

export type AgentEventItem = {
  readonly kind: "event";
  readonly id: string;
  readonly eventType: string;
  readonly status: "running" | "completed" | "error";
  readonly summary: string;
  readonly timestamp: number;
  readonly raw?: Readonly<Record<string, unknown>>;
};

export type UnknownEventItem = {
  readonly kind: "unknown";
  readonly id: string;
  readonly eventType: string;
  readonly summary: string;
  readonly timestamp: number;
  readonly raw: Readonly<Record<string, unknown>>;
};

export type TimelineItem = MessageItem | AgentEventItem | UnknownEventItem;

export type RunState = {
  readonly id: string;
  readonly status: "idle" | "running" | "completed" | "error";
  readonly interruptible: boolean;
};

export type ChatSnapshot = {
  readonly conversationId: string;
  readonly items: readonly TimelineItem[];
  readonly run: RunState;
};

export type ChatUpdate =
  | { readonly type: "upsert"; readonly item: TimelineItem }
  | { readonly type: "run"; readonly run: RunState };

export interface ChatGateway {
  readonly sessionId: string;
  load(conversationId: string): Promise<ChatSnapshot>;
  subscribe(conversationId: string, listener: (update: ChatUpdate) => void): () => void;
  sendText(conversationId: string, text: string): Promise<void>;
  interrupt(conversationId: string, runId: string): Promise<void>;
  dispose(): void;
}

export function applyUpdate(snapshot: ChatSnapshot, update: ChatUpdate): ChatSnapshot {
  if (update.type === "run") return { ...snapshot, run: update.run };

  const index = snapshot.items.findIndex(
    (item) => item.kind === update.item.kind && item.id === update.item.id,
  );
  const items = index === -1
    ? [...snapshot.items, update.item]
    : snapshot.items.map((item, itemIndex) => (itemIndex === index ? update.item : item));

  return {
    ...snapshot,
    items: items.slice().sort((left, right) => left.timestamp - right.timestamp),
  };
}

export class ScriptedGateway implements ChatGateway {
  readonly sent: Array<{ conversationId: string; text: string }> = [];
  readonly interrupts: Array<{ conversationId: string; runId: string }> = [];
  disposed = false;
  private listener: ((update: ChatUpdate) => void) | undefined;

  constructor(
    readonly sessionId: string,
    private readonly initial: ChatSnapshot,
  ) {}

  async load(conversationId: string): Promise<ChatSnapshot> {
    if (conversationId !== this.initial.conversationId) throw new Error("unknown conversation");
    return structuredClone(this.initial);
  }

  subscribe(conversationId: string, listener: (update: ChatUpdate) => void): () => void {
    if (conversationId !== this.initial.conversationId) throw new Error("unknown conversation");
    this.listener = listener;
    return () => {
      if (this.listener === listener) this.listener = undefined;
    };
  }

  async sendText(conversationId: string, text: string): Promise<void> {
    this.sent.push({ conversationId, text });
  }

  async interrupt(conversationId: string, runId: string): Promise<void> {
    this.interrupts.push({ conversationId, runId });
  }

  emit(update: ChatUpdate): void {
    if (!this.disposed) this.listener?.(structuredClone(update));
  }

  dispose(): void {
    this.disposed = true;
    this.listener = undefined;
  }
}

export class ReferenceChatClient {
  private snapshot: ChatSnapshot | undefined;
  private unsubscribe: (() => void) | undefined;
  private readonly listeners = new Set<(snapshot: ChatSnapshot) => void>();
  private disposed = false;

  constructor(
    private readonly gateway: ChatGateway,
    private readonly conversationId: string,
  ) {}

  async start(): Promise<void> {
    this.snapshot = await this.gateway.load(this.conversationId);
    this.unsubscribe = this.gateway.subscribe(this.conversationId, (update) => {
      if (this.disposed || !this.snapshot) return;
      this.snapshot = applyUpdate(this.snapshot, update);
      for (const listener of this.listeners) listener(this.getSnapshot());
    });
  }

  getSnapshot(): ChatSnapshot {
    if (!this.snapshot) throw new Error("client not started");
    return this.snapshot;
  }

  subscribe(listener: (snapshot: ChatSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async sendText(text: string): Promise<void> {
    await this.gateway.sendText(this.conversationId, text);
  }

  async interrupt(): Promise<void> {
    const run = this.getSnapshot().run;
    if (!run.interruptible || run.status !== "running") throw new Error("run is not interruptible");
    await this.gateway.interrupt(this.conversationId, run.id);
  }

  dispose(): void {
    this.disposed = true;
    this.unsubscribe?.();
    this.listeners.clear();
    this.gateway.dispose();
  }
}
