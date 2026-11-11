import {
  INTERACTION_MAX_ACK_TIMEOUT_MS,
  INTERACTION_MAX_EARLY_FRAMES,
  createInteractionHelloClientPayload,
  createInteractionResponsePayload,
  interactionAckSchema,
  interactionClosedSchema,
  interactionHelloServerSchema,
  interactionPendingEnvelopeSchema,
  interactionRequestSchema,
  isSupportedInteractionProtocolVersion,
  normalizeInteractionNamespace,
  remoteToolInvocationSchema,
  type InteractionAck,
  type InteractionConnectionState,
  type InteractionPendingSnapshot,
  type InteractionRequest,
  type InteractionResponse,
  type InteractionTransport,
  type InteractionTransportAttachment,
  type InteractionTransportObserver,
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
  /**
   * Declares the legacy ask_user adapter during the dual-run window. Only
   * effective when an interaction consumer is attached; a standalone
   * RemoteToolClient never sends interaction_hello.
   */
  readonly supportsAskUserAdapter?: boolean;
}
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const interactionEventNames = {
  hello: "interaction_hello",
  pending: "interaction_pending",
  requested: "interaction_requested",
  response: "interaction_response",
  closed: "interaction_closed",
} as const;

type InteractionEventKind = "hello" | "pending" | "requested" | "closed";
interface BufferedInteractionFrame {
  readonly kind: InteractionEventKind;
  readonly payload: unknown;
}

const readInteractionId = (value: unknown): string | undefined => {
  const item = record(value);
  const interactionId = item?.["interactionId"];
  return typeof interactionId === "string" && interactionId.length > 0
    ? interactionId
    : undefined;
};

const supportedProtocolVersion = (value: unknown): boolean =>
  isSupportedInteractionProtocolVersion(record(value)?.["protocolVersion"]);

/**
 * Current Server protocol, deliberately without inferred conversation routing.
 * One namespace owner serves RemoteTool register/invoke and the interaction
 * sub-protocol. Consumers attach separately; the socket, authentication and
 * lifecycle stay single-owned.
 */
export class TFRobotRemoteToolTransport
  implements RemoteToolTransport, InteractionTransport
{
  readonly clock = {
    now: (): number => Date.now(),
    schedule: (callback: () => void, delayMs: number): (() => void) => {
      const timer = setTimeout(callback, delayMs);
      return () => clearTimeout(timer);
    },
  };
  /** Wire namespace this transport is scoped to (e.g. /remote-tool). */
  readonly namespace: string;
  readonly #options: TFRobotRemoteToolOptions;
  readonly #timeoutMs: number;
  readonly #namespaceUrl: string;
  #socket: TFRobotSocket | undefined;
  #observer: RemoteToolObserver | undefined;
  #definitions: readonly RemoteToolDefinition[] = [];
  #interactionObserver: InteractionTransportObserver | undefined;
  #disposed = false;
  #ready = false;
  #failed = false;
  #remoteToolActive = false;
  #providerId: string | undefined;
  #generation = 0;
  /** Invalidates interaction acks only on socket loss, never RemoteTool churn. */
  #interactionGeneration = 0;
  #authAttempt = 0;
  #helloSent = false;
  #interactionBuffer: BufferedInteractionFrame[] = [];
  #abort = new AbortController();
  #cancelDeadline: (() => void) | undefined;
  readonly #interactionAckTimers = new Set<() => void>();
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
    if (
      options.supportsAskUserAdapter !== undefined &&
      typeof options.supportsAskUserAdapter !== "boolean"
    )
      throw new TypeError("Invalid supportsAskUserAdapter flag");
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
    // Socket.IO namespaces never carry a trailing slash; the wire hello reports
    // the normalized path. Derive both from the same normalized value.
    this.namespace = normalizeInteractionNamespace(url.pathname);
    this.#namespaceUrl = url.toString().replace(/\/+$/u, "");
  }

  /**
   * Opens the shared connection without registering RemoteTools. The
   * interaction-only factory attaches its consumer first, then calls this.
   */
  connect(): void {
    if (this.#disposed) return;
    this.#ensureSocket();
    if (this.#disposed) return;
    if (this.#socket!.connected) {
      // An injected host socket may already be connected; no "connect" event
      // will fire, so run the same capability/lifecycle path explicitly.
      this.#handleConnect();
      return;
    }
    this.#armDeadline();
    this.#socket!.connect();
  }

  start(
    definitions: readonly RemoteToolDefinition[],
    observer: RemoteToolObserver,
  ): void {
    if (this.#observer !== undefined || this.#disposed) return;
    this.#definitions = definitions;
    this.#observer = observer;
    this.#remoteToolActive = true;
    this.#ensureSocket();
    if (this.#disposed) return;
    if (!this.#listeners.has("remote_tool_invoke")) {
      this.#listen("remote_tool_invoke", (payload, acknowledge) =>
        this.#invoke(payload, acknowledge),
      );
    }
    observer.state({ status: "connecting" });
    if (this.#disposed) return;
    this.#armDeadline();
    if (this.#socket!.connected) this.#handleConnect();
    else this.#socket!.connect();
  }

  retry(): void {
    if (this.#disposed || this.#socket === undefined) return;
    if (!this.#remoteToolActive) {
      // Interaction-only recovery after a terminal transport failure.
      this.retryInteraction();
      return;
    }
    if (this.#ready) return;
    this.#failed = false;
    ++this.#generation;
    this.#abort.abort();
    this.#abort = new AbortController();
    this.#observer?.state({ status: "connecting" });
    if (this.#disposed) return;
    this.#armDeadline();
    if (this.#socket.connected) this.#register();
    else this.#socket.connect();
  }

  /**
   * Interaction-specific forced resynchronization. Reuses the same transport
   * and namespace owner; resets hello/early-frame state and forces a fresh
   * namespace handshake so the Server resends hello → pending. An attached
   * RemoteTool consumer re-registers through the normal connect path.
   */
  retryInteraction(): void {
    if (
      this.#disposed ||
      this.#socket === undefined ||
      this.#interactionObserver === undefined
    )
      return;
    this.#failed = false;
    ++this.#generation;
    this.#abort.abort();
    this.#abort = new AbortController();
    this.#helloSent = false;
    this.#interactionBuffer = [];
    this.#cancelInteractionAcks();
    ++this.#interactionGeneration;
    if (this.#disposed) return;
    this.#armDeadline();
    if (this.#socket.connected) {
      this.#socket.disconnect();
      this.#socket.connect();
    } else {
      this.#socket.connect();
    }
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#notifyInteractionConnection("disconnected");
    this.#teardownSocket();
    this.#interactionObserver = undefined;
    this.#interactionBuffer = [];
  }

  /**
   * Detaches the RemoteTool consumer without closing a shared socket. Used by
   * the combined factory so releasing tools leaves interaction alive.
   */
  detachRemoteTool(): void {
    if (!this.#remoteToolActive) return;
    this.#remoteToolActive = false;
    this.#ready = false;
    this.#failed = false;
    this.#providerId = undefined;
    this.#definitions = [];
    ++this.#generation;
    this.#abort.abort();
    this.#abort = new AbortController();
    this.#cancelDeadline?.();
    this.#cancelDeadline = undefined;
    this.#unlisten("remote_tool_invoke");
    const socket = this.#socket;
    if (socket !== undefined) {
      try {
        if (socket.connected) socket.emit("revoke", {});
      } catch {
        /* Disconnect also revokes registrations on Server. */
      }
    }
    this.#observer = undefined;
    this.#closeIfIdle();
  }

  attachInteraction(
    observer: InteractionTransportObserver,
  ): InteractionTransportAttachment {
    if (this.#disposed) {
      return {
        respond: () => false,
        detach: () => undefined,
      };
    }
    if (this.#interactionObserver !== undefined)
      throw new TypeError("Interaction transport already has an owner");
    this.#interactionObserver = observer;
    const buffered = this.#interactionBuffer;
    this.#interactionBuffer = [];
    for (const frame of buffered) this.#deliverInteractionFrame(frame);
    if (this.#socket?.connected === true) {
      this.#emitInteractionHello();
      this.#notifyInteractionConnection("connected");
    }
    return {
      respond: (response, onAck) => this.#respondInteraction(response, onAck),
      detach: () => this.#detachInteraction(observer),
    };
  }

  #detachInteraction(observer: InteractionTransportObserver): void {
    if (this.#interactionObserver !== observer) return;
    this.#interactionObserver = undefined;
    ++this.#interactionGeneration;
    this.#cancelInteractionAcks();
    this.#interactionBuffer = [];
    this.#helloSent = false;
    this.#closeIfIdle();
  }

  #ensureSocket(): void {
    if (this.#socket !== undefined) return;
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
    this.#listen("connect", () => this.#handleConnect());
    this.#listen("connect_error", (error) => {
      if (socketAuthRejectionCode(error) !== undefined)
        this.#fail("authentication");
      else if (socket.active === false) this.#fail("transport");
      else this.#connectionLost("transport");
    });
    this.#listen("disconnect", () => this.#connectionLost());
    this.#listen("interaction_hello", (payload) =>
      this.#receiveInteractionFrame("hello", payload),
    );
    this.#listen("interaction_pending", (payload) =>
      this.#receiveInteractionFrame("pending", payload),
    );
    this.#listen("interaction_requested", (payload) =>
      this.#receiveInteractionFrame("requested", payload),
    );
    this.#listen("interaction_closed", (payload) =>
      this.#receiveInteractionFrame("closed", payload),
    );
  }

  #handleConnect(): void {
    if (this.#disposed) return;
    this.#helloSent = false;
    if (this.#remoteToolActive) this.#register();
    // Interaction-only connections have no registration ACK to settle the
    // handshake budget. A successful namespace connect proves authentication.
    else this.#cancelDeadline?.();
    if (this.#interactionObserver !== undefined) {
      this.#emitInteractionHello();
      this.#notifyInteractionConnection("connected");
    }
  }

  #listen(event: string, listener: TFRobotSocketListener): void {
    this.#listeners.set(event, listener);
    this.#socket!.on(event, listener);
  }
  #unlisten(event: string): void {
    const listener = this.#listeners.get(event);
    if (listener === undefined) return;
    this.#listeners.delete(event);
    try {
      this.#socket?.off(event, listener);
    } catch {
      /* Continue releasing other resources. */
    }
  }
  #connectionLost(error?: RemoteToolConnectionError): void {
    if (this.#disposed) return;
    this.#ready = false;
    this.#providerId = undefined;
    this.#helloSent = false;
    this.#interactionBuffer = [];
    ++this.#generation;
    ++this.#interactionGeneration;
    this.#abort.abort();
    this.#abort = new AbortController();
    this.#cancelDeadline?.();
    this.#cancelInteractionAcks();
    this.#notifyInteractionConnection("disconnected");
    // Preserve Socket.IO's own reconnection owner. Only authentication,
    // namespace rejection or registration failure requires a host retry.
    if (!this.#failed && this.#remoteToolActive)
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
    // Registration failures belong to the RemoteTool consumer only; an
    // attached interaction consumer keeps the shared socket, authentication
    // and future reconnects alive. A registration-phase timeout on an already
    // connected namespace is also RemoteTool-local: interaction frames flow.
    const remoteToolOnly =
      error === "name-conflict" ||
      error === "registration-rejected" ||
      error === "invalid-ack";
    const isolated =
      this.#interactionObserver !== undefined &&
      (remoteToolOnly ||
        (error === "timeout" && this.#socket?.connected === true));
    if (!isolated) this.#failed = true;
    this.#ready = false;
    this.#providerId = undefined;
    ++this.#generation;
    this.#abort.abort();
    this.#abort = new AbortController();
    this.#cancelDeadline?.();
    if (!isolated) {
      ++this.#interactionGeneration;
      this.#cancelInteractionAcks();
      this.#socket?.disconnect();
      this.#interactionObserver?.diagnostic?.(
        `interaction transport failed: ${error}`,
      );
    }
    if (this.#remoteToolActive)
      this.#observer?.state({ status: "error", error });
    if (this.#socket?.connected !== true)
      this.#notifyInteractionConnection("disconnected");
    if (error === "authentication") {
      const generation = this.#generation;
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
    if (this.#disposed || this.#failed || !this.#remoteToolActive) return;
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

  #emitInteractionHello(): void {
    if (
      this.#disposed ||
      this.#helloSent ||
      this.#interactionObserver === undefined ||
      this.#socket?.connected !== true
    )
      return;
    this.#helloSent = true;
    try {
      this.#socket.emit(
        interactionEventNames.hello,
        createInteractionHelloClientPayload(
          this.#options.supportsAskUserAdapter ?? false,
        ),
      );
    } catch (error) {
      this.#interactionObserver.diagnostic?.(
        "failed to emit interaction_hello",
        error,
      );
    }
  }

  #respondInteraction(
    response: InteractionResponse,
    onAck: (ack: InteractionAck | undefined) => void,
  ): boolean {
    if (
      this.#disposed ||
      this.#interactionObserver === undefined ||
      this.#socket?.connected !== true
    )
      return false;
    const payload = createInteractionResponsePayload(response);
    if (payload === undefined) {
      this.#interactionObserver.diagnostic?.(
        "interaction_response exceeds Server limits",
      );
      return false;
    }
    const interactionGeneration = this.#interactionGeneration;
    let settled = false;
    let cancel = (): void => undefined;
    const settle = (ack: InteractionAck | undefined): void => {
      if (settled) return;
      settled = true;
      cancel();
      onAck(ack);
    };
    const handle = this.clock.schedule(() => {
      this.#interactionAckTimers.delete(cancel);
      if (
        this.#disposed ||
        interactionGeneration !== this.#interactionGeneration
      )
        return;
      // Socket.IO's ack timeout is silent; the port promises a terminal
      // callback, so settle as unknown within the same budget.
      settle(undefined);
    }, INTERACTION_MAX_ACK_TIMEOUT_MS);
    cancel = (): void => {
      handle();
      this.#interactionAckTimers.delete(cancel);
    };
    this.#interactionAckTimers.add(cancel);
    try {
      this.#socket.emit(
        interactionEventNames.response,
        payload,
        withSocketAckTimeout((value) => {
          if (
            this.#disposed ||
            interactionGeneration !== this.#interactionGeneration
          )
            return;
          if (!supportedProtocolVersion(value)) {
            settle(undefined);
            return;
          }
          const parsed = interactionAckSchema.safeParse(value);
          settle(
            parsed.success &&
              parsed.data.interactionId === response.interactionId
              ? parsed.data
              : undefined,
          );
        }, INTERACTION_MAX_ACK_TIMEOUT_MS),
      );
    } catch (error) {
      cancel();
      this.#interactionObserver.diagnostic?.(
        "failed to emit interaction_response",
        error,
      );
      return false;
    }
    return true;
  }

  #receiveInteractionFrame(kind: InteractionEventKind, payload: unknown): void {
    if (this.#disposed) return;
    if (this.#interactionObserver === undefined) {
      this.#interactionBuffer.push({ kind, payload });
      while (this.#interactionBuffer.length > INTERACTION_MAX_EARLY_FRAMES) {
        // Control frames (hello/pending) are the synchronization anchors; drop
        // the oldest event frame first so a burst cannot erase the snapshot.
        const eventIndex = this.#interactionBuffer.findIndex(
          (frame) => frame.kind === "requested" || frame.kind === "closed",
        );
        if (eventIndex >= 0) this.#interactionBuffer.splice(eventIndex, 1);
        else this.#interactionBuffer.shift();
      }
      return;
    }
    this.#deliverInteractionFrame({ kind, payload });
  }

  #deliverInteractionFrame(frame: BufferedInteractionFrame): void {
    const observer = this.#interactionObserver;
    if (this.#disposed || observer === undefined) return;
    if (frame.kind === "hello") {
      if (!supportedProtocolVersion(frame.payload)) {
        observer.diagnostic?.(
          "ignored interaction_hello with unsupported protocolVersion",
        );
        return;
      }
      const parsed = interactionHelloServerSchema.safeParse(frame.payload);
      if (!parsed.success) {
        observer.diagnostic?.(
          "interaction_hello payload invalid",
          parsed.error,
        );
        return;
      }
      observer.hello(parsed.data);
      return;
    }
    if (frame.kind === "pending") {
      if (!supportedProtocolVersion(frame.payload)) {
        observer.diagnostic?.(
          "ignored interaction_pending with unsupported protocolVersion",
        );
        observer.pending({ kind: "malformed" });
        return;
      }
      const parsed = interactionPendingEnvelopeSchema.safeParse(frame.payload);
      if (!parsed.success) {
        observer.diagnostic?.(
          "interaction_pending snapshot invalid",
          parsed.error,
        );
        observer.pending({ kind: "malformed" });
        return;
      }
      const requests: InteractionRequest[] = [];
      const knownIds: string[] = [];
      for (const item of parsed.data.interactions) {
        const interactionId = readInteractionId(item);
        if (interactionId !== undefined) knownIds.push(interactionId);
        if (!supportedProtocolVersion(item)) continue;
        const request = interactionRequestSchema.safeParse(item);
        if (request.success) requests.push(request.data);
      }
      const snapshot: InteractionPendingSnapshot = {
        kind: "snapshot",
        requests,
        knownIds,
      };
      observer.pending(snapshot);
      return;
    }
    if (!supportedProtocolVersion(frame.payload)) {
      observer.diagnostic?.(
        `ignored interaction_${frame.kind} with unsupported protocolVersion`,
      );
      return;
    }
    if (frame.kind === "requested") {
      const parsed = interactionRequestSchema.safeParse(frame.payload);
      if (!parsed.success) {
        observer.diagnostic?.(
          "interaction_requested payload invalid",
          parsed.error,
        );
        return;
      }
      observer.requested(parsed.data);
      return;
    }
    const parsed = interactionClosedSchema.safeParse(frame.payload);
    if (!parsed.success) {
      observer.diagnostic?.("interaction_closed payload invalid", parsed.error);
      return;
    }
    observer.closed(parsed.data);
  }

  #notifyInteractionConnection(state: InteractionConnectionState): void {
    const observer = this.#interactionObserver;
    if (observer === undefined) return;
    try {
      observer.connection(state);
    } catch {
      /* Host observers are isolated. */
    }
  }

  #cancelInteractionAcks(): void {
    for (const cancel of [...this.#interactionAckTimers]) cancel();
    this.#interactionAckTimers.clear();
  }

  #closeIfIdle(): void {
    if (
      this.#disposed ||
      this.#interactionObserver !== undefined ||
      this.#remoteToolActive ||
      this.#socket === undefined
    )
      return;
    this.#teardownSocket();
  }

  #teardownSocket(): void {
    ++this.#generation;
    ++this.#interactionGeneration;
    this.#cancelInteractionAcks();
    this.#abort.abort();
    this.#abort = new AbortController();
    this.#cancelDeadline?.();
    this.#cancelDeadline = undefined;
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
    this.#helloSent = false;
    this.#interactionBuffer = [];
  }
}

export const createTFRobotRemoteToolTransport = (
  options: TFRobotRemoteToolOptions,
): TFRobotRemoteToolTransport => new TFRobotRemoteToolTransport(options);
