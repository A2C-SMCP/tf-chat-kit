import { Manager, type Socket } from "socket.io-client";
import {
  adaptSocketIoSocket,
  guardSocketAcknowledgement,
  REUSE_DISCONNECTED_SOCKET,
  SocketConnectionDisposedError,
} from "./socket-adapter.js";
import type {
  TFRobotSocket,
  TFRobotSocketAnyListener,
  TFRobotSocketFactory,
  TFRobotSocketFactoryInput,
  TFRobotSocketListener,
} from "./types.js";

export interface TFRobotSocketConnectionOptions {
  /** Engine.IO service origin; namespace and REST paths are configured on clients. */
  readonly serverUrl: string;
  readonly socketPath?: string;
}

export interface TFRobotSocketConnection {
  readonly socketFactory: TFRobotSocketFactory;
  /** Permanently ends this connection context, including active namespaces. */
  dispose(): void;
}

const endpoint = (value: string): URL => {
  const url = new URL(value);
  if (
    !["https:", "http:", "ws:", "wss:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new TypeError("Invalid Socket connection endpoint");
  // HTTP and WebSocket schemes address the same Engine.IO service.
  if (url.protocol === "ws:") url.protocol = "http:";
  if (url.protocol === "wss:") url.protocol = "https:";
  return url;
};

const socketPath = (value: string): string => {
  if (
    !value.startsWith("/") ||
    value.startsWith("//") ||
    /[?#\\]/u.test(value) ||
    new URL(value, "https://socket.invalid").pathname !== value
  )
    throw new TypeError("Invalid Socket connection path");
  return value.replace(/\/+$/u, "") || "/";
};

/**
 * Explicit instance-local multiplexing. One live owner per namespace; Gateway
 * subscription leases continue to live inside that owner. Credentials remain
 * namespace-local, and construction neither reads them nor opens the network.
 */
export const createTFRobotSocketConnection = (
  options: TFRobotSocketConnectionOptions,
): TFRobotSocketConnection => {
  const url = endpoint(options.serverUrl);
  if (url.pathname !== "/")
    throw new TypeError("Socket serverUrl must be an origin");
  const path = socketPath(options.socketPath ?? "/socket.io");
  const manager = new Manager(url.origin, {
    autoConnect: false,
    path,
    reconnection: true,
    transports: ["websocket"],
  });
  let disposed = false;
  const owners = new Map<string, NamespaceHandle>();
  const handles = new Set<NamespaceHandle>();
  const retirements = new Map<
    string,
    {
      readonly finish: () => void;
      readonly waiters: Set<() => void>;
    }
  >();

  // CONNECT has no cancellation packet until the Server accepts the namespace.
  // Keep its native subscription just long enough to consume a late reply, then
  // send DISCONNECT before allowing the next logical owner to send CONNECT.
  const retire = (namespace: string, socket: Socket): void => {
    const waiters = new Set<() => void>();
    let finished = false;
    const finish = (): void => {
      if (finished) return;
      finished = true;
      socket.off("connect", finish);
      socket.off("connect_error", finish);
      socket.off("disconnect", finish);
      socket.disconnect();
      // Complete the old event dispatch before exposing the cached native
      // Socket to its successor (which must not observe that old CONNECT).
      void Promise.resolve().then(() => {
        retirements.delete(namespace);
        if (!disposed) for (const resume of waiters) resume();
        waiters.clear();
      });
    };
    retirements.set(namespace, { finish, waiters });
    socket.once("connect", finish);
    socket.once("connect_error", finish);
    socket.once("disconnect", finish);
  };

  const closeUnusedRetirements = (): void => {
    if (![...owners.values()].some((owner) => owner.active))
      for (const retirement of retirements.values()) retirement.finish();
  };

  class NamespaceHandle implements TFRobotSocket {
    readonly [REUSE_DISCONNECTED_SOCKET] = true;
    readonly #namespace: string;
    readonly #socket: Socket;
    readonly #adapter: TFRobotSocket;
    #getAuth: TFRobotSocketFactoryInput["getAuth"] | undefined;
    readonly #listeners = new Map<
      string,
      Map<TFRobotSocketListener, TFRobotSocketListener>
    >();
    readonly #anyListeners = new Map<
      TFRobotSocketAnyListener,
      TFRobotSocketAnyListener
    >();
    #generation = 0;
    #authAttempt = 0;
    #started = false;
    #sentOn: object | undefined;
    readonly #resume = (): void => {
      if (this.#owns()) this.connect();
    };

    constructor(namespace: string, input: TFRobotSocketFactoryInput) {
      this.#namespace = namespace;
      this.#getAuth = input.getAuth;
      this.#socket = manager.socket(namespace);
      this.#adapter = adaptSocketIoSocket(this.#socket);
      owners.set(namespace, this);
      handles.add(this);
    }

    #owns(): boolean {
      return !disposed && owners.get(this.#namespace) === this;
    }
    #usable(): boolean {
      return this.#owns() && this.#started && !retirements.has(this.#namespace);
    }
    get connected(): boolean {
      return this.#usable() && this.#socket.connected;
    }
    get active(): boolean {
      return this.#usable() && this.#socket.active;
    }

    connect(): void {
      if (disposed || this.#getAuth === undefined)
        throw new Error("Socket connection context is disposed");
      const owner = owners.get(this.#namespace);
      if (owner !== undefined && owner !== this)
        throw new Error("Socket namespace already has an owner");
      owners.set(this.#namespace, this);
      this.#started = true;
      const retirement = retirements.get(this.#namespace);
      if (retirement !== undefined) {
        retirement.waiters.add(this.#resume);
        return;
      }
      const generation = ++this.#generation;
      this.#socket.auth = (callback) => {
        const getAuth = this.#getAuth;
        const attempt = ++this.#authAttempt;
        const engine = manager.engine;
        const current = (): boolean =>
          this.#owns() &&
          generation === this.#generation &&
          attempt === this.#authAttempt &&
          engine === manager.engine &&
          engine?.readyState === "open";
        if (!current() || getAuth === undefined) return;
        void Promise.resolve()
          .then(() => {
            if (!current())
              throw new Error("Socket authentication was superseded");
            return getAuth();
          })
          .then(
            (auth) => {
              if (current()) {
                this.#sentOn = engine;
                callback(auth);
              }
            },
            () => {
              if (current()) {
                this.#sentOn = engine;
                callback({});
              }
            },
          );
      };
      this.#socket.connect();
    }

    disconnect(): void {
      if (owners.get(this.#namespace) !== this) return;
      ++this.#generation;
      const retirement = retirements.get(this.#namespace);
      retirement?.waiters.delete(this.#resume);
      const pending =
        this.#socket.active &&
        !this.#socket.connected &&
        this.#sentOn === manager.engine &&
        manager.engine?.readyState === "open";
      owners.delete(this.#namespace);
      this.#started = false;
      this.#socket.auth = {};
      if (retirement === undefined) {
        if (pending) retire(this.#namespace, this.#socket);
        else this.#socket.disconnect();
      }
      this.#sentOn = undefined;
      this.#notify("disconnect", "io client disconnect");
      this.#retire();
      closeUnusedRetirements();
    }

    emit(event: string, ...args: unknown[]): unknown {
      if (!this.#usable()) return undefined;
      const generation = this.#generation;
      return this.#adapter.emit(
        event,
        ...guardSocketAcknowledgement(
          args,
          () => this.#owns() && generation === this.#generation,
        ),
      );
    }

    on(event: string, listener: TFRobotSocketListener): void {
      if (disposed) return;
      const listeners = this.#listeners.get(event) ?? new Map();
      if (listeners.has(listener)) return;
      const guarded: TFRobotSocketListener = (...args) => {
        if (this.#usable()) listener(...args);
      };
      listeners.set(listener, guarded);
      this.#listeners.set(event, listeners);
      this.#adapter.on(event, guarded);
    }

    off(event: string, listener: TFRobotSocketListener): void {
      const listeners = this.#listeners.get(event);
      const guarded = listeners?.get(listener);
      if (guarded !== undefined) this.#adapter.off(event, guarded);
      listeners?.delete(listener);
      if (listeners?.size === 0) this.#listeners.delete(event);
      this.#retire();
    }

    onAny(listener: TFRobotSocketAnyListener): void {
      if (disposed || this.#anyListeners.has(listener)) return;
      const guarded: TFRobotSocketAnyListener = (...args) => {
        if (this.#usable()) listener(...args);
      };
      this.#anyListeners.set(listener, guarded);
      this.#adapter.onAny?.(guarded);
    }

    offAny(listener: TFRobotSocketAnyListener): void {
      const guarded = this.#anyListeners.get(listener);
      if (guarded !== undefined) this.#adapter.offAny?.(guarded);
      this.#anyListeners.delete(listener);
      this.#retire();
    }

    #notify(event: string, ...args: unknown[]): void {
      for (const listener of [...(this.#listeners.get(event)?.keys() ?? [])]) {
        try {
          listener(...args);
        } catch {
          /* Complete namespace cleanup. */
        }
      }
    }

    #retire(): void {
      if (
        owners.get(this.#namespace) !== this &&
        this.#listeners.size === 0 &&
        this.#anyListeners.size === 0
      ) {
        this.#getAuth = undefined;
        handles.delete(this);
      }
    }

    dispose(): void {
      ++this.#generation;
      this.#getAuth = undefined;
      // Make namespace owners terminate pending handshakes and active work too.
      this.#notify("connect_error", new SocketConnectionDisposedError());
      this.#notify("disconnect", "io client disconnect");
      if (owners.get(this.#namespace) === this) {
        owners.delete(this.#namespace);
        this.#socket.auth = {};
        this.#socket.disconnect();
      }
      for (const [event, listeners] of this.#listeners)
        for (const guarded of listeners.values())
          this.#adapter.off(event, guarded);
      for (const guarded of this.#anyListeners.values())
        this.#adapter.offAny?.(guarded);
      this.#listeners.clear();
      this.#anyListeners.clear();
      handles.delete(this);
    }
  }

  return Object.freeze({
    socketFactory: (input: TFRobotSocketFactoryInput): TFRobotSocket => {
      if (disposed) throw new Error("Socket connection context is disposed");
      const target = endpoint(input.namespaceUrl);
      if (target.origin !== url.origin || socketPath(input.path) !== path)
        throw new TypeError(
          "Socket endpoint does not match connection context",
        );
      if (owners.has(target.pathname))
        throw new Error("Socket namespace already has an owner");
      return new NamespaceHandle(target.pathname, input);
    },
    dispose: (): void => {
      if (disposed) return;
      disposed = true;
      manager.reconnection(false);
      for (const handle of [...handles]) handle.dispose();
      for (const retirement of retirements.values()) retirement.finish();
      owners.clear();
    },
  });
};
