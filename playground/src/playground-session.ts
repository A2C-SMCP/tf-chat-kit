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

export const orderConversationsByUpdatedAt = (
  conversations: readonly Conversation[],
): readonly Conversation[] =>
  conversations
    .map((conversation, index) => ({ conversation, index }))
    .sort((left, right) => {
      const leftUpdatedAt = left.conversation.updatedAt;
      const rightUpdatedAt = right.conversation.updatedAt;
      if (leftUpdatedAt === undefined && rightUpdatedAt === undefined) {
        return left.index - right.index;
      }
      if (leftUpdatedAt === undefined) return 1;
      if (rightUpdatedAt === undefined) return -1;
      return rightUpdatedAt - leftUpdatedAt || left.index - right.index;
    })
    .map(({ conversation }) => conversation);

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
  createConversation(title: string): Promise<boolean>;
  getState(): PlaygroundState;
  interrupt(): Promise<void>;
  loadConversations(): Promise<void>;
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
  status: "正在启动隔离的内存网关…",
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
    const initialTimestamp = Date.now();
    this.#controller = memory.controller;
    this.#controller.setSnapshot({
      ...memory.fixtures.initialSnapshot,
      conversation: {
        ...memory.fixtures.initialSnapshot.conversation,
        title: "示例会话",
      },
      run: null,
      timeline: [
        {
          kind: "message",
          id: "playground-welcome",
          conversationId: memory.fixtures.conversation.id,
          role: "assistant",
          content: {
            kind: "text",
            text: "欢迎使用本地 Chat Kit 调试台。",
          },
          createdAt: initialTimestamp,
          sequence: 0,
        },
        {
          kind: "agent-event",
          id: "playground-agent-event",
          conversationId: memory.fixtures.conversation.id,
          eventCategory: "generic",
          eventType: "agent.plan",
          status: "success",
          summary: "已通过正式事件组件生成执行计划。",
          createdAt: initialTimestamp + 1,
          sequence: 1,
          transitions: [
            {
              id: "playground-agent-event-running",
              status: "running",
              occurredAt: initialTimestamp + 1,
              sequence: 0,
              summary: "正在生成执行计划。",
            },
            {
              id: "playground-agent-event-success",
              status: "success",
              occurredAt: initialTimestamp + 2,
              sequence: 1,
              summary: "执行计划已生成。",
            },
          ],
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
        status: "会话列表加载失败。",
      });
      return;
    }
    this.#setState({
      conversations: orderConversationsByUpdatedAt(result.value.conversations),
      listLoading: false,
      status: `已加载 ${result.value.conversations.length} 个会话。`,
    });
  }

  async loadConversations(): Promise<void> {
    await this.refresh();
  }

  async createConversation(title: string): Promise<boolean> {
    if (this.#disposed) return false;
    const result = await this.client.createConversation({
      title,
      ...requestOptions(),
    });
    if (!result.ok) {
      this.#setState({ status: result.error.message });
      return false;
    }
    await this.refresh();
    await this.selectConversation(result.value.id);
    return true;
  }

  async selectConversation(conversationId: string): Promise<void> {
    if (this.#disposed) return;
    this.#clearTimers();
    this.#setState({
      contentState: { kind: "loading" },
      pendingConversationId: conversationId,
      status: "正在切换会话…",
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
        status: "会话加载失败。",
      });
      return;
    }
    this.#setState({
      contentState: { kind: "ready" },
      pendingConversationId: undefined,
      selectedConversationId: conversationId,
      status: `正在查看「${result.value.conversation.title}」。`,
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
        "之前发生了什么变化？",
        0,
        oldestTimestamp - 2,
      ),
      this.#message(
        snapshot.conversation.id,
        "assistant",
        "已在不轮询的情况下加载更早的一页记录。",
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
        ? "已通过 Runtime 加载确定性的历史记录。"
        : result.error.message,
    });
  }

  startStreaming(): void {
    const snapshot = this.client.getSnapshot();
    if (snapshot === null || this.#disposed) return;
    this.#beginStream(snapshot, "运行流式回复场景。", "mock-run");
  }

  async interrupt(): Promise<void> {
    const snapshot = this.client.getSnapshot();
    if (
      snapshot?.run === null ||
      snapshot?.run === undefined ||
      this.#disposed
    ) {
      this.#setState({ status: "当前没有可中断的任务。" });
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
      message: "Mock RobotServer 拒绝了当前场景。",
      retryable: true,
      conversationId,
    });
    this.#setState({ status: "已发出结构化服务端错误。" });
  }

  disconnect(): void {
    if (this.#disposed || !this.#state.connected) return;
    this.#controller.disconnect({
      code: "network",
      message: "Mock 传输连接已断开。",
      retryable: true,
      ...(this.#state.selectedConversationId === undefined
        ? {}
        : { conversationId: this.#state.selectedConversationId }),
    });
    this.#setState({
      connected: false,
      contentState: { kind: "disconnected" },
      status: "内存网关已断开。",
    });
  }

  async reconnect(): Promise<void> {
    if (this.#disposed || this.#state.connected) return;
    this.#controller.reconnect();
    this.#setState({ connected: true, status: "内存网关已重新连接。" });
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
      "正在思考…",
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
    this.#setState({ status: "正在流式输出事件驱动的 Mock 回复…" });
    this.#schedule(180, () => {
      next = this.#replaceMessage(
        next,
        assistant.id,
        "正在从内存网关流式输出…",
      );
      this.#replaceSnapshot(next);
    });
    this.#schedule(360, () => {
      next = this.#replaceMessage(
        next,
        assistant.id,
        "流式输出完成，正式 Runtime 已应用每次更新。",
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
      this.#setState({ status: "流式场景已完成。" });
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
    this.#setState({ status: "当前任务已中断。" });
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
