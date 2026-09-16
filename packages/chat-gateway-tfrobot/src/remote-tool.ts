import {
  remoteToolInvocationSchema,
  type RemoteToolConnectionError,
  type RemoteToolDefinition,
  type RemoteToolObserver,
  type RemoteToolResult,
  type RemoteToolTransport,
  type SessionProvider,
} from "@turingfocus/chat-protocol";
import { awaitBounded } from "./bounded.js";
import {
  authOf,
  createSocketIoFactory,
  socketAuthRejectionCode,
  withSocketAckTimeout,
} from "./socket.js";
import {
  isValidTFRobotSession,
  type TFRobotSession,
  type TFRobotSocket,
  type TFRobotSocketFactory,
  type TFRobotSocketListener,
} from "./types.js";

export interface TFRobotRemoteToolOptions {
  readonly baseUrl: string;
  readonly sessionProvider: SessionProvider<TFRobotSession>;
  readonly socketNamespaceUrl?: string;
  readonly socketPath?: string;
  readonly socketFactory?: TFRobotSocketFactory;
  /** Handshake/registration budget, default 10 seconds. */
  readonly connectionTimeoutMs?: number;
}
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/** Current Server protocol, deliberately without inferred conversation routing. */
export class TFRobotRemoteToolTransport implements RemoteToolTransport {
  readonly clock = {
    now: (): number => Date.now(),
    schedule: (callback: () => void, delayMs: number): (() => void) => {
      const timer = setTimeout(callback, delayMs);
      return () => clearTimeout(timer);
    },
  };
  readonly #options: TFRobotRemoteToolOptions;
  readonly #timeoutMs: number;
  readonly #namespaceUrl: string;
  #socket: TFRobotSocket | undefined;
  #observer: RemoteToolObserver | undefined;
  #definitions: readonly RemoteToolDefinition[] = [];
  #disposed = false;
  #ready = false;
  #failed = false;
  #providerId: string | undefined;
  #generation = 0;
  #authAttempt = 0;
  #abort = new AbortController();
  #cancelDeadline: (() => void) | undefined;
  readonly #listeners = new Map<string, TFRobotSocketListener>();

  constructor(options: TFRobotRemoteToolOptions) {
    this.#options = options;
    this.#timeoutMs = options.connectionTimeoutMs ?? 10_000;
    if (
      !Number.isInteger(this.#timeoutMs) ||
      this.#timeoutMs <= 0 ||
      this.#timeoutMs > 60_000
    )
      throw new TypeError("Invalid RemoteTool connection timeout");
    const url = new URL(options.socketNamespaceUrl ?? options.baseUrl);
    if (
      !["http:", "https:", "ws:", "wss:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new TypeError(
        "RemoteTool URL must not contain credentials, query or fragment",
      );
    if (options.socketNamespaceUrl === undefined) url.pathname = "/remote-tool";
    this.#namespaceUrl = url.toString().replace(/\/$/u, "");
  }

  start(
    definitions: readonly RemoteToolDefinition[],
    observer: RemoteToolObserver,
  ): void {
    if (this.#observer !== undefined || this.#disposed) return;
    this.#definitions = definitions;
    this.#observer = observer;
    const socket = (this.#options.socketFactory ?? createSocketIoFactory)({
      namespaceUrl: this.#namespaceUrl,
      path: this.#options.socketPath ?? "/socket.io",
      getAuth: async () => {
        if (this.#disposed || this.#failed)
          throw new Error("RemoteTool connection inactive");
        const generation = this.#generation;
        // Engine.IO is open here, but namespace CONNECT may still never arrive.
        // Every attempt owns a deadline covering session lookup and that handshake.
        this.#armDeadline();
        const outcome = await awaitBounded(
          () =>
            this.#options.sessionProvider.getSession({
              purpose: this.#authAttempt++ === 0 ? "connect" : "reconnect",
              operation: "remote-tool",
            }),
          {
            deadlineAt: Date.now() + this.#timeoutMs,
            now: Date.now,
            signal: this.#abort.signal,
          },
        );
        if (this.#disposed || generation !== this.#generation)
          throw new Error("RemoteTool authentication superseded");
        if (outcome.kind !== "value" || !isValidTFRobotSession(outcome.value)) {
          this.#fail(
            outcome.kind === "deadline" ? "timeout" : "authentication",
          );
          throw new Error("RemoteTool authentication unavailable");
        }
        return authOf(outcome.value);
      },
    });
    this.#socket = socket;
    this.#listen("connect", () => this.#register());
    this.#listen("connect_error", (error) => {
      if (socketAuthRejectionCode(error) !== undefined)
        this.#fail("authentication");
      else if (socket.active === false) this.#fail("transport");
      else this.#connectionLost("transport");
    });
    this.#listen("disconnect", () => this.#connectionLost());
    this.#listen("remote_tool_invoke", (payload, acknowledge) =>
      this.#invoke(payload, acknowledge),
    );
    observer.state({ status: "connecting" });
    if (this.#disposed) return;
    this.#armDeadline();
    if (socket.connected) this.#register();
    else socket.connect();
  }

  retry(): void {
    if (this.#disposed || this.#socket === undefined || this.#ready) return;
    this.#failed = false;
    ++this.#generation;
    this.#abort.abort();
    this.#abort = new AbortController();
    this.#observer?.state({ status: "connecting" });
    if (this.#disposed) return;
    this.#armDeadline();
    this.#socket.connect();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    ++this.#generation;
    this.#abort.abort();
    this.#cancelDeadline?.();
    const socket = this.#socket;
    if (socket !== undefined) {
      for (const [event, listener] of this.#listeners) {
        try {
          socket.off(event, listener);
        } catch {
          /* Continue releasing other resources. */
        }
      }
      try {
        if (socket.connected) socket.emit("revoke", {});
      } catch {
        /* Disconnect also revokes registrations on Server. */
      }
      try {
        socket.disconnect();
      } catch {
        /* Dispatch is already disabled. */
      }
    }
    this.#listeners.clear();
    this.#observer = undefined;
    this.#definitions = [];
    this.#socket = undefined;
    this.#providerId = undefined;
    this.#ready = false;
  }

  #listen(event: string, listener: TFRobotSocketListener): void {
    this.#listeners.set(event, listener);
    this.#socket!.on(event, listener);
  }
  #connectionLost(error?: RemoteToolConnectionError): void {
    if (this.#disposed || this.#failed) return;
    this.#ready = false;
    this.#providerId = undefined;
    ++this.#generation;
    this.#abort.abort();
    this.#abort = new AbortController();
    this.#cancelDeadline?.();
    // Preserve Socket.IO's own reconnection owner. Only authentication,
    // namespace rejection or registration failure requires a host retry.
    this.#observer?.state({
      status: "disconnected",
      ...(error === undefined ? {} : { error }),
    });
  }
  #armDeadline(): void {
    this.#cancelDeadline?.();
    const generation = this.#generation;
    this.#cancelDeadline = this.clock.schedule(() => {
      if (generation === this.#generation) this.#fail("timeout");
    }, this.#timeoutMs);
  }
  #fail(error: RemoteToolConnectionError): void {
    if (this.#disposed || this.#failed) return;
    this.#failed = true;
    this.#ready = false;
    this.#providerId = undefined;
    ++this.#generation;
    this.#abort.abort();
    this.#cancelDeadline?.();
    this.#socket?.disconnect();
    const generation = this.#generation;
    this.#observer?.state({ status: "error", error });
    if (error === "authentication") {
      void Promise.resolve()
        .then(() => {
          if (this.#disposed || generation !== this.#generation) return;
          return this.#options.sessionProvider.onSessionInvalid?.({
            reason: "rejected",
            error: {
              code: "authentication",
              message: "RemoteTool authentication rejected",
              retryable: true,
            },
          });
        })
        .catch(() => undefined);
    }
  }
  #register(): void {
    if (this.#disposed || this.#failed) return;
    this.#ready = false;
    const generation = ++this.#generation;
    this.#armDeadline();
    this.#observer?.state({ status: "registering" });
    if (this.#disposed) return;
    this.#socket!.emit(
      "register",
      { tools: this.#definitions },
      withSocketAckTimeout((payload) => {
        if (this.#disposed || this.#failed || generation !== this.#generation)
          return;
        const ack = record(payload);
        if (typeof ack?.["error"] === "string") {
          this.#fail(
            ack["error"].includes("name conflicts")
              ? "name-conflict"
              : "registration-rejected",
          );
          return;
        }
        const names = ack?.["registeredToolNames"];
        if (
          ack?.["error"] !== null ||
          typeof ack["providerId"] !== "string" ||
          ack["providerId"].length === 0 ||
          !Array.isArray(names) ||
          names.length !== this.#definitions.length ||
          new Set(names).size !== names.length ||
          !this.#definitions.every((tool) => names.includes(tool.toolName))
        ) {
          this.#fail("invalid-ack");
          return;
        }
        this.#cancelDeadline?.();
        this.#providerId = ack["providerId"];
        this.#ready = true;
        this.#observer?.state({ status: "ready" });
      }, this.#timeoutMs),
    );
  }
  #invoke(payload: unknown, acknowledge: unknown): void {
    if (this.#disposed || !this.#ready || typeof acknowledge !== "function")
      return;
    const dto = record(payload);
    if (dto?.["providerId"] !== this.#providerId) return;
    let invocation;
    try {
      invocation = remoteToolInvocationSchema.parse(dto);
    } catch {
      return;
    }
    const generation = this.#generation;
    let sent = false;
    const respond = (result: RemoteToolResult): void => {
      if (
        sent ||
        this.#disposed ||
        !this.#ready ||
        generation !== this.#generation
      )
        return;
      sent = true;
      acknowledge({
        requestId: invocation.requestId,
        success: result.ok,
        done: true,
        origin: result.ok ? (result.origin ?? null) : null,
        resultForLlm: result.ok ? result.resultForLlm : null,
        error: result.ok ? null : result.code,
      });
    };
    this.#observer?.invoke(invocation, respond);
  }
}

export const createTFRobotRemoteToolTransport = (
  options: TFRobotRemoteToolOptions,
): RemoteToolTransport => new TFRobotRemoteToolTransport(options);
