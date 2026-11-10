import {
  createInteractionResponsePayload,
  type InteractionClosed,
  type InteractionPendingSnapshot,
  type InteractionRequest,
  type InteractionResponse,
  type InteractionServerHello,
  type InteractionTransport,
  type InteractionTransportAttachment,
  type InteractionTransportObserver,
} from "@turingfocus/chat-protocol";

import {
  INTERACTION_ACK_TIMEOUT_MS,
  INTERACTION_HELLO_FLUSH_GRACE_MS,
  INTERACTION_MAX_EARLY_FRAMES,
  INTERACTION_TICK_INTERVAL_MS,
  INTERACTION_TOMBSTONE_MS,
  InteractionStore,
  type InteractionEntry,
  type InteractionStaleReason,
  type InteractionStatus,
  type InteractionStoreSnapshot,
} from "./interaction-store.js";

export interface InteractionClientOptions {
  readonly transport: InteractionTransport;
  /** Robot identity used for defensive filtering before the server hello. */
  readonly robotId: string;
  /**
   * Accept a server hello whose robotId differs from `robotId`. Defaults to
   * false: a mismatch is fail-closed (frames are dropped until a matching
   * hello arrives after reconnect). Enable only when the host intentionally
   * passes a hint rather than the authoritative identity.
   */
  readonly acceptServerIdentity?: boolean;
  /**
   * Expected wire namespace. Defaults to the transport's asserted namespace.
   * Set this explicitly when a proxy rewrites the namespace path between the
   * client URL and the Server's hello.
   */
  readonly expectedNamespace?: string;
  /** Defaults to 10 seconds. */
  readonly ackTimeoutMs?: number;
  /** Defaults to 1 second. */
  readonly tickIntervalMs?: number;
  /** Defaults to 250 milliseconds. */
  readonly helloFlushGraceMs?: number;
  /** Defaults to 50 frames. */
  readonly maxBufferedFrames?: number;
  /** Defaults to 10 live interactions. */
  readonly queueLimit?: number;
  /** Defaults to 60 seconds. */
  readonly tombstoneMs?: number;
  /**
   * Sanitized frame/terminal transport diagnostics. Terminal transport
   * failures require recreating the client or calling retry().
   */
  readonly onFrameError?: (message: string, error?: unknown) => void;
}

export interface InteractionResponseInput {
  readonly status: "answered" | "cancelled";
  /** Free text only; option answers use selectedOptions. */
  readonly answer?: string | undefined;
  /** option.value list; a single-select answer is still one element. */
  readonly selectedOptions?: readonly string[] | undefined;
}

export type InteractionClientSnapshot = InteractionStoreSnapshot;
export type { InteractionEntry, InteractionStaleReason, InteractionStatus };

type BufferedFrame =
  | { readonly kind: "requested"; readonly value: InteractionRequest }
  | { readonly kind: "closed"; readonly value: InteractionClosed };

const positiveLimit = (
  value: number | undefined,
  fallback: number,
  maximum: number,
): number => {
  const result = value ?? fallback;
  if (!Number.isInteger(result) || result <= 0 || result > maximum)
    throw new TypeError("Invalid interaction timing configuration");
  return result;
};

const nonNegativeLimit = (
  value: number | undefined,
  fallback: number,
  maximum: number,
): number => {
  const result = value ?? fallback;
  if (!Number.isInteger(result) || result < 0 || result > maximum)
    throw new TypeError("Invalid interaction grace configuration");
  return result;
};

/**
 * Instance-owned interaction consumer. It depends only on the Protocol
 * InteractionTransport port and never sees Socket.IO APIs, event names or
 * wire DTOs; the transport may supply an opaque expected namespace used for
 * defensive identity filtering. Store state is private to this instance;
 * there is no module singleton.
 */
export class InteractionClient {
  readonly #store: InteractionStore;
  readonly #transport: InteractionTransport;
  readonly #robotId: string;
  readonly #acceptServerIdentity: boolean;
  readonly #expectedNamespace: string | undefined;
  readonly #attachment: InteractionTransportAttachment;
  readonly #ackTimeoutMs: number;
  readonly #tickIntervalMs: number;
  readonly #helloFlushGraceMs: number;
  readonly #maxBufferedFrames: number;
  readonly #tombstoneMs: number;
  readonly #onFrameError:
    ((message: string, error?: unknown) => void) | undefined;
  readonly #ackTimers = new Map<
    string,
    { readonly cancel: () => void; readonly attempt: number }
  >();
  #serverHello: InteractionServerHello | undefined;
  #identityMismatch = false;
  #snapshotSeenSinceDisconnect = false;
  #bufferedFrames: BufferedFrame[] = [];
  #helloFlushTimer: (() => void) | undefined;
  #tickTimer: (() => void) | undefined;
  #disposed = false;

  constructor(options: InteractionClientOptions) {
    if (typeof options.robotId !== "string" || options.robotId.length === 0)
      throw new TypeError("InteractionClient requires a robotId");
    if (
      options.acceptServerIdentity !== undefined &&
      typeof options.acceptServerIdentity !== "boolean"
    )
      throw new TypeError("acceptServerIdentity must be a boolean");
    if (
      options.expectedNamespace !== undefined &&
      (typeof options.expectedNamespace !== "string" ||
        options.expectedNamespace.length === 0)
    )
      throw new TypeError("expectedNamespace must be a non-empty string");
    this.#transport = options.transport;
    this.#robotId = options.robotId;
    this.#acceptServerIdentity = options.acceptServerIdentity ?? false;
    this.#expectedNamespace =
      options.expectedNamespace ?? options.transport.namespace;
    this.#ackTimeoutMs = positiveLimit(
      options.ackTimeoutMs,
      INTERACTION_ACK_TIMEOUT_MS,
      600_000,
    );
    this.#tickIntervalMs = positiveLimit(
      options.tickIntervalMs,
      INTERACTION_TICK_INTERVAL_MS,
      60_000,
    );
    this.#helloFlushGraceMs = nonNegativeLimit(
      options.helloFlushGraceMs,
      INTERACTION_HELLO_FLUSH_GRACE_MS,
      60_000,
    );
    this.#maxBufferedFrames = positiveLimit(
      options.maxBufferedFrames,
      INTERACTION_MAX_EARLY_FRAMES,
      1_000,
    );
    this.#tombstoneMs = positiveLimit(
      options.tombstoneMs,
      INTERACTION_TOMBSTONE_MS,
      3_600_000,
    );
    this.#onFrameError = options.onFrameError;
    this.#store = new InteractionStore({
      clock: options.transport.clock,
      ...(options.queueLimit === undefined
        ? {}
        : { queueLimit: options.queueLimit }),
      tombstoneMs: this.#tombstoneMs,
      onFrameError: (message) => this.#report(message),
    });
    this.#attachment = options.transport.attachInteraction(
      this.#createObserver(),
    );
  }

  getSnapshot = (): InteractionClientSnapshot => this.#store.getSnapshot();

  subscribe = (listener: () => void): (() => void) =>
    this.#store.subscribe(listener);

  activate = (interactionId: string): void => {
    if (this.#disposed) return;
    this.#store.activate(interactionId);
  };

  /**
   * Explicit recovery after a terminal transport failure. Returns false when
   * the transport does not implement retry; otherwise the normal connection,
   * hello and snapshot events drive the state back.
   */
  retry(): boolean {
    if (this.#disposed || this.#transport.retry === undefined) return false;
    try {
      this.#transport.retry();
      return true;
    } catch (error) {
      this.#report("interaction transport retry failed", error);
      return false;
    }
  }

  /**
   * Answers one pending interaction. Returns false when the interaction is not
   * pending, the channel is not synchronized, or the transport rejected the
   * frame. Ack loss returns the entry to pending with an uncertain mark.
   */
  respond(interactionId: string, input: InteractionResponseInput): boolean {
    if (this.#disposed) return false;
    const snapshot = this.#store.getSnapshot();
    const entry = snapshot.entries[interactionId];
    if (
      entry === undefined ||
      entry.status !== "pending" ||
      snapshot.connection !== "connected"
    )
      return false;
    const response: InteractionResponse = {
      interactionId,
      status: input.status,
      ...(input.status === "answered" && (input.answer?.length ?? 0) > 0
        ? { answer: input.answer }
        : {}),
      ...(input.status === "answered" &&
      (input.selectedOptions?.length ?? 0) > 0
        ? { selectedOptions: [...input.selectedOptions!] }
        : {}),
    };
    // Reject locally what the Server would reject, rather than losing the
    // answer as an unknown_request terminal state.
    if (createInteractionResponsePayload(response) === undefined) {
      this.#report("interaction_response exceeds Server limits");
      return false;
    }
    const attempt = entry.attempt;
    const previous = this.#ackTimers.get(interactionId);
    if (previous !== undefined) {
      previous.cancel();
      this.#ackTimers.delete(interactionId);
    }
    this.#store.markSubmitting(interactionId);
    const cancel = this.#transport.clock.schedule(() => {
      const current = this.#ackTimers.get(interactionId);
      if (current?.cancel !== cancel) return;
      this.#ackTimers.delete(interactionId);
      if (!this.#disposed) this.#store.markUncertain(interactionId, attempt);
    }, this.#ackTimeoutMs);
    this.#ackTimers.set(interactionId, { cancel, attempt });
    let sent = false;
    try {
      sent = this.#attachment.respond(response, (ack) => {
        if (this.#disposed) return;
        const current = this.#ackTimers.get(interactionId);
        if (current?.cancel === cancel) {
          current.cancel();
          this.#ackTimers.delete(interactionId);
          if (ack === undefined)
            this.#store.markUncertain(interactionId, attempt);
          else this.#store.resolveAck(interactionId, ack, attempt);
        } else if (ack !== undefined) {
          // Late ack from an earlier attempt: the store applies it only when
          // that same uncertain attempt is still current.
          this.#store.resolveAck(interactionId, ack, attempt);
        }
        this.#tickAndRefresh();
      });
    } catch (error) {
      this.#report("failed to send interaction_response", error);
      sent = false;
    }
    if (!sent) {
      cancel();
      this.#ackTimers.delete(interactionId);
      this.#store.markUncertain(interactionId, attempt);
      return false;
    }
    this.#tickAndRefresh();
    return true;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const { cancel } of this.#ackTimers.values()) cancel();
    this.#ackTimers.clear();
    this.#helloFlushTimer?.();
    this.#helloFlushTimer = undefined;
    this.#tickTimer?.();
    this.#tickTimer = undefined;
    this.#bufferedFrames = [];
    this.#attachment.detach();
    this.#store.dispose();
  }

  #createObserver(): InteractionTransportObserver {
    return {
      hello: (hello) => this.#handleHello(hello),
      pending: (snapshot) => this.#handlePending(snapshot),
      requested: (request) => this.#handleRequested(request),
      closed: (closed) => this.#handleClosed(closed),
      connection: (state) => this.#handleConnection(state),
      diagnostic: (message, error) => this.#report(message, error),
    };
  }

  #handleHello(hello: InteractionServerHello): void {
    if (this.#disposed) return;
    const foreignNamespace =
      this.#expectedNamespace !== undefined &&
      hello.namespace !== this.#expectedNamespace;
    const foreignRobot =
      !this.#acceptServerIdentity && hello.robotId !== this.#robotId;
    if (foreignNamespace || foreignRobot) {
      // Fail closed: never adopt an identity the host did not expect. Drop the
      // buffered frames because they belong to the rejected channel.
      this.#identityMismatch = true;
      this.#serverHello = undefined;
      this.#snapshotSeenSinceDisconnect = false;
      this.#bufferedFrames = [];
      this.#clearHelloTimer();
      this.#store.setConnection("disconnected");
      this.#report(
        `reject interaction_hello ${hello.robotId}/${hello.namespace}`,
      );
      return;
    }
    this.#identityMismatch = false;
    this.#serverHello = hello;
    if (
      this.#snapshotSeenSinceDisconnect ||
      this.#helloFlushTimer !== undefined
    )
      return;
    // The contract is hello → pending, but a lost snapshot must not strand the
    // early-frame buffer. After the grace window, accept the connection and
    // leave locally known interactions intact.
    this.#helloFlushTimer = this.#transport.clock.schedule(() => {
      this.#helloFlushTimer = undefined;
      if (this.#disposed || this.#snapshotSeenSinceDisconnect) return;
      this.#snapshotSeenSinceDisconnect = true;
      this.#store.setConnection("connected");
      this.#flushBufferedFrames();
      this.#tickAndRefresh();
    }, this.#helloFlushGraceMs);
  }

  #handlePending(snapshot: InteractionPendingSnapshot): void {
    if (this.#disposed || this.#identityMismatch) return;
    this.#snapshotSeenSinceDisconnect = true;
    this.#clearHelloTimer();
    if (snapshot.kind === "malformed") {
      // Fail-safe: a malformed snapshot still proves the channel is usable;
      // keep locally known interactions rather than closing them.
      this.#store.receivePending(snapshot);
      this.#flushBufferedFrames();
      this.#tickAndRefresh();
      return;
    }
    const foreignIds = new Set<string>();
    const requests = snapshot.requests.filter((request) => {
      if (this.#matchesIdentity(request)) return true;
      foreignIds.add(request.interactionId);
      this.#report(
        `drop foreign interaction ${request.interactionId} ${request.robotId}/${request.namespace}`,
      );
      return false;
    });
    this.#store.receivePending({
      kind: "snapshot",
      requests,
      knownIds: snapshot.knownIds.filter(
        (interactionId) => !foreignIds.has(interactionId),
      ),
    });
    this.#flushBufferedFrames();
    this.#tickAndRefresh();
  }

  #handleRequested(request: InteractionRequest): void {
    if (this.#disposed || this.#identityMismatch) return;
    if (!this.#snapshotSeenSinceDisconnect) {
      this.#bufferFrame({ kind: "requested", value: request });
      return;
    }
    if (!this.#matchesIdentity(request)) {
      this.#report(
        `drop foreign interaction_requested ${request.interactionId} ${request.robotId}/${request.namespace}`,
      );
      return;
    }
    this.#store.receiveRequested(request);
    this.#tickAndRefresh();
  }

  #handleClosed(closed: InteractionClosed): void {
    if (this.#disposed || this.#identityMismatch) return;
    if (!this.#snapshotSeenSinceDisconnect) {
      this.#bufferFrame({ kind: "closed", value: closed });
      return;
    }
    this.#store.receiveClosed(closed);
    this.#tickAndRefresh();
  }

  #handleConnection(state: "connected" | "disconnected"): void {
    if (this.#disposed) return;
    if (state === "connected") {
      this.#store.setConnection(
        this.#identityMismatch
          ? "disconnected"
          : this.#snapshotSeenSinceDisconnect
            ? "connected"
            : "awaiting-snapshot",
      );
      this.#tickAndRefresh();
      return;
    }
    this.#identityMismatch = false;
    this.#serverHello = undefined;
    this.#snapshotSeenSinceDisconnect = false;
    this.#bufferedFrames = [];
    this.#clearHelloTimer();
    for (const [interactionId, { cancel, attempt }] of this.#ackTimers) {
      cancel();
      this.#ackTimers.delete(interactionId);
      this.#store.markUncertain(interactionId, attempt);
    }
    this.#store.setConnection("disconnected");
    this.#tickAndRefresh();
  }

  #flushBufferedFrames(): void {
    const buffered = this.#bufferedFrames;
    this.#bufferedFrames = [];
    for (const frame of buffered) {
      if (frame.kind === "requested") this.#handleRequested(frame.value);
      else this.#handleClosed(frame.value);
    }
  }

  #bufferFrame(frame: BufferedFrame): void {
    this.#bufferedFrames.push(frame);
    if (this.#bufferedFrames.length > this.#maxBufferedFrames) {
      this.#bufferedFrames.shift();
      this.#report(
        "interaction early-frame buffer overflow; oldest frame dropped",
      );
    }
  }

  #matchesIdentity(request: InteractionRequest): boolean {
    if (this.#identityMismatch) return false;
    if (this.#serverHello !== undefined)
      return (
        request.robotId === this.#serverHello.robotId &&
        request.namespace === this.#serverHello.namespace
      );
    return (
      request.robotId === this.#robotId &&
      (this.#expectedNamespace === undefined ||
        request.namespace === this.#expectedNamespace)
    );
  }

  #tickAndRefresh(): void {
    if (this.#disposed) return;
    this.#store.tick(this.#transport.clock.now());
    this.#refreshTicker();
  }

  #needsTick(): boolean {
    const now = this.#transport.clock.now();
    return Object.values(this.#store.getSnapshot().entries).some((entry) => {
      if (entry.status !== "closed") return true;
      if (entry.closedAt === undefined) return true;
      // Keep a timer until the tombstone window closes so closed entries are
      // reaped even when no live interaction remains.
      return now - entry.closedAt < this.#tombstoneMs;
    });
  }

  #refreshTicker(): void {
    if (this.#disposed) return;
    if (!this.#needsTick()) {
      this.#tickTimer?.();
      this.#tickTimer = undefined;
      return;
    }
    if (this.#tickTimer !== undefined) return;
    this.#tickTimer = this.#transport.clock.schedule(() => {
      this.#tickTimer = undefined;
      if (this.#disposed) return;
      this.#store.tick(this.#transport.clock.now());
      this.#refreshTicker();
    }, this.#tickIntervalMs);
  }

  #clearHelloTimer(): void {
    this.#helloFlushTimer?.();
    this.#helloFlushTimer = undefined;
  }

  #report(message: string, error?: unknown): void {
    try {
      this.#onFrameError?.(message, error);
    } catch {
      /* Host diagnostics are isolated. */
    }
  }
}

export const createInteractionClient = (
  options: InteractionClientOptions,
): InteractionClient => new InteractionClient(options);
