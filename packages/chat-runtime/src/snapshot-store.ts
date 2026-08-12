import type { ChatSnapshot } from "@turingfocus/chat-protocol";

import type { SnapshotState } from "./snapshot-state.js";

export type SnapshotListener = (snapshot: ChatSnapshot) => void;
export type SnapshotStateListener = (snapshot: ChatSnapshot | null) => void;

export interface SnapshotSubscription {
  readonly closed: boolean;
  dispose(): void;
}

export interface SnapshotStoreOptions {
  readonly onListenerError?: ((error: unknown) => void) | undefined;
}

interface ListenerRegistration {
  active: boolean;
  readonly kind: "snapshot";
  lastSnapshot: ChatSnapshot | null;
  readonly listener: SnapshotListener;
  readonly sequence: number;
}

interface StateListenerRegistration {
  active: boolean;
  readonly kind: "state";
  lastSnapshot: ChatSnapshot | null;
  readonly listener: SnapshotStateListener;
  readonly sequence: number;
}

/** Owns immutable snapshot publication and shields listeners from reentrant writes. */
export class SnapshotStore {
  readonly #listeners = new Set<ListenerRegistration>();
  readonly #stateListeners = new Set<StateListenerRegistration>();
  readonly #onListenerError: ((error: unknown) => void) | undefined;
  readonly #pendingCommits: Array<SnapshotState | null> = [];
  #closed = false;
  #listenerSequence = 0;
  #notifying = false;
  #state: SnapshotState | null = null;

  constructor(options: SnapshotStoreOptions = {}) {
    this.#onListenerError = options.onListenerError;
  }

  get state(): SnapshotState | null {
    return this.#state;
  }

  getSnapshot(): ChatSnapshot | null {
    return this.#state?.snapshot ?? null;
  }

  subscribe(listener: SnapshotListener): SnapshotSubscription {
    const registration: ListenerRegistration = {
      active: true,
      kind: "snapshot",
      lastSnapshot: null,
      listener,
      sequence: ++this.#listenerSequence,
    };
    if (!this.#closed) {
      this.#listeners.add(registration);
      if (this.#state !== null) {
        this.#callListener(registration, this.#state.snapshot);
      }
    } else {
      registration.active = false;
    }

    return Object.freeze({
      get closed() {
        return !registration.active;
      },
      dispose: () => {
        if (!registration.active) return;
        registration.active = false;
        this.#listeners.delete(registration);
      },
    });
  }

  subscribeState(listener: SnapshotStateListener): SnapshotSubscription {
    const registration: StateListenerRegistration = {
      active: true,
      kind: "state",
      lastSnapshot: null,
      listener,
      sequence: ++this.#listenerSequence,
    };
    if (!this.#closed) {
      this.#stateListeners.add(registration);
      if (this.#state !== null) {
        this.#callStateListener(registration, this.#state.snapshot);
      }
    } else {
      registration.active = false;
    }

    return Object.freeze({
      get closed() {
        return !registration.active;
      },
      dispose: () => {
        if (!registration.active) return;
        registration.active = false;
        this.#stateListeners.delete(registration);
      },
    });
  }

  latestState(): SnapshotState | null {
    return this.#pendingCommits.length === 0
      ? this.#state
      : this.#pendingCommits.at(-1)!;
  }

  commit(next: SnapshotState): void {
    const latest = this.latestState();
    if (this.#closed || next === latest) return;
    this.#pendingCommits.push(next);
    if (this.#notifying) return;

    this.#notifying = true;
    try {
      while (!this.#closed && this.#pendingCommits.length > 0) {
        const state = this.#pendingCommits.shift() ?? null;
        this.#state = state;
        this.#publish(state);
      }
    } finally {
      this.#notifying = false;
      if (this.#closed) this.#pendingCommits.length = 0;
    }
  }

  clear(): void {
    if (this.#closed || this.latestState() === null) return;
    this.#pendingCommits.push(null);
    if (this.#notifying) return;

    this.#notifying = true;
    try {
      while (!this.#closed && this.#pendingCommits.length > 0) {
        const state = this.#pendingCommits.shift() ?? null;
        this.#state = state;
        this.#publish(state);
      }
    } finally {
      this.#notifying = false;
      if (this.#closed) this.#pendingCommits.length = 0;
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#pendingCommits.length = 0;
    for (const registration of this.#listeners) registration.active = false;
    this.#listeners.clear();
    for (const registration of this.#stateListeners) {
      registration.active = false;
    }
    this.#stateListeners.clear();
    this.#state = null;
  }

  #publish(state: SnapshotState | null): void {
    const registrations = [...this.#listeners, ...this.#stateListeners].sort(
      (left, right) => left.sequence - right.sequence,
    );
    for (const registration of registrations) {
      if (registration.kind === "snapshot") {
        if (state === null) continue;
        this.#callListener(registration, state.snapshot);
      } else {
        this.#callStateListener(registration, state?.snapshot ?? null);
      }
    }
  }

  #callListener(
    registration: ListenerRegistration,
    snapshot: ChatSnapshot,
  ): void {
    if (!registration.active || registration.lastSnapshot === snapshot) return;
    registration.lastSnapshot = snapshot;
    try {
      registration.listener(snapshot);
    } catch (error) {
      // One host listener must not prevent other subscribers from updating.
      try {
        this.#onListenerError?.(error);
      } catch {
        // A diagnostic hook must not break publication to healthy listeners.
      }
    }
  }

  #callStateListener(
    registration: StateListenerRegistration,
    snapshot: ChatSnapshot | null,
  ): void {
    if (!registration.active || registration.lastSnapshot === snapshot) return;
    registration.lastSnapshot = snapshot;
    try {
      registration.listener(snapshot);
    } catch (error) {
      try {
        this.#onListenerError?.(error);
      } catch {
        // A diagnostic hook must not break publication to healthy listeners.
      }
    }
  }
}
