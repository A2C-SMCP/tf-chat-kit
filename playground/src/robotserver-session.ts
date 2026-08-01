import type {
  ChatError,
  ChatSnapshot,
  Conversation,
} from "@turingfocus/chat-protocol";
import { createChatClient, type ChatClient } from "@turingfocus/chat-runtime";
import {
  createTFRobotChatGateway,
  type TFRobotSession,
  type TFRobotSocketFactory,
} from "@turingfocus/chat-gateway-tfrobot";

import {
  orderConversationsByUpdatedAt,
  type PlaygroundSession,
  type PlaygroundState,
  type RobotServerPlaygroundSession as RobotServerPlaygroundSessionContract,
} from "./playground-session.js";
import { parseTFRobotTarget } from "./robotserver-target.js";

const REQUEST_TIMEOUT_MS = 10_000;
const MAX_CREDENTIAL_CHARACTERS = 8_192;

export type RobotServerAuthKind = "admin" | "bearer";
export type RobotServerConnectionKind = "direct" | "standard";

export interface RobotServerConnectionTargetDraft {
  readonly allowedServerOrigins: readonly string[];
  readonly connectionKind: RobotServerConnectionKind;
  readonly creatorName: string;
  readonly creatorUid: string;
  readonly httpBaseUrl: string;
  readonly namespace: string;
  readonly platformId: string;
  readonly proxyOrigin: string;
  readonly robotId: string;
  readonly serverOrigin: string;
  readonly socketNamespaceUrl: string;
  readonly socketPath: string;
}

export interface RobotServerConnectionDraft extends RobotServerConnectionTargetDraft {
  readonly authKind: RobotServerAuthKind;
  readonly credential: string;
}

export interface RobotServerConnectionTargetConfig {
  readonly creator: {
    readonly name: string;
    readonly uid: string;
  };
  readonly httpBaseUrl: string;
  readonly platformId?: string | undefined;
  readonly socketNamespaceUrl: string;
  readonly socketPath: string;
}

export interface RobotServerConnectionConfig extends RobotServerConnectionTargetConfig {
  readonly credential: TFRobotSession;
}

export type RobotServerConnectionValidation =
  | { readonly ok: true; readonly value: RobotServerConnectionConfig }
  | { readonly ok: false; readonly message: string };

export type RobotServerTargetValidation =
  | { readonly ok: true; readonly value: RobotServerConnectionTargetConfig }
  | { readonly ok: false; readonly message: string };

export interface RobotServerSessionDependencies {
  readonly fetch?: typeof globalThis.fetch | undefined;
  readonly now?: (() => number) | undefined;
  readonly socketFactory?: TFRobotSocketFactory | undefined;
}

const parseEndpoint = (
  value: string,
  protocols: readonly string[],
): string | undefined => {
  try {
    const url = new URL(value.trim());
    if (
      !protocols.includes(url.protocol) ||
      url.username.length > 0 ||
      url.password.length > 0 ||
      url.search.length > 0 ||
      url.hash.length > 0
    ) {
      return undefined;
    }
    return url.toString().replace(/\/$/u, "");
  } catch {
    return undefined;
  }
};

export const validateRobotServerTarget = (
  draft: RobotServerConnectionTargetDraft,
): RobotServerTargetValidation => {
  let httpBaseUrl: string;
  let socketNamespaceUrl: string;
  let socketPath: string;
  if (draft.connectionKind === "standard") {
    const target = parseTFRobotTarget(
      {
        namespace: draft.namespace,
        robotId: draft.robotId,
        serverOrigin: draft.serverOrigin,
      },
      draft.proxyOrigin,
      draft.allowedServerOrigins,
    );
    if (!target.ok) return target;
    ({ httpBaseUrl, socketNamespaceUrl, socketPath } = target.value);
  } else {
    const parsedHttpBaseUrl = parseEndpoint(draft.httpBaseUrl, [
      "http:",
      "https:",
    ]);
    if (parsedHttpBaseUrl === undefined) {
      return {
        ok: false,
        message:
          "请输入不包含账号、查询参数或片段的 HTTP/HTTPS RobotServer 地址。",
      };
    }
    const parsedSocketNamespaceUrl = parseEndpoint(draft.socketNamespaceUrl, [
      "http:",
      "https:",
      "ws:",
      "wss:",
    ]);
    if (parsedSocketNamespaceUrl === undefined) {
      return {
        ok: false,
        message:
          "请输入不包含账号、查询参数或片段的有效 Socket Namespace 地址。",
      };
    }
    socketPath = draft.socketPath.trim();
    if (!socketPath.startsWith("/") || /\s/u.test(socketPath)) {
      return {
        ok: false,
        message: "Socket Path 必须以 / 开头，且不能包含空白字符。",
      };
    }
    httpBaseUrl = parsedHttpBaseUrl;
    socketNamespaceUrl = parsedSocketNamespaceUrl;
  }
  const platformId = draft.platformId.trim();
  const creatorName = draft.creatorName.trim() || "CurrentUser";
  const creatorUid = draft.creatorUid.trim() || "current-user";
  return {
    ok: true,
    value: {
      creator: { name: creatorName, uid: creatorUid },
      httpBaseUrl,
      ...(platformId.length > 0 ? { platformId } : {}),
      socketNamespaceUrl,
      socketPath,
    },
  };
};

export const createRobotServerConnectionConfig = (
  target: RobotServerConnectionTargetConfig,
  authKind: RobotServerAuthKind,
  credentialValue: string,
): RobotServerConnectionValidation => {
  const credential = credentialValue.trim();
  if (
    credential.length === 0 ||
    credential.length > MAX_CREDENTIAL_CHARACTERS
  ) {
    return {
      ok: false,
      message: "请输入不超过 8192 个字符的有效凭据。",
    };
  }
  return {
    ok: true,
    value: {
      ...target,
      credential:
        authKind === "bearer"
          ? { kind: "bearer", token: credential }
          : { kind: "admin", adminKey: credential },
    },
  };
};

export const validateRobotServerConnection = (
  draft: RobotServerConnectionDraft,
): RobotServerConnectionValidation => {
  const target = validateRobotServerTarget(draft);
  return target.ok
    ? createRobotServerConnectionConfig(
        target.value,
        draft.authKind,
        draft.credential,
      )
    : target;
};

export const robotServerTestConversationTitle = (now: number): string =>
  `[tf-chat-kit playground] ${new Date(now).toISOString().slice(0, 19)}`;

const safeErrorDescription = (error: ChatError): string => {
  switch (error.code) {
    case "authentication":
      return "RobotServer 拒绝了当前凭据（401）。";
    case "authorization":
      return "当前凭据无权访问该 RobotServer 资源（403）。";
    case "network":
      return "无法连接 RobotServer，请检查服务地址、跨域与 Socket 配置。";
    case "validation":
      return "RobotServer 返回的数据不符合 Chat Kit 协议。";
    case "timeout":
      return "RobotServer 未在本地请求期限内响应。";
    case "server":
      return "RobotServer 发生内部聊天错误。";
    default:
      return `RobotServer 操作失败（${error.code}）。`;
  }
};

const stateForError = (
  error: ChatError,
  connected: boolean,
): Pick<PlaygroundState, "connected" | "contentState" | "status"> => {
  if (error.code === "network") {
    return {
      connected: false,
      contentState: {
        kind: "disconnected",
        description: safeErrorDescription(error),
      },
      status: "RobotServer 网络或跨域连接失败。",
    };
  }
  if (error.code === "authentication" || error.code === "authorization") {
    return {
      connected: false,
      contentState: {
        kind: "error",
        description: safeErrorDescription(error),
      },
      status:
        error.code === "authentication"
          ? "RobotServer 鉴权失败。"
          : "RobotServer 授权失败。",
    };
  }
  return {
    connected,
    contentState: {
      kind: "error",
      description: safeErrorDescription(error),
    },
    status: `RobotServer 发生 ${error.code} 错误。`,
  };
};

class RobotServerPlaygroundSession implements RobotServerPlaygroundSessionContract {
  readonly client: ChatClient;
  readonly kind = "robotserver" as const;
  #disposed = false;
  #intentRevision = 0;
  #lastClientSnapshot: ChatSnapshot | null = null;
  #latestListRequest:
    | {
        readonly promise: Promise<readonly Conversation[] | undefined>;
        readonly revision: number;
      }
    | undefined;
  #listRevision = 0;
  readonly #listeners = new Set<() => void>();
  readonly #now: () => number;
  #state: PlaygroundState = {
    connected: false,
    contentState: { kind: "loading" },
    conversations: [],
    listLoading: true,
    status: "正在连接 RobotServer…",
  };
  readonly #unsubscribeClient: () => void;

  constructor(
    config: RobotServerConnectionConfig,
    dependencies: RobotServerSessionDependencies,
  ) {
    this.#now = dependencies.now ?? Date.now;
    const gateway = createTFRobotChatGateway({
      baseUrl: config.httpBaseUrl,
      fetch: dependencies.fetch,
      messageCreatorProvider: () => config.creator,
      now: this.#now,
      onDiagnostic: (error) => this.#handleDiagnostic(error),
      ...(config.platformId === undefined
        ? {}
        : { platformId: config.platformId }),
      sessionProvider: {
        getSession: () => config.credential,
      },
      socketFactory: dependencies.socketFactory,
      socketNamespaceUrl: config.socketNamespaceUrl,
      socketPath: config.socketPath,
    });
    this.client = createChatClient({ gateway });
    const subscription = this.client.subscribe(() => {
      const snapshot = this.client.getSnapshot();
      const previous = this.#lastClientSnapshot;
      this.#lastClientSnapshot = snapshot;
      const error = snapshot?.error;
      if (error !== undefined && error !== null && error !== previous?.error) {
        this.#handleError(error);
      } else if (
        snapshot !== null &&
        previous !== null &&
        snapshot !== previous &&
        (this.#state.contentState.kind === "error" ||
          this.#state.contentState.kind === "disconnected") &&
        previous.error?.code !== "authentication" &&
        previous.error?.code !== "authorization"
      ) {
        this.#setState({
          connected: true,
          contentState: { kind: "ready" },
          status: "RobotServer 已通过有效实时更新恢复连接。",
        });
      } else {
        this.#emit();
      }
    });
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
    const revision = this.#beginIntent();
    await this.#refreshAndSelect(revision);
  }

  async refresh(): Promise<void> {
    await this.#refreshAndSelect(this.#beginIntent());
  }

  async loadConversations(): Promise<void> {
    await this.#beginListRequest().promise;
  }

  async #refreshAndSelect(
    revision: number,
    preferredConversationId?: string,
  ): Promise<void> {
    if (!this.#isCurrentIntent(revision)) return;
    this.#setState({
      contentState:
        this.client.getSnapshot() === null
          ? { kind: "loading" }
          : this.#state.contentState,
      pendingConversationId: undefined,
    });
    let listRequest = this.#beginListRequest();
    let conversations = await listRequest.promise;
    while (true) {
      const latestListRequest = this.#latestListRequest;
      if (
        latestListRequest === undefined ||
        latestListRequest.revision <= listRequest.revision
      ) {
        break;
      }
      listRequest = latestListRequest;
      conversations = await listRequest.promise;
    }
    if (!this.#isCurrentIntent(revision)) return;
    const selected = this.#state.selectedConversationId;
    const target =
      conversations?.find(({ id }) => id === preferredConversationId) ??
      conversations?.find(({ id }) => id === selected) ??
      conversations?.[0];
    if (target !== undefined) {
      await this.#selectConversation(target.id, revision);
    }
  }

  async #refresh(
    revision: number,
  ): Promise<readonly Conversation[] | undefined> {
    if (!this.#isCurrentListRequest(revision)) return undefined;
    this.#setState({
      listError: undefined,
      listLoading: true,
      status: "正在查询 RobotServer 会话…",
    });
    const result = await this.client.listConversations(this.#requestOptions());
    if (this.#disposed) return undefined;
    if (!result.ok) {
      if (this.#isCurrentListRequest(revision)) {
        const errorPatch =
          this.client.getSnapshot() === null
            ? stateForError(result.error, this.#state.connected)
            : {
                connected: this.#state.connected,
                contentState: this.#state.contentState,
                status: "RobotServer 会话列表加载失败。",
              };
        this.#setState({
          ...errorPatch,
          listError: safeErrorDescription(result.error),
          listLoading: false,
        });
      }
      return undefined;
    }
    const conversations = orderConversationsByUpdatedAt(
      result.value.conversations,
    );
    if (this.#isCurrentListRequest(revision)) {
      this.#setState({
        connected: true,
        conversations,
        listError: undefined,
        listLoading: false,
        status: `连接成功，已加载 ${conversations.length} 个会话。`,
      });
    }
    return conversations;
  }

  async createConversation(): Promise<boolean> {
    const revision = this.#beginIntent();
    if (!this.#isCurrentIntent(revision)) return false;
    const title = robotServerTestConversationTitle(this.#now());
    this.#setState({ status: "正在创建保留的 Playground 测试会话…" });
    const result = await this.client.createConversation({
      title,
      ...this.#requestOptions(),
    });
    if (!this.#isCurrentIntent(revision)) return false;
    if (!result.ok) {
      this.#handleError(result.error);
      return false;
    }
    await this.#refreshAndSelect(revision, result.value.id);
    return true;
  }

  async selectConversation(conversationId: string): Promise<void> {
    await this.#selectConversation(conversationId, this.#beginIntent());
  }

  async #selectConversation(
    conversationId: string,
    revision: number,
  ): Promise<void> {
    if (!this.#isCurrentIntent(revision)) return;
    this.#setState({
      contentState: { kind: "loading" },
      pendingConversationId: conversationId,
      status: "正在加载 RobotServer 会话并建立 Socket 订阅…",
    });
    const result = await this.client.loadConversation({
      conversationId,
      ...this.#requestOptions(),
    });
    if (!this.#isCurrentIntent(revision)) return;
    if (!result.ok) {
      this.#setState({
        ...stateForError(result.error, this.#state.connected),
        pendingConversationId: undefined,
      });
      return;
    }
    this.#setState({
      connected: true,
      contentState: { kind: "ready" },
      pendingConversationId: undefined,
      selectedConversationId: conversationId,
      status: `正在查看「${result.value.conversation.title}」。`,
    });
  }

  async loadHistory(): Promise<void> {
    const revision = this.#beginIntent();
    const snapshot = this.client.getSnapshot();
    const previousCursor = snapshot?.pageInfo.previousCursor;
    if (
      !this.#isCurrentIntent(revision) ||
      snapshot === null ||
      previousCursor === undefined
    ) {
      this.#setState({
        status: "没有更早的 RobotServer 历史记录。",
      });
      return;
    }
    const result = await this.client.loadConversation({
      conversationId: snapshot.conversation.id,
      previousCursor,
      ...this.#requestOptions(),
    });
    if (!this.#isCurrentIntent(revision)) return;
    if (!result.ok) this.#handleError(result.error);
    else this.#setState({ status: "已加载更早的 RobotServer 历史记录。" });
  }

  async interrupt(): Promise<void> {
    const snapshot = this.client.getSnapshot();
    if (
      this.#disposed ||
      snapshot?.run === null ||
      snapshot?.run === undefined
    ) {
      this.#setState({ status: "当前没有可中断的 RobotServer 任务。" });
      return;
    }
    const result = await this.client.interrupt({
      conversationId: snapshot.conversation.id,
      runId: snapshot.run.id,
      ...this.#requestOptions(),
    });
    if (!result.ok) this.#handleError(result.error);
    else this.#setState({ status: "RobotServer 已接受中断请求。" });
  }

  async reconnect(): Promise<void> {
    const revision = this.#beginIntent();
    if (!this.#isCurrentIntent(revision)) return;
    await this.#refreshAndSelect(revision, this.#state.selectedConversationId);
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#intentRevision += 1;
    this.#listRevision += 1;
    this.#unsubscribeClient();
    this.#listeners.clear();
    await this.client.dispose({ deadlineAt: this.#now() + REQUEST_TIMEOUT_MS });
  }

  #handleError(error: ChatError): void {
    if (this.#disposed) return;
    this.#setState(stateForError(error, this.#state.connected));
  }

  #handleDiagnostic(error: ChatError): void {
    if (this.#disposed) return;
    this.#setState({
      status: `RobotServer 上报了已脱敏的 ${error.code} 诊断信息。`,
    });
  }

  #beginIntent(): number {
    this.#intentRevision += 1;
    return this.#intentRevision;
  }

  #beginListRequest(): {
    readonly promise: Promise<readonly Conversation[] | undefined>;
    readonly revision: number;
  } {
    this.#listRevision += 1;
    const request = {
      promise: this.#refresh(this.#listRevision),
      revision: this.#listRevision,
    };
    this.#latestListRequest = request;
    return request;
  }

  #isCurrentIntent(revision: number): boolean {
    return !this.#disposed && revision === this.#intentRevision;
  }

  #isCurrentListRequest(revision: number): boolean {
    return !this.#disposed && revision === this.#listRevision;
  }

  #requestOptions(): { readonly deadlineAt: number } {
    return { deadlineAt: this.#now() + REQUEST_TIMEOUT_MS };
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

export const createRobotServerPlaygroundSession = (
  config: RobotServerConnectionConfig,
  dependencies: RobotServerSessionDependencies = {},
): PlaygroundSession => new RobotServerPlaygroundSession(config, dependencies);
