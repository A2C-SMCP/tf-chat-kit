import {
  remoteToolDefinitionSchema,
  remoteToolInvocationSchema,
  remoteToolResultSchema,
  type RemoteTool,
  type RemoteToolConnectionState,
  type RemoteToolErrorCode,
  type RemoteToolInvocation,
  type RemoteToolResult,
  type RemoteToolTransport,
} from "@turingfocus/chat-protocol";

export interface RemoteToolClientOptions {
  readonly transport: RemoteToolTransport;
  /** Immutable registration manifest. Dispose this client before replacing its tools. */
  readonly tools: readonly RemoteTool[];
  /** Defaults to 110 seconds; must not exceed the current Server's safe local budget. */
  readonly timeoutMs?: number;
  readonly maxConcurrentCalls?: number;
  /** Fail closed when full, retaining deduplication for the entire client lifetime. */
  readonly maxRememberedCalls?: number;
}
export interface RemoteToolClientState extends RemoteToolConnectionState {
  readonly activeCalls: number;
  readonly lastCallError?: RemoteToolErrorCode;
}
const limit = (
  value: number | undefined,
  fallback: number,
  maximum: number,
): number => {
  const result = value ?? fallback;
  if (!Number.isInteger(result) || result <= 0 || result > maximum)
    throw new TypeError("Invalid RemoteTool limit");
  return result;
};

/** Instance-owned executor. Reconnect restores definitions, never business calls. */
export class RemoteToolClient {
  readonly #transport: RemoteToolTransport;
  readonly #tools = new Map<string, RemoteTool>();
  readonly #seen = new Set<string>();
  readonly #calls = new Map<
    string,
    (code: RemoteToolErrorCode, respond?: boolean) => void
  >();
  readonly #listeners = new Set<() => void>();
  readonly #timeoutMs: number;
  readonly #maxConcurrent: number;
  readonly #maxRemembered: number;
  #state: RemoteToolClientState = Object.freeze({
    status: "idle",
    activeCalls: 0,
  });
  #started = false;
  #disposed = false;

  constructor(options: RemoteToolClientOptions) {
    this.#transport = options.transport;
    this.#timeoutMs = limit(options.timeoutMs, 110_000, 110_000);
    this.#maxConcurrent = limit(options.maxConcurrentCalls, 32, 1_000);
    this.#maxRemembered = limit(options.maxRememberedCalls, 10_000, 1_000_000);
    if (options.tools.length === 0 || options.tools.length > 100)
      throw new TypeError("Provide 1–100 RemoteTools");
    for (const tool of options.tools) {
      const definition = remoteToolDefinitionSchema.parse(tool.definition);
      if (this.#tools.has(definition.toolName))
        throw new TypeError("Duplicate RemoteTool name");
      this.#tools.set(definition.toolName, {
        definition,
        validate: (params) => tool.validate(params),
        execute: (params, context) => tool.execute(params, context),
      });
    }
  }

  getSnapshot = (): RemoteToolClientState => this.#state;
  subscribe = (listener: () => void): (() => void) => {
    if (this.#disposed) return () => undefined;
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };
  start(): void {
    if (this.#started || this.#disposed) return;
    this.#started = true;
    this.#update({ status: "connecting" });
    if (this.#disposed) return;
    try {
      this.#transport.start(
        [...this.#tools.values()].map((tool) => tool.definition),
        {
          state: (state) => {
            if (this.#disposed) return;
            this.#update(state);
            if (state.status !== "ready") this.#abortAll("disconnected", false);
          },
          invoke: (invocation, respond) => this.#invoke(invocation, respond),
        },
      );
    } catch {
      this.#update({ status: "error", error: "transport" });
      this.#abortAll("disconnected", false);
      try {
        this.#transport.dispose();
      } catch {
        /* A failed adapter cannot keep dispatching. */
      }
    }
  }

  cancel(requestId: string): boolean {
    const cancel = this.#calls.get(requestId);
    if (cancel === undefined) return false;
    cancel("cancelled");
    return true;
  }

  retry(): void {
    if (
      !this.#started ||
      this.#disposed ||
      (this.#state.status !== "error" && this.#state.status !== "disconnected")
    )
      return;
    try {
      this.#transport.retry();
    } catch {
      this.#update({ status: "error", error: "transport" });
    }
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#abortAll("disposed");
    try {
      this.#transport.dispose();
    } catch {
      // Remain disposed even when a host-provided transport cleanup fails.
    } finally {
      this.#update({ status: "disposed" });
      this.#listeners.clear();
      this.#tools.clear();
      this.#seen.clear();
    }
  }

  #update(
    connection: RemoteToolConnectionState,
    lastCallError = this.#state.lastCallError,
  ): void {
    this.#state = Object.freeze({
      ...connection,
      activeCalls: this.#calls.size,
      ...(lastCallError === undefined ? {} : { lastCallError }),
    });
    for (const listener of [...this.#listeners]) {
      try {
        listener();
      } catch {
        /* Host subscribers are isolated. */
      }
    }
  }
  #abortAll(code: RemoteToolErrorCode, respond = true): void {
    for (const cancel of [...this.#calls.values()]) cancel(code, respond);
  }
  #invoke(
    input: RemoteToolInvocation,
    respond: (result: RemoteToolResult) => void,
  ): void {
    if (this.#disposed || this.#state.status !== "ready") return;
    let invocation: RemoteToolInvocation;
    try {
      invocation = remoteToolInvocationSchema.parse(input);
    } catch {
      return;
    }
    if (this.#seen.has(invocation.requestId)) return;
    // Do not evict old IDs: replaying an evicted request could repeat side effects.
    if (this.#seen.size >= this.#maxRemembered) {
      this.#update({ status: "error", error: "transport" }, "capacity");
      this.#abortAll("capacity");
      try {
        respond({ ok: false, code: "capacity" });
      } catch {
        /* Transport unavailable. */
      }
      this.dispose();
      return;
    }
    this.#seen.add(invocation.requestId);
    const reject = (code: RemoteToolErrorCode): void => {
      this.#update(this.#state, code);
      try {
        respond({ ok: false, code });
      } catch {
        /* Transport unavailable. */
      }
    };
    const tool = this.#tools.get(invocation.toolName);
    if (tool === undefined) return reject("unknown-tool");
    if (this.#calls.size >= this.#maxConcurrent) return reject("capacity");
    let settled = false;
    let aborted = false;
    let cancellationReason: RemoteToolErrorCode | undefined;
    const abortListeners = new Set<() => void>();
    let clearTimer = (): void => undefined;
    const deadlineAt = this.#transport.clock.now() + this.#timeoutMs;
    const finish = (result: RemoteToolResult, send = true): void => {
      if (settled) return;
      settled = true;
      clearTimer();
      this.#calls.delete(invocation.requestId);
      cancellationReason = result.ok ? undefined : result.code;
      aborted = true;
      for (const listener of [...abortListeners]) {
        try {
          listener();
        } catch {
          /* Host cancellation is isolated. */
        }
      }
      abortListeners.clear();
      this.#update(this.#state, result.ok ? undefined : result.code);
      if (send) {
        try {
          respond(result);
        } catch {
          /* Never retry a result or replay the handler. */
        }
      }
    };
    this.#calls.set(invocation.requestId, (code, send = true) =>
      finish({ ok: false, code }, send),
    );
    clearTimer = this.#transport.clock.schedule(
      () => finish({ ok: false, code: "timeout" }),
      this.#timeoutMs,
    );
    this.#update(this.#state);
    const expired = (): boolean => {
      if (!settled && this.#transport.clock.now() >= deadlineAt)
        finish({ ok: false, code: "timeout" });
      return settled;
    };
    const context = {
      requestId: invocation.requestId,
      deadlineAt,
      clock: this.#transport.clock,
      get cancellationReason() {
        return cancellationReason;
      },
      signal: {
        get aborted() {
          return aborted;
        },
        subscribe(listener: () => void): () => void {
          if (aborted) {
            listener();
            return () => undefined;
          }
          abortListeners.add(listener);
          return () => {
            abortListeners.delete(listener);
          };
        },
      },
    };
    void Promise.resolve()
      .then(async () => {
        if (expired()) return;
        let params: unknown;
        try {
          params = await tool.validate(invocation.params);
        } catch {
          if (!expired()) finish({ ok: false, code: "invalid-parameters" });
          return;
        }
        if (expired()) return;
        let result: unknown;
        try {
          result = await tool.execute(params, context);
        } catch {
          if (!expired()) finish({ ok: false, code: "handler-failed" });
          return;
        }
        if (expired()) return;
        try {
          finish(remoteToolResultSchema.parse(result));
        } catch {
          finish({ ok: false, code: "invalid-result" });
        }
      })
      .catch(() => {
        if (!settled) finish({ ok: false, code: "handler-failed" });
      });
  }
}

export const createRemoteToolClient = (
  options: RemoteToolClientOptions,
): RemoteToolClient => new RemoteToolClient(options);
