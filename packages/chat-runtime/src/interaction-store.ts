import type {
  InteractionAck,
  InteractionClosed,
  InteractionOption,
  InteractionParticipant,
  InteractionPendingSnapshot,
  InteractionRequest,
  InteractionTarget,
  RemoteToolClock,
} from "@turingfocus/chat-protocol";

export const INTERACTION_QUEUE_LIMIT = 10;
export const INTERACTION_TOMBSTONE_MS = 60_000;
export const INTERACTION_TICK_INTERVAL_MS = 1_000;
export const INTERACTION_ACK_TIMEOUT_MS = 10_000;
export const INTERACTION_HELLO_FLUSH_GRACE_MS = 250;
export const INTERACTION_MAX_EARLY_FRAMES = 50;

export type InteractionStoreConnectionState =
  "connected" | "disconnected" | "awaiting-snapshot";

export type InteractionStatus =
  "pending" | "submitting" | "accepted" | "closed";

/** Local non-terminal hints; ack loss never becomes a terminal state. */
export type InteractionStaleReason = "ack_timeout" | "already_closed";

export interface InteractionEntry {
  readonly interactionId: string;
  readonly conversationId: string;
  readonly conversationTitle?: string | undefined;
  readonly robotId: string;
  readonly namespace: string;
  readonly requester: InteractionParticipant;
  readonly target: InteractionTarget;
  readonly question: string;
  readonly options: readonly InteractionOption[];
  readonly multiSelect: boolean;
  /** Display/diagnostic snapshot only; expiresAt is the authority. */
  readonly timeoutSeconds: number;
  /** Epoch milliseconds; the only countdown and EDF authority. */
  readonly expiresAt: number;
  readonly callId?: string | undefined;
  readonly eventId?: string | undefined;
  readonly receivedAt: number;
  /** Stable arrival order and EDF tie-break. */
  readonly order: number;
  readonly status: InteractionStatus;
  /** Server terminal reason or a local reconciliation reason. */
  readonly terminalReason?: string | undefined;
  readonly staleReason?: InteractionStaleReason | undefined;
  /** Increments when an uncertain response becomes answerable again. */
  readonly attempt: number;
  readonly closedAt?: number | undefined;
}

export interface InteractionStoreSnapshot {
  readonly connection: InteractionStoreConnectionState;
  readonly entries: Readonly<Record<string, InteractionEntry>>;
  readonly activeId: string | null;
  readonly now: number;
}

export interface InteractionStoreOptions {
  readonly clock: RemoteToolClock;
  readonly queueLimit?: number;
  readonly tombstoneMs?: number;
  readonly onFrameError?: (message: string) => void;
}

const limit = (
  value: number | undefined,
  fallback: number,
  maximum: number,
): number => {
  const result = value ?? fallback;
  if (!Number.isInteger(result) || result <= 0 || result > maximum)
    throw new TypeError("Invalid interaction limit");
  return result;
};

const isLive = (entry: InteractionEntry): boolean => entry.status !== "closed";

const liveCount = (entries: Map<string, InteractionEntry>): number => {
  let count = 0;
  for (const entry of entries.values()) if (isLive(entry)) ++count;
  return count;
};

const compareEdf = (
  first: InteractionEntry,
  second: InteractionEntry,
): number => first.expiresAt - second.expiresAt || first.order - second.order;

const nextOrder = (entries: Map<string, InteractionEntry>): number => {
  let maximum = 0;
  for (const entry of entries.values())
    maximum = Math.max(maximum, entry.order);
  return maximum + 1;
};

const freezeEntry = (entry: InteractionEntry): InteractionEntry =>
  Object.freeze({
    ...entry,
    requester: Object.freeze({ ...entry.requester }),
    target: Object.freeze({ ...entry.target }),
    options: Object.freeze(
      entry.options.map((option) => Object.freeze(option)),
    ),
  });

const entryFromRequest = (
  request: InteractionRequest,
  now: number,
  existing: InteractionEntry | undefined,
  order: number,
  status: InteractionStatus,
  terminalReason: string | undefined,
  staleReason: InteractionStaleReason | undefined,
): InteractionEntry =>
  freezeEntry({
    interactionId: request.interactionId,
    conversationId: request.conversationId,
    ...(request.conversationTitle === undefined
      ? {}
      : { conversationTitle: request.conversationTitle }),
    robotId: request.robotId,
    namespace: request.namespace,
    requester: request.requester,
    target: request.target,
    question: request.question,
    options: request.options ?? [],
    multiSelect: request.multiSelect,
    timeoutSeconds: request.timeoutSeconds,
    expiresAt: request.expiresAt,
    ...(request.callId === undefined ? {} : { callId: request.callId }),
    ...(request.eventId === undefined ? {} : { eventId: request.eventId }),
    receivedAt: existing?.receivedAt ?? now,
    order: existing?.order ?? order,
    status,
    ...(terminalReason === undefined ? {} : { terminalReason }),
    ...(staleReason === undefined ? {} : { staleReason }),
    attempt: existing?.attempt ?? 0,
    ...(status === "closed" ? { closedAt: existing?.closedAt ?? now } : {}),
  });

/** Instance-scoped interaction state. No module-level singleton is involved. */
export class InteractionStore {
  readonly #clock: RemoteToolClock;
  readonly #queueLimit: number;
  readonly #tombstoneMs: number;
  readonly #onFrameError: ((message: string) => void) | undefined;
  readonly #entries = new Map<string, InteractionEntry>();
  readonly #listeners = new Set<() => void>();
  #activeId: string | null = null;
  #connection: InteractionStoreConnectionState = "disconnected";
  #now: number;
  #snapshot: InteractionStoreSnapshot;
  #disposed = false;

  constructor(options: InteractionStoreOptions) {
    this.#clock = options.clock;
    this.#queueLimit = limit(options.queueLimit, INTERACTION_QUEUE_LIMIT, 100);
    this.#tombstoneMs = limit(
      options.tombstoneMs,
      INTERACTION_TOMBSTONE_MS,
      3_600_000,
    );
    this.#onFrameError = options.onFrameError;
    this.#now = this.#clock.now();
    this.#snapshot = this.#buildSnapshot();
  }

  getSnapshot = (): InteractionStoreSnapshot => this.#snapshot;

  subscribe = (listener: () => void): (() => void) => {
    if (this.#disposed) return () => undefined;
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  receiveRequested(request: InteractionRequest): void {
    if (this.#disposed) return;
    const now = this.#clock.now();
    // Expired entries may still await the next 1s tick; do not let them
    // consume the live queue budget for a new server-authoritative request.
    const expiredChanged = this.#expireEntries(now);
    const publishExpired = (): void => {
      if (!expiredChanged) return;
      this.#now = now;
      // Re-derive the active item because the previously active entry may
      // have just expired locally.
      this.#publish();
    };
    const existing = this.#entries.get(request.interactionId);
    if (existing?.status === "closed") {
      publishExpired();
      return;
    }
    if (
      existing === undefined &&
      liveCount(this.#entries) >= this.#queueLimit
    ) {
      this.#onFrameError?.(
        `interaction ${request.interactionId} exceeds queue limit ${this.#queueLimit}`,
      );
      publishExpired();
      return;
    }
    const expired = request.expiresAt <= now;
    const status: InteractionStatus = expired
      ? "closed"
      : (existing?.status ?? "pending");
    this.#entries.set(
      request.interactionId,
      entryFromRequest(
        request,
        now,
        existing,
        existing?.order ?? nextOrder(this.#entries),
        status,
        expired ? "timeout" : existing?.terminalReason,
        expired ? undefined : existing?.staleReason,
      ),
    );
    this.#now = now;
    this.#publish();
  }

  receivePending(snapshot: InteractionPendingSnapshot): void {
    if (this.#disposed) return;
    if (snapshot.kind === "malformed") {
      this.#connection = "connected";
      this.#now = this.#clock.now();
      // Fail-safe only advances connection state; it must not reorder the
      // user's explicit queue selection.
      this.#publish(true);
      return;
    }
    const now = this.#clock.now();
    const knownIds = new Set(snapshot.knownIds);
    // Reconcile removals before applying the queue limit: stale local entries
    // must not outrank the server's authoritative snapshot.
    this.#closeAbsent(knownIds, now);
    for (const request of snapshot.requests) {
      const existing = this.#entries.get(request.interactionId);
      if (existing?.status === "closed") continue;
      if (
        existing === undefined &&
        liveCount(this.#entries) >= this.#queueLimit
      ) {
        this.#onFrameError?.(
          `snapshot item ${request.interactionId} exceeds queue limit ${this.#queueLimit}`,
        );
        continue;
      }
      const expired = request.expiresAt <= now;
      // A pending snapshot is server-authoritative. An accepted item whose
      // closed frame was lost becomes answerable again; submitting keeps its
      // in-flight ack ownership.
      const status: InteractionStatus = expired
        ? "closed"
        : existing?.status === "accepted"
          ? "pending"
          : (existing?.status ?? "pending");
      this.#entries.set(
        request.interactionId,
        entryFromRequest(
          request,
          now,
          existing,
          existing?.order ?? nextOrder(this.#entries),
          status,
          expired ? "timeout" : existing?.terminalReason,
          status === "pending" ? undefined : existing?.staleReason,
        ),
      );
    }
    this.#connection = "connected";
    this.#now = now;
    this.#publish();
  }

  receiveClosed(closed: InteractionClosed): void {
    if (this.#disposed) return;
    const entry = this.#entries.get(closed.interactionId);
    if (entry === undefined || entry.status === "closed") return;
    const now = this.#clock.now();
    this.#entries.set(
      closed.interactionId,
      freezeEntry({
        ...entry,
        status: "closed",
        terminalReason: closed.terminalReason,
        staleReason: undefined,
        closedAt: now,
      }),
    );
    this.#now = now;
    this.#publish();
  }

  markSubmitting(interactionId: string): void {
    if (this.#disposed) return;
    const entry = this.#entries.get(interactionId);
    if (entry === undefined || entry.status !== "pending") return;
    this.#entries.set(
      interactionId,
      freezeEntry({ ...entry, status: "submitting" }),
    );
    // Answering an inline card must not steal the explicitly selected modal.
    this.#publish(true);
  }

  resolveAck(
    interactionId: string,
    ack: InteractionAck,
    attempt?: number,
  ): void {
    if (this.#disposed) return;
    const entry = this.#entries.get(interactionId);
    if (entry === undefined) return;
    const normal =
      entry.status === "submitting" &&
      (attempt === undefined || entry.attempt === attempt);
    // A late ack belongs to the previous attempt, which markUncertain bumped
    // by one. Applying it is safe only while the entry is still uncertain and
    // the user has not started a retry (a retry would be submitting).
    const lateUncertain =
      entry.status === "pending" &&
      entry.staleReason === "ack_timeout" &&
      attempt !== undefined &&
      entry.attempt === attempt + 1;
    if (!normal && !lateUncertain) return;
    const now = this.#clock.now();
    if (ack.status === "accepted") {
      this.#entries.set(
        interactionId,
        freezeEntry({ ...entry, status: "accepted", staleReason: undefined }),
      );
    } else {
      this.#entries.set(
        interactionId,
        freezeEntry({
          ...entry,
          status: "closed",
          terminalReason: ack.status,
          staleReason: undefined,
          closedAt: now,
        }),
      );
    }
    this.#now = now;
    this.#publish();
  }

  markUncertain(interactionId: string, attempt?: number): void {
    if (this.#disposed) return;
    const entry = this.#entries.get(interactionId);
    if (entry === undefined || entry.status !== "submitting") return;
    if (attempt !== undefined && entry.attempt !== attempt) return;
    // Ack loss is not terminal: the server's first-wins/tombstone behavior
    // lets the user retry; attempt rebuilds the local input lock.
    this.#entries.set(
      interactionId,
      freezeEntry({
        ...entry,
        status: "pending",
        staleReason: "ack_timeout",
        attempt: entry.attempt + 1,
      }),
    );
    // Keep the user's currently selected card stable across a retry.
    this.#publish(true);
  }

  activate(interactionId: string): void {
    if (this.#disposed) return;
    const entry = this.#entries.get(interactionId);
    if (
      entry === undefined ||
      !isLive(entry) ||
      this.#activeId === interactionId
    )
      return;
    this.#activeId = interactionId;
    // An explicit user selection is preserved until the next state change,
    // which then re-derives EDF unless the item is submitting or accepted.
    this.#publish(true);
  }

  setConnection(state: InteractionStoreConnectionState): void {
    if (this.#disposed || this.#connection === state) return;
    this.#connection = state;
    // Connection transitions do not change interaction ordering.
    this.#publish(true);
  }

  tick(now = this.#clock.now()): void {
    if (this.#disposed) return;
    let changed = false;
    for (const [interactionId, entry] of this.#entries) {
      if (entry.status === "closed") {
        if (
          entry.closedAt !== undefined &&
          now - entry.closedAt >= this.#tombstoneMs
        ) {
          this.#entries.delete(interactionId);
          changed = true;
        }
        continue;
      }
      if (entry.status !== "pending" && entry.status !== "accepted") continue;
      if (entry.expiresAt > now) continue;
      this.#entries.set(
        interactionId,
        freezeEntry({
          ...entry,
          status: "closed",
          // An accepted item completed even if the closed frame was lost.
          terminalReason: entry.status === "accepted" ? "answered" : "timeout",
          staleReason: undefined,
          closedAt: now,
        }),
      );
      changed = true;
    }
    if (!changed && this.#now === now) return;
    this.#now = now;
    // A no-change tick only advances the countdown clock; it must not replace
    // an explicitly activated queue item with the EDF head.
    this.#publish(!changed);
  }

  reset(): void {
    if (this.#disposed) return;
    this.#entries.clear();
    this.#activeId = null;
    this.#connection = "disconnected";
    this.#now = this.#clock.now();
    this.#publish();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#entries.clear();
    this.#activeId = null;
    this.#connection = "disconnected";
    this.#snapshot = this.#buildSnapshot();
    this.#listeners.clear();
  }

  #expireEntries(now: number): boolean {
    let changed = false;
    for (const [interactionId, entry] of this.#entries) {
      if (entry.status !== "pending" && entry.status !== "accepted") continue;
      if (entry.expiresAt > now) continue;
      this.#entries.set(
        interactionId,
        freezeEntry({
          ...entry,
          status: "closed",
          terminalReason: entry.status === "accepted" ? "answered" : "timeout",
          staleReason: undefined,
          closedAt: now,
        }),
      );
      changed = true;
    }
    return changed;
  }

  #closeAbsent(knownIds: ReadonlySet<string>, now: number): void {
    for (const [interactionId, entry] of this.#entries) {
      if (!isLive(entry) || knownIds.has(interactionId)) continue;
      this.#entries.set(
        interactionId,
        freezeEntry({
          ...entry,
          status: "closed",
          terminalReason: "not_in_snapshot",
          staleReason: undefined,
          closedAt: now,
        }),
      );
    }
  }

  #pickActiveId(): string | null {
    if (this.#activeId !== null) {
      const current = this.#entries.get(this.#activeId);
      if (
        current !== undefined &&
        (current.status === "submitting" || current.status === "accepted")
      )
        return this.#activeId;
    }
    let selected: InteractionEntry | undefined;
    for (const entry of this.#entries.values()) {
      if (!isLive(entry)) continue;
      if (selected === undefined || compareEdf(entry, selected) < 0)
        selected = entry;
    }
    return selected?.interactionId ?? null;
  }

  #publish(preserveActive = false): void {
    if (!preserveActive) this.#activeId = this.#pickActiveId();
    this.#snapshot = this.#buildSnapshot();
    for (const listener of [...this.#listeners]) {
      try {
        listener();
      } catch {
        /* Host subscribers are isolated. */
      }
    }
  }

  #buildSnapshot(): InteractionStoreSnapshot {
    const entries = Object.freeze(
      Object.fromEntries(
        [...this.#entries.entries()].map(([key, entry]) => [
          key,
          freezeEntry(entry),
        ]),
      ),
    );
    return Object.freeze({
      connection: this.#connection,
      entries,
      activeId: this.#activeId,
      now: this.#now,
    });
  }
}
