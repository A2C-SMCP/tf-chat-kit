import type {
  TFRobotSocket,
  TFRobotSocketAnyListener,
  TFRobotSocketAuth,
  TFRobotSocketFactory,
  TFRobotSocketFactoryInput,
  TFRobotSocketListener,
} from "./types.js";

const sameAuth = (a: TFRobotSocketAuth, b: TFRobotSocketAuth): boolean =>
  a.token === b.token && a.admin_key === b.admin_key;

/** A subscription owns listeners and joins, while the Gateway owns transport. */
export interface SocketLease extends TFRobotSocket {
  readonly reused: boolean;
  readonly requiresConversationId: boolean;
  release(): void;
  invalidate(): void;
}

interface LeaseState {
  readonly getAuth: TFRobotSocketFactoryInput["getAuth"];
  readonly listeners: Map<string, Set<TFRobotSocketListener>>;
  readonly anyListeners: Set<TFRobotSocketAnyListener>;
  released: boolean;
}

class Connection {
  readonly #socket: TFRobotSocket;
  readonly #leases = new Set<LeaseState>();
  readonly #listeners = new Map<string, TFRobotSocketListener>();
  readonly #onClose: (connection: Connection) => void;
  readonly #canRetainIdle: (connection: Connection) => boolean;
  readonly #firstConversation: string;
  #auth: TFRobotSocketAuth;
  #closed = false;
  #connecting = false;
  #anyAttached = false;
  #multipleConversations = false;
  readonly #anyListener: TFRobotSocketAnyListener = (event, ...args) => {
    for (const lease of [...this.#leases]) {
      if (!lease.released)
        for (const listener of lease.anyListeners) listener(event, ...args);
    }
  };

  constructor(
    factory: TFRobotSocketFactory,
    input: TFRobotSocketFactoryInput,
    auth: TFRobotSocketAuth,
    conversationId: string,
    onClose: (connection: Connection) => void,
    canRetainIdle: (connection: Connection) => boolean,
  ) {
    this.#auth = auth;
    this.#firstConversation = conversationId;
    this.#onClose = onClose;
    this.#canRetainIdle = canRetainIdle;
    this.#socket = factory({ ...input, getAuth: () => this.#getAuth() });
    try {
      this.#listen("disconnect");
      this.#listen("connect");
      this.#listen("connect_error");
    } catch (error) {
      this.close();
      throw error;
    }
  }

  matches(auth: TFRobotSocketAuth): boolean {
    return !this.#closed && sameAuth(this.#auth, auth);
  }

  get healthy(): boolean {
    return !this.#closed && this.#socket.connected;
  }

  acquire(
    input: TFRobotSocketFactoryInput,
    conversationId: string,
    reused: boolean,
  ): SocketLease {
    if (conversationId !== this.#firstConversation)
      this.#multipleConversations = true;
    const state: LeaseState = {
      getAuth: input.getAuth,
      listeners: new Map(),
      anyListeners: new Set(),
      released: false,
    };
    this.#leases.add(state);
    const isConnected = () => !state.released && this.healthy;
    const requiresConversationId = () => this.#multipleConversations;
    const release = (): void => {
      state.released = true;
      state.listeners.clear();
      state.anyListeners.clear();
      this.#leases.delete(state);
      this.#pruneListeners();
      // Keep one healthy idle connection for a cache-first handoff. An idle
      // disconnected transport must not refresh credentials or reconnect.
      if (
        this.#leases.size === 0 &&
        (!this.healthy || !this.#canRetainIdle(this))
      )
        this.close();
    };
    return {
      reused,
      get requiresConversationId() {
        return requiresConversationId();
      },
      get connected() {
        return isConnected();
      },
      connect: () => {
        if (state.released || this.#closed)
          throw new Error("TFRobot Socket transport has been released");
        if (this.healthy) {
          for (const listener of state.listeners.get("connect") ?? [])
            listener();
        } else if (!this.#connecting) {
          this.#connecting = true;
          this.#socket.connect();
        }
      },
      disconnect: () => {
        release();
        if (this.#leases.size === 0) this.close();
      },
      release,
      invalidate: () => this.close(true),
      emit: (event, ...args) => {
        if (!state.released && !this.#closed)
          return this.#socket.emit(event, ...args);
        return undefined;
      },
      on: (event, listener) => {
        if (state.released) return;
        this.#listen(event);
        const listeners = state.listeners.get(event) ?? new Set();
        listeners.add(listener);
        state.listeners.set(event, listeners);
      },
      off: (event, listener) => {
        state.listeners.get(event)?.delete(listener);
        this.#pruneListeners();
      },
      onAny: (listener) => {
        if (!state.released) {
          if (!this.#anyAttached) {
            this.#socket.onAny?.(this.#anyListener);
            this.#anyAttached = true;
          }
          state.anyListeners.add(listener);
        }
      },
      offAny: (listener) => {
        state.anyListeners.delete(listener);
        this.#pruneListeners();
      },
    };
  }

  #pruneListeners(): void {
    for (const [event, listener] of this.#listeners) {
      if (event === "disconnect") continue;
      if (
        [...this.#leases].some(
          (lease) => (lease.listeners.get(event)?.size ?? 0) > 0,
        )
      )
        continue;
      try {
        this.#socket.off(event, listener);
      } catch {
        /* best effort */
      }
      this.#listeners.delete(event);
    }
    if (
      this.#anyAttached &&
      ![...this.#leases].some((lease) => lease.anyListeners.size > 0)
    ) {
      try {
        this.#socket.offAny?.(this.#anyListener);
      } catch {
        /* best effort */
      }
      this.#anyAttached = false;
    }
  }

  #listen(event: string): void {
    if (this.#listeners.has(event)) return;
    const listener: TFRobotSocketListener = (...args) => {
      if (this.#closed) return;
      if (
        event === "connect" ||
        event === "connect_error" ||
        event === "disconnect"
      )
        this.#connecting = false;
      if (event === "disconnect" && this.#leases.size === 0) {
        this.close();
        return;
      }
      for (const lease of [...this.#leases]) {
        if (!lease.released)
          for (const callback of lease.listeners.get(event) ?? [])
            callback(...args);
      }
    };
    this.#socket.on(event, listener);
    this.#listeners.set(event, listener);
  }

  async #getAuth(): Promise<TFRobotSocketAuth> {
    const leases = [...this.#leases];
    if (this.#closed || leases.length === 0)
      throw new Error("TFRobot Socket authentication was cancelled");
    // Every live subscription needs the reconnect session for its REST rebase.
    // Different answers cannot be combined into a single authenticated socket.
    const results = await Promise.allSettled(
      leases.map((lease) => lease.getAuth()),
    );
    // A Runtime switch may release its old subscription while authentication
    // is pending. Its cancellation must not reject the surviving lease.
    const active = results.filter((_, index) => !leases[index]!.released);
    const values = active.map((result) => {
      if (result.status === "rejected") throw result.reason;
      return result.value;
    });
    const auth = values[0];
    if (
      this.#closed ||
      auth === undefined ||
      values.some((value) => !sameAuth(value, auth))
    )
      throw new Error("TFRobot Socket authentication contexts differ");
    this.#auth = auth;
    return auth;
  }

  close(authenticationChanged = false): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#auth = {};
    this.#onClose(this);
    // Fail closed on an identity change even if an old Runtime snapshot is
    // still visible while a candidate load is in flight.
    if (authenticationChanged) {
      for (const lease of [...this.#leases])
        if (!lease.released)
          for (const callback of lease.listeners.get("connect_error") ?? [])
            callback(new Error("TFRobot authentication context changed"));
    }
    for (const [event, listener] of this.#listeners) {
      try {
        this.#socket.off(event, listener);
      } catch {
        /* best-effort cleanup */
      }
    }
    this.#listeners.clear();
    try {
      this.#socket.offAny?.(this.#anyListener);
    } catch {
      /* best-effort cleanup */
    }
    try {
      this.#socket.disconnect();
    } catch {
      /* best-effort cleanup */
    }
    for (const lease of this.#leases) {
      lease.released = true;
      lease.listeners.clear();
      lease.anyListeners.clear();
    }
    this.#leases.clear();
  }
}

/** Instance-local; routes are fixed by TFRobotSocketClient's constructor. */
export class TFRobotSocketTransports {
  #disposed = false;
  readonly #connections = new Set<Connection>();
  #current: Connection | undefined;

  #selectHealthy(): Connection | undefined {
    if (!this.#current?.healthy)
      this.#current = [...this.#connections].find(
        (connection) => connection.healthy,
      );
    return this.#current;
  }

  acquire(
    factory: TFRobotSocketFactory,
    input: TFRobotSocketFactoryInput,
    auth: TFRobotSocketAuth,
    conversationId: string,
  ): SocketLease {
    if (this.#disposed) throw new Error("TFRobot Socket owner is disposed");
    this.isolateAuthentication(auth);
    if (this.#disposed) throw new Error("TFRobot Socket owner is disposed");
    const reusable = this.#selectHealthy();
    if (reusable) return reusable.acquire(input, conversationId, true);
    const connection = new Connection(
      factory,
      input,
      auth,
      conversationId,
      (closed) => {
        this.#connections.delete(closed);
        if (this.#current === closed) this.#current = undefined;
      },
      (idle) => this.#selectHealthy() === idle,
    );
    this.#connections.add(connection);
    this.#current = connection;
    return connection.acquire(input, conversationId, false);
  }

  isolateAuthentication(auth: TFRobotSocketAuth): void {
    for (const connection of [...this.#connections]) {
      if (!connection.matches(auth)) connection.close(true);
    }
  }

  invalidate(): void {
    for (const connection of [...this.#connections]) connection.close(true);
  }

  dispose(): void {
    this.#disposed = true;
    for (const connection of [...this.#connections]) connection.close();
  }
}
