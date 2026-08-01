import type { ChatError, ChatSnapshot } from "@turingfocus/chat-protocol";
import { createChatClient, type ChatClient } from "@turingfocus/chat-runtime";
import {
  createTFRobotChatGateway,
  type TFRobotSession,
  type TFRobotSocketFactory,
} from "@turingfocus/chat-gateway-tfrobot";

import type {
  PlaygroundSession,
  PlaygroundState,
  RobotServerPlaygroundSession as RobotServerPlaygroundSessionContract,
} from "./playground-session.js";

const REQUEST_TIMEOUT_MS = 10_000;
const MAX_CREDENTIAL_CHARACTERS = 8_192;

export type RobotServerAuthKind = "admin" | "bearer";

export interface RobotServerConnectionDraft {
  readonly authKind: RobotServerAuthKind;
  readonly credential: string;
  readonly creatorName: string;
  readonly creatorUid: string;
  readonly httpBaseUrl: string;
  readonly platformId: string;
  readonly socketNamespaceUrl: string;
  readonly socketPath: string;
}

export interface RobotServerConnectionConfig {
  readonly creator: {
    readonly name: string;
    readonly uid: string;
  };
  readonly credential: TFRobotSession;
  readonly httpBaseUrl: string;
  readonly platformId: string;
  readonly socketNamespaceUrl: string;
  readonly socketPath: string;
}

export type RobotServerConnectionValidation =
  | { readonly ok: true; readonly value: RobotServerConnectionConfig }
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

export const validateRobotServerConnection = (
  draft: RobotServerConnectionDraft,
): RobotServerConnectionValidation => {
  const httpBaseUrl = parseEndpoint(draft.httpBaseUrl, ["http:", "https:"]);
  if (httpBaseUrl === undefined) {
    return {
      ok: false,
      message:
        "Enter an HTTP or HTTPS RobotServer URL without credentials, query parameters or fragments.",
    };
  }
  const socketNamespaceUrl = parseEndpoint(draft.socketNamespaceUrl, [
    "http:",
    "https:",
    "ws:",
    "wss:",
  ]);
  if (socketNamespaceUrl === undefined) {
    return {
      ok: false,
      message:
        "Enter a valid Socket namespace URL without credentials, query parameters or fragments.",
    };
  }
  const socketPath = draft.socketPath.trim();
  if (!socketPath.startsWith("/") || /\s/u.test(socketPath)) {
    return {
      ok: false,
      message: "Socket path must start with / and contain no whitespace.",
    };
  }
  const platformId = draft.platformId.trim();
  const creatorName = draft.creatorName.trim();
  const creatorUid = draft.creatorUid.trim();
  if (
    platformId.length === 0 ||
    creatorName.length === 0 ||
    creatorUid.length === 0
  ) {
    return {
      ok: false,
      message: "platformId and creator ID/name are required.",
    };
  }
  const credential = draft.credential.trim();
  if (
    credential.length === 0 ||
    credential.length > MAX_CREDENTIAL_CHARACTERS
  ) {
    return {
      ok: false,
      message: "Enter a non-empty credential of at most 8192 characters.",
    };
  }
  return {
    ok: true,
    value: {
      creator: { name: creatorName, uid: creatorUid },
      credential:
        draft.authKind === "bearer"
          ? { kind: "bearer", token: credential }
          : { kind: "admin", adminKey: credential },
      httpBaseUrl,
      platformId,
      socketNamespaceUrl,
      socketPath,
    },
  };
};

export const robotServerTestConversationTitle = (now: number): string =>
  `[tf-chat-kit playground] ${new Date(now).toISOString().slice(0, 19)}`;

const safeErrorDescription = (error: ChatError): string => {
  switch (error.code) {
    case "authentication":
      return "RobotServer rejected the credential (401).";
    case "authorization":
      return "The credential cannot access this RobotServer resource (403).";
    case "network":
      return "RobotServer could not be reached. Check the URL, CORS and Socket settings.";
    case "validation":
      return "RobotServer returned data that is incompatible with the Chat Kit protocol.";
    case "timeout":
      return "RobotServer did not respond before the local request deadline.";
    case "server":
      return "RobotServer reported an internal chat failure.";
    default:
      return `RobotServer operation failed (${error.code}).`;
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
      status: "RobotServer network or CORS connection failed.",
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
          ? "RobotServer authentication failed."
          : "RobotServer authorization failed.",
    };
  }
  return {
    connected,
    contentState: {
      kind: "error",
      description: safeErrorDescription(error),
    },
    status: `RobotServer ${error.code} error.`,
  };
};

class RobotServerPlaygroundSession implements RobotServerPlaygroundSessionContract {
  readonly client: ChatClient;
  readonly kind = "robotserver" as const;
  #disposed = false;
  #intentRevision = 0;
  #lastClientSnapshot: ChatSnapshot | null = null;
  readonly #listeners = new Set<() => void>();
  readonly #now: () => number;
  #state: PlaygroundState = {
    connected: false,
    contentState: { kind: "loading" },
    conversations: [],
    listLoading: true,
    status: "Connecting to RobotServer…",
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
      platformId: config.platformId,
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
          status: "RobotServer resumed with a valid realtime update.",
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

  async #refreshAndSelect(
    revision: number,
    preferredConversationId?: string,
  ): Promise<void> {
    await this.#refresh(revision);
    if (!this.#isCurrentIntent(revision)) return;
    const selected = this.#state.selectedConversationId;
    const target =
      this.#state.conversations.find(
        ({ id }) => id === preferredConversationId,
      ) ??
      this.#state.conversations.find(({ id }) => id === selected) ??
      this.#state.conversations[0];
    if (target !== undefined) {
      await this.#selectConversation(target.id, revision);
    }
  }

  async #refresh(revision: number): Promise<void> {
    if (!this.#isCurrentIntent(revision)) return;
    this.#setState({
      contentState:
        this.client.getSnapshot() === null
          ? { kind: "loading" }
          : this.#state.contentState,
      listError: undefined,
      listLoading: true,
      pendingConversationId: undefined,
      status: "Querying RobotServer conversations…",
    });
    const result = await this.client.listConversations(this.#requestOptions());
    if (!this.#isCurrentIntent(revision)) return;
    if (!result.ok) {
      this.#setState({
        ...stateForError(result.error, this.#state.connected),
        listError: safeErrorDescription(result.error),
        listLoading: false,
      });
      return;
    }
    this.#setState({
      connected: true,
      conversations: result.value.conversations,
      listError: undefined,
      listLoading: false,
      status: `Connected; loaded ${result.value.conversations.length} conversation(s).`,
    });
  }

  async createConversation(): Promise<void> {
    const revision = this.#beginIntent();
    if (!this.#isCurrentIntent(revision)) return;
    const title = robotServerTestConversationTitle(this.#now());
    this.#setState({ status: "Creating a retained Playground test session…" });
    const result = await this.client.createConversation({
      title,
      ...this.#requestOptions(),
    });
    if (!this.#isCurrentIntent(revision)) return;
    if (!result.ok) {
      this.#handleError(result.error);
      return;
    }
    await this.#refreshAndSelect(revision, result.value.id);
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
      status: "Loading RobotServer conversation and Socket subscription…",
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
      status: `Viewing ${result.value.conversation.title}.`,
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
        status: "No earlier RobotServer history page is available.",
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
    else
      this.#setState({ status: "Loaded an earlier RobotServer history page." });
  }

  async interrupt(): Promise<void> {
    const snapshot = this.client.getSnapshot();
    if (
      this.#disposed ||
      snapshot?.run === null ||
      snapshot?.run === undefined
    ) {
      this.#setState({ status: "No active RobotServer run to interrupt." });
      return;
    }
    const result = await this.client.interrupt({
      conversationId: snapshot.conversation.id,
      runId: snapshot.run.id,
      ...this.#requestOptions(),
    });
    if (!result.ok) this.#handleError(result.error);
    else this.#setState({ status: "RobotServer interrupt request accepted." });
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
      status: `RobotServer reported a sanitized ${error.code} diagnostic.`,
    });
  }

  #beginIntent(): number {
    this.#intentRevision += 1;
    return this.#intentRevision;
  }

  #isCurrentIntent(revision: number): boolean {
    return !this.#disposed && revision === this.#intentRevision;
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
