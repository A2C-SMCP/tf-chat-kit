import {
  createTFRobotChatClient,
  type TFRobotChatClientOptions,
} from "./tfrobot-client.js";
import type { ChatClient } from "@turingfocus/chat-runtime";
import type { TFRobotSession } from "@turingfocus/chat-gateway-tfrobot";
import {
  safeDiagnosticError,
  type ChatError,
  type SessionProvider,
} from "@turingfocus/chat-protocol";

/** Structural port: optional Manager integration never installs or imports chat-auth. */
export interface ManagerChatConnection {
  readonly target: {
    readonly baseUrl: string;
    readonly socketNamespaceUrl: string;
    readonly socketPath: string;
  };
  readonly sessionProvider: SessionProvider<TFRobotSession>;
  dispose(): void;
}
export interface ManagerChatSource<Robot> {
  connect(
    robot: Robot,
    options?: { readonly signal?: AbortSignal },
  ): Promise<ManagerChatConnection>;
  getSnapshot?(): {
    readonly status: string;
    readonly identityRevision?: number | undefined;
  };
  subscribe(
    listener: (snapshot: {
      readonly status: string;
      readonly identityRevision?: number | undefined;
    }) => void,
  ): () => void;
}
export interface ManagerChatSnapshot {
  readonly status: "idle" | "connecting" | "ready" | "error" | "disposed";
  readonly client?: ChatClient | undefined;
  readonly error?:
    { readonly code: string; readonly message: string } | undefined;
}
export interface ManagerChatControllerOptions<Robot> {
  readonly manager: ManagerChatSource<Robot>;
  readonly chat: Omit<
    TFRobotChatClientOptions,
    "baseUrl" | "sessionProvider" | "socketPath" | "socketNamespaceUrl"
  >;
  /** A lifecycle deadline, not a polling interval. */
  readonly disposeTimeoutMs?: number | undefined;
  readonly onDisposeError?: ((error: unknown) => void) | undefined;
}
export class ManagerChatController<Robot> {
  readonly #options: ManagerChatControllerOptions<Robot>;
  readonly #unsubscribe: () => void;
  readonly #listeners = new Set<() => void>();
  readonly #cleanup = new Set<Promise<void>>();
  #snapshot: ManagerChatSnapshot = Object.freeze({ status: "idle" });
  #connection: ManagerChatConnection | undefined;
  #abort: AbortController | undefined;
  #generation = 0;
  #disposed = false;
  constructor(options: ManagerChatControllerOptions<Robot>) {
    if (
      options.disposeTimeoutMs !== undefined &&
      (!Number.isFinite(options.disposeTimeoutMs) ||
        options.disposeTimeoutMs <= 0 ||
        options.disposeTimeoutMs > 60_000)
    )
      throw new TypeError("Invalid disposal deadline");
    this.#options = options;
    let identityRevision =
      options.manager.getSnapshot?.().identityRevision ?? 0;
    this.#unsubscribe = options.manager.subscribe((snapshot) => {
      const changed =
        snapshot.identityRevision !== undefined &&
        snapshot.identityRevision !== identityRevision;
      identityRevision = snapshot.identityRevision ?? identityRevision;
      if (
        changed ||
        snapshot.status === "auth_required" ||
        snapshot.status === "disposed"
      )
        void this.select(undefined);
    });
  }
  getSnapshot = (): ManagerChatSnapshot => this.#snapshot;
  subscribe = (listener: () => void): (() => void) => {
    if (this.#disposed) return () => {};
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };
  #update(snapshot: ManagerChatSnapshot): void {
    if (this.#disposed) return;
    this.#snapshot = Object.freeze(snapshot);
    for (const listener of this.#listeners) {
      try {
        listener();
      } catch {
        /* Isolate observers. */
      }
    }
  }
  #release(): void {
    this.#abort?.abort();
    this.#abort = undefined;
    this.#connection?.dispose();
    this.#connection = undefined;
    const client = this.#snapshot.client;
    if (client !== undefined) {
      let timer: ReturnType<typeof setTimeout>;
      const timeout = new Promise<void>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Chat disposal deadline exceeded")),
          this.#options.disposeTimeoutMs ?? 10_000,
        );
      });
      const work = Promise.race([
        client.dispose({
          deadlineAt: Date.now() + (this.#options.disposeTimeoutMs ?? 10_000),
        }),
        timeout,
      ])
        .catch((error) => {
          try {
            this.#options.onDisposeError?.(error);
          } catch {
            /* Isolate observers. */
          }
        })
        .finally(() => {
          clearTimeout(timer);
          this.#cleanup.delete(work);
        });
      this.#cleanup.add(work);
    }
  }
  async select(robot: Robot | undefined): Promise<void> {
    if (this.#disposed) return;
    const generation = ++this.#generation;
    this.#release();
    this.#update({ status: robot === undefined ? "idle" : "connecting" });
    if (robot === undefined) return;
    const controller = new AbortController();
    this.#abort = controller;
    let connection: ManagerChatConnection | undefined;
    try {
      connection = await this.#options.manager.connect(robot, {
        signal: controller.signal,
      });
      if (this.#disposed || generation !== this.#generation) {
        connection.dispose();
        return;
      }
      const client = createTFRobotChatClient({
        ...this.#options.chat,
        ...connection.target,
        sessionProvider: connection.sessionProvider,
      });
      this.#connection = connection;
      this.#update({ status: "ready", client });
    } catch {
      connection?.dispose();
      if (!this.#disposed && generation === this.#generation)
        this.#update({
          status: "error",
          error: Object.freeze({
            code: "connection_failed",
            message:
              "Robot connection failed. Inspect Manager diagnostics and retry.",
          }),
        });
    }
  }
  async dispose(): Promise<void> {
    if (this.#disposed) {
      await Promise.all([...this.#cleanup]);
      return;
    }
    this.#generation++;
    this.#unsubscribe();
    this.#release();
    this.#update({ status: "disposed" });
    this.#disposed = true;
    this.#listeners.clear();
    await Promise.all([...this.#cleanup]);
  }
}
export const createManagerChatController = <Robot>(
  options: ManagerChatControllerOptions<Robot>,
): ManagerChatController<Robot> => new ManagerChatController(options);

/** Bridges optional Manager diagnostics to the existing safe ChatClient diagnostic model. */
export function managerDiagnosticToChatError(input: {
  readonly operation: "directory" | "connection-info" | "resolve" | "exchange";
  readonly code: string;
  readonly status?: number | undefined;
  readonly path?: string | undefined;
  readonly requestId?: string | undefined;
}): ChatError {
  const codes = new Map<string, ChatError["code"]>([
    ["authentication", "authentication"],
    ["authorization", "authorization"],
    ["conflict", "conflict"],
    ["network", "network"],
    ["not_found", "not-found"],
    ["server", "server"],
    ["timeout", "timeout"],
    ["unsupported_contract", "unsupported"],
    ["invalid_response", "validation"],
    ["rate_limited", "network"],
    ["payment_required", "authorization"],
    ["cancelled", "conflict"],
    ["disposed", "conflict"],
  ]);
  const known = codes.has(input.code);
  const code = codes.get(input.code) ?? "unknown";
  const paths = [
    "/api/v1/digital-employees",
    "/api/v1/digital-employees/:employeeId/connection-info",
    "/api/v1/oauth/token",
  ];
  const requestId =
    input.requestId &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(
      input.requestId,
    )
      ? input.requestId
      : undefined;
  return safeDiagnosticError({
    code,
    message: "Manager operation failed",
    retryable: ["network", "server", "timeout"].includes(code),
    diagnostic: {
      operation: `manager.${input.operation}`,
      phase: `manager.${input.operation}`,
      reasonCode: known ? input.code : "unknown",
      ...(input.status === undefined ? {} : { httpStatus: input.status }),
      ...(input.path && paths.includes(input.path) ? { path: input.path } : {}),
      ...(requestId === undefined ? {} : { requestId }),
    },
  });
}
