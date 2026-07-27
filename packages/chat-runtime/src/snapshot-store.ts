import type { ChatSnapshot } from "@turingfocus/chat-protocol";

import type { SnapshotState } from "./snapshot-state.js";

export type SnapshotListener = (snapshot: ChatSnapshot) => void;

export interface SnapshotSubscription {
  readonly closed: boolean;
  dispose(): void;
}

export interface SnapshotStoreOptions {
  readonly onListenerError?: ((error: unknown) => void) | undefined;
}

interface ListenerRegistration {
  active: boolean;
  lastSnapshot: ChatSnapshot | null;
  readonly listener: SnapshotListener;
}

/** Owns immutable snapshot publication and shields listeners from reentrant writes. */
export class SnapshotStore {
  readonly #listeners = new Set<ListenerRegistration>();
  readonly #onListenerError: ((error: unknown) => void) | undefined;
  readonly #pendingCommits: SnapshotState[] = [];
  #closed = false;
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
      lastSnapshot: null,
      listener,
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

  latestState(): SnapshotState | null {
    return this.#pendingCommits.at(-1) ?? this.#state;
  }

  commit(next: SnapshotState): void {
    const latest = this.latestState();
    if (this.#closed || next === latest) return;
    this.#pendingCommits.push(next);
    if (this.#notifying) return;

    this.#notifying = true;
    try {
      while (!this.#closed && this.#pendingCommits.length > 0) {
        const state = this.#pendingCommits.shift()!;
        this.#state = state;
        for (const registration of [...this.#listeners]) {
          this.#callListener(registration, state.snapshot);
        }
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
    this.#state = null;
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
}
