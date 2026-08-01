import type {
  ChatGateway,
  ChatSnapshot,
  Conversation,
  InterruptRunInput,
  Message,
  SendTextInput,
} from "@turingfocus/chat-protocol";
import { createChatClient, type ChatClient } from "@turingfocus/chat-runtime";
import {
  createMemoryChatGateway,
  type MemoryGatewayController,
} from "@turingfocus/chat-testing";
import type { ChatContentState } from "@turingfocus/chat-ui-antd";

const requestOptions = () => ({ deadlineAt: Date.now() + 5_000 });

export interface PlaygroundState {
  readonly connected: boolean;
  readonly contentState: ChatContentState;
  readonly conversations: readonly Conversation[];
  readonly listError?: string | undefined;
  readonly listLoading: boolean;
  readonly pendingConversationId?: string | undefined;
  readonly selectedConversationId?: string | undefined;
  readonly status: string;
}

interface PlaygroundSessionBase {
  readonly client: ChatClient;
  readonly disposed: boolean;
  createConversation(title: string): Promise<void>;
  getState(): PlaygroundState;
  interrupt(): Promise<void>;
  loadHistory(): Promise<void>;
  reconnect(): Promise<void>;
  refresh(): Promise<void>;
  selectConversation(conversationId: string): Promise<void>;
  start(): Promise<void>;
  subscribe(listener: () => void): () => void;
  dispose(): Promise<void>;
}

export interface MockPlaygroundSession extends PlaygroundSessionBase {
  readonly kind: "mock";
  disconnect(): void;
  emitServerError(): void;
  startStreaming(): void;
}

export interface RobotServerPlaygroundSession extends PlaygroundSessionBase {
  readonly kind: "robotserver";
}

export type PlaygroundSession =
  MockPlaygroundSession | RobotServerPlaygroundSession;

type Timer = ReturnType<typeof setTimeout>;

const initialState: PlaygroundState = {
  connected: true,
  contentState: { kind: "loading" },
  conversations: [],
  listLoading: true,
  status: "Starting the isolated Memory Gateway…",
};

class MockPlaygroundSessionImpl implements MockPlaygroundSession {
  readonly client: ChatClient;
  readonly kind = "mock" as const;
  readonly #controller: MemoryGatewayController;
  #disposed = false;
  readonly #listeners = new Set<() => void>();
  #messageSequence = 0;
  #state: PlaygroundState = initialState;
  readonly #timers = new Set<Timer>();
  readonly #unsubscribeClient: () => void;

  constructor() {
    const memory = createMemoryChatGateway();
    this.#controller = memory.controller;
    this.#controller.setSnapshot({
      ...memory.fixtures.initialSnapshot,
      run: null,
      timeline: [
        {
          kind: "message",
          id: "playground-welcome",
          conversationId: memory.fixtures.conversation.id,
          role: "assistant",
          content: {
            kind: "text",
            text: "Welcome to the local Chat Kit playground.",
          },
          createdAt: Date.now(),
          sequence: 0,
        },
      ],
    });
    const gateway = this.#withScenarioEvents(memory.gateway);
    this.client = createChatClient({ gateway });
    const subscription = this.client.subscribe(() => this.#emit());
    this.#unsubscribeClient = () => subscription.dispose();
  }

  get disposed(): boolean {
    return this.#disposed;
  }

  getState = (): PlaygroundState => this.#state;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  async start(): Promise<void> {
    await this.refresh();
    const first = this.#state.conversations[0];
    if (first !== undefined) await this.selectConversation(first.id);
  }

  async refresh(): Promise<void> {
    if (this.#disposed) return;
    this.#setState({ listLoading: true, listError: undefined });
    const result = await this.client.listConversations(requestOptions());
    if (this.#disposed) return;
    if (!result.ok) {
      this.#setState({
        listError: result.error.message,
        listLoading: false,
        status: "Conversation discovery failed.",
      });
      return;
    }
    this.#setState({
      conversations: result.value.conversations,
      listLoading: false,
      status: `Loaded ${result.value.conversations.length} conversation(s).`,
    });
  }

  async createConversation(title: string): Promise<void> {
    if (this.#disposed) return;
    const result = await this.client.createConversation({
      title,
      ...requestOptions(),
    });
    if (!result.ok) {
      this.#setState({ status: result.error.message });
      return;
    }
    await this.refresh();
    await this.selectConversation(result.value.id);
  }

  async selectConversation(conversationId: string): Promise<void> {
    if (this.#disposed) return;
    this.#clearTimers();
    this.#setState({
      contentState: { kind: "loading" },
      pendingConversationId: conversationId,
      status: "Switching conversation…",
    });
    const result = await this.client.loadConversation({
      conversationId,
      ...requestOptions(),
    });
    if (this.#disposed) return;
    if (!result.ok) {
      this.#setState({
        contentState: {
          kind: result.error.code === "network" ? "disconnected" : "error",
          description: result.error.message,
        },
        pendingConversationId: undefined,
        status: "Conversation load failed.",
      });
      return;
    }
    this.#setState({
      contentState: { kind: "ready" },
      pendingConversationId: undefined,
      selectedConversationId: conversationId,
      status: `Viewing ${result.value.conversation.title}.`,
    });
  }

  async loadHistory(): Promise<void> {
    const snapshot = this.client.getSnapshot();
    if (snapshot === null || this.#disposed) return;
    const previousCursor = "playground-history-page";
    const oldestTimestamp = snapshot.timeline.reduce(
      (oldest, item) => Math.min(oldest, item.createdAt),
      Date.now(),
    );
    const older: readonly Message[] = [
      this.#message(
        snapshot.conversation.id,
        "user",
        "What changed earlier?",
        0,
        oldestTimestamp - 2,
      ),
      this.#message(
        snapshot.conversation.id,
        "assistant",
        "An older page was loaded without polling.",
        1,
        oldestTimestamp - 1,
      ),
    ];
    const canonicalBeforeHistory: ChatSnapshot = {
      ...snapshot,
      pageInfo: { hasPreviousPage: true, previousCursor },
    };
    this.#replaceSnapshot(canonicalBeforeHistory);
    this.#controller.setSnapshot({
      ...snapshot,
      timeline: older,
      pageInfo: { hasPreviousPage: false },
    });
    const result = await this.client.loadConversation({
      conversationId: snapshot.conversation.id,
      previousCursor,
      ...requestOptions(),
    });
    if (!this.#disposed) {
      this.#controller.setSnapshot(
        result.ok ? result.value : canonicalBeforeHistory,
      );
    }
    this.#setState({
      status: result.ok
        ? "Loaded a deterministic history page through the Runtime."
        : result.error.message,
    });
  }

  startStreaming(): void {
    const snapshot = this.client.getSnapshot();
    if (snapshot === null || this.#disposed) return;
    this.#beginStream(
      snapshot,
      "Run the streaming reply scenario.",
      "mock-run",
    );
  }

  async interrupt(): Promise<void> {
    const snapshot = this.client.getSnapshot();
    if (
      snapshot?.run === null ||
      snapshot?.run === undefined ||
      this.#disposed
    ) {
      this.#setState({ status: "No active run to interrupt." });
      return;
    }
    await this.client.interrupt({
      conversationId: snapshot.conversation.id,
      runId: snapshot.run.id,
      ...requestOptions(),
    });
  }

  emitServerError(): void {
    const conversationId = this.client.getSnapshot()?.conversation.id;
    if (conversationId === undefined || this.#disposed) return;
    this.#controller.emitError({
      code: "server",
      message: "Mock RobotServer rejected the active scenario.",
      retryable: true,
      conversationId,
    });
    this.#setState({ status: "Emitted a structured server error." });
  }

  disconnect(): void {
    if (this.#disposed || !this.#state.connected) return;
    this.#controller.disconnect({
      code: "network",
      message: "Mock transport disconnected.",
      retryable: true,
      ...(this.#state.selectedConversationId === undefined
        ? {}
        : { conversationId: this.#state.selectedConversationId }),
    });
    this.#setState({
      connected: false,
      contentState: { kind: "disconnected" },
      status: "Memory Gateway disconnected.",
    });
  }

  async reconnect(): Promise<void> {
    if (this.#disposed || this.#state.connected) return;
    this.#controller.reconnect();
    this.#setState({ connected: true, status: "Memory Gateway reconnected." });
    const selected = this.#state.selectedConversationId;
    if (selected !== undefined) await this.selectConversation(selected);
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#clearTimers();
    this.#unsubscribeClient();
    this.#listeners.clear();
    await this.client.dispose({ deadlineAt: Date.now() + 5_000 });
  }

  #withScenarioEvents(gateway: ChatGateway): ChatGateway {
    return {
      ...(gateway.answerInteraction === undefined
        ? {}
        : { answerInteraction: (input) => gateway.answerInteraction!(input) }),
      ...(gateway.createConversation === undefined
        ? {}
        : {
            createConversation: (input) => gateway.createConversation!(input),
          }),
      dispose: (input) => gateway.dispose(input),
      listConversations: (input) => gateway.listConversations(input),
      loadConversation: (input) => gateway.loadConversation(input),
      subscribe: (input, observer) => gateway.subscribe(input, observer),
      sendText: async (input) => {
        const result = await gateway.sendText(input);
        if (result.ok) this.#handleSend(input, result.value.runId);
        return result;
      },
      interrupt: async (input) => {
        const result = await gateway.interrupt(input);
        if (result.ok) this.#handleInterrupt(input);
        return result;
      },
    };
  }

  #handleSend(input: SendTextInput, runId: string): void {
    const snapshot = this.client.getSnapshot();
    if (snapshot?.conversation.id !== input.conversationId) return;
    this.#beginStream(snapshot, input.text, runId);
  }

  #beginStream(snapshot: ChatSnapshot, prompt: string, runId: string): void {
    this.#clearTimers();
    const now = Date.now();
    const user = this.#message(
      snapshot.conversation.id,
      "user",
      prompt,
      snapshot.timeline.length,
    );
    const assistant = this.#message(
      snapshot.conversation.id,
      "assistant",
      "Thinking…",
      snapshot.timeline.length + 1,
    );
    let next: ChatSnapshot = {
      ...snapshot,
      timeline: [...snapshot.timeline, user, assistant],
      run: {
        id: runId,
        conversationId: snapshot.conversation.id,
        status: "running",
        canInterrupt: true,
        startedAt: now,
      },
    };
    this.#replaceSnapshot(next);
    this.#setState({ status: "Streaming an event-driven mock response…" });
    this.#schedule(180, () => {
      next = this.#replaceMessage(
        next,
        assistant.id,
        "Streaming from the Memory Gateway…",
      );
      this.#replaceSnapshot(next);
    });
    this.#schedule(360, () => {
      next = this.#replaceMessage(
        next,
        assistant.id,
        "Streaming complete. The formal Runtime applied each update.",
      );
      next = {
        ...next,
        run: {
          ...next.run!,
          status: "succeeded",
          canInterrupt: false,
          finishedAt: Date.now(),
        },
      };
      this.#replaceSnapshot(next);
      this.#setState({ status: "Streaming scenario completed." });
    });
  }

  #handleInterrupt(input: InterruptRunInput): void {
    const snapshot = this.client.getSnapshot();
    if (
      snapshot?.conversation.id !== input.conversationId ||
      snapshot.run === null
    )
      return;
    this.#clearTimers();
    this.#replaceSnapshot({
      ...snapshot,
      run: {
        ...snapshot.run,
        status: "aborted",
        canInterrupt: false,
        finishedAt: Date.now(),
      },
    });
    this.#setState({ status: "Active run interrupted." });
  }

  #replaceMessage(
    snapshot: ChatSnapshot,
    id: string,
    text: string,
  ): ChatSnapshot {
    return {
      ...snapshot,
      timeline: snapshot.timeline.map((item) =>
        item.kind === "message" && item.id === id
          ? { ...item, content: { kind: "text", text }, updatedAt: Date.now() }
          : item,
      ),
    };
  }

  #message(
    conversationId: string,
    role: "assistant" | "user",
    text: string,
    sequence: number,
    createdAt = Date.now(),
  ): Message {
    this.#messageSequence += 1;
    return {
      kind: "message",
      id: `playground-message-${this.#messageSequence}`,
      conversationId,
      role,
      content: { kind: "text", text },
      createdAt,
      sequence,
    };
  }

  #replaceSnapshot(snapshot: ChatSnapshot): void {
    if (this.#disposed) return;
    this.#controller.setSnapshot(snapshot);
    this.#controller.emitUpdate({ kind: "snapshot.replace", snapshot });
  }

  #schedule(delay: number, callback: () => void): void {
    const timer = setTimeout(() => {
      this.#timers.delete(timer);
      if (!this.#disposed) callback();
    }, delay);
    this.#timers.add(timer);
  }

  #clearTimers(): void {
    for (const timer of this.#timers) clearTimeout(timer);
    this.#timers.clear();
  }

  #setState(patch: Partial<PlaygroundState>): void {
    if (this.#disposed) return;
    this.#state = { ...this.#state, ...patch };
    this.#emit();
  }

  #emit(): void {
    for (const listener of this.#listeners) listener();
  }
}

export const createMockPlaygroundSession = (): MockPlaygroundSession =>
  new MockPlaygroundSessionImpl();
