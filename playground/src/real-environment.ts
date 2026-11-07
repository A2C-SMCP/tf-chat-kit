import { createAuthClient } from "@turingfocus/chat-kit/auth";
import { createTfRobotAuthTransport } from "@turingfocus/chat-kit/auth/tfrobot";
import {
  createManagerClient,
  ManagerIntegrationError,
  managerIdentityScope,
  type ManagerClient,
  type ManagerRobot,
  type ManagerRobotConnection,
} from "@turingfocus/chat-kit/auth/manager";
import {
  createTFRobotRemoteToolClient,
  createTFRobotSocketConnection,
  defineRemoteTool,
  type RemoteToolClient,
  type RemoteToolClientState,
  type TFRobotSocketConnection,
  type TFRobotSocketFactory,
} from "@turingfocus/chat-kit/headless";

export const MANAGER_ENVIRONMENTS = {
  test: "https://rest.test.turingfocus.cn",
  staging: "https://api-staging.turingfocus.cn",
  production: "https://api.turingfocus.cn",
} as const;

export interface AdditionCall {
  readonly a: number;
  readonly b: number;
  readonly sum: number;
}
interface ToolSnapshot {
  readonly status: RemoteToolClientState["status"] | "resolving";
  readonly error?: string | undefined;
  readonly robotId?: string | undefined;
  readonly calls: readonly AdditionCall[];
}
const IDLE: ToolSnapshot = Object.freeze({ status: "idle", calls: [] });

/** Private host controller; all registration and dispatch use the public SDK. */
export class PlaygroundRemoteTools {
  readonly #manager: ManagerClient;
  readonly #factory: TFRobotSocketFactory;
  readonly #listeners = new Set<() => void>();
  readonly #unwatch: () => void;
  #state = IDLE;
  #client: RemoteToolClient | undefined;
  #connection: ManagerRobotConnection | undefined;
  #unsubscribe: (() => void) | undefined;
  #abort: AbortController | undefined;
  #generation = 0;
  #disposed = false;

  constructor(manager: ManagerClient, factory: TFRobotSocketFactory) {
    this.#manager = manager;
    this.#factory = factory;
    let revision = manager.getSnapshot().identityRevision;
    this.#unwatch = manager.subscribe((snapshot) => {
      if (snapshot.identityRevision !== revision) {
        revision = snapshot.identityRevision;
        this.stop();
      }
    });
  }
  getSnapshot = (): ToolSnapshot => this.#state;
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };
  #update(state: ToolSnapshot): void {
    if (this.#disposed) return;
    this.#state = Object.freeze(state);
    for (const listener of this.#listeners) listener();
  }
  stop = (): void => {
    ++this.#generation;
    this.#abort?.abort();
    this.#abort = undefined;
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    this.#client?.dispose();
    this.#client = undefined;
    this.#connection?.dispose();
    this.#connection = undefined;
    this.#update(IDLE);
  };
  start = async (robot: ManagerRobot): Promise<void> => {
    if (this.#disposed) return;
    this.stop();
    const generation = this.#generation;
    const abort = new AbortController();
    this.#abort = abort;
    const current = () => !this.#disposed && generation === this.#generation;
    this.#update({ status: "resolving", robotId: robot.id, calls: [] });
    let connection: ManagerRobotConnection | undefined;
    try {
      connection = await this.#manager.connect(robot, { signal: abort.signal });
      if (!current()) {
        connection.dispose();
        return;
      }
      this.#connection = connection;
      const client = createTFRobotRemoteToolClient({
        baseUrl: connection.target.baseUrl,
        socketNamespaceUrl: `${new URL(connection.target.socketNamespaceUrl).origin}/remote-tool`,
        socketPath: connection.target.socketPath,
        socketFactory: this.#factory,
        sessionProvider: connection.sessionProvider,
        tools: [
          defineRemoteTool({
            definition: {
              toolName: "add",
              description: "Add two numbers and return their sum.",
              parameters: {
                type: "object",
                properties: { a: { type: "number" }, b: { type: "number" } },
                required: ["a", "b"],
                additionalProperties: false,
              },
              tags: ["Read"],
            },
            validate(params) {
              const { a, b } = params;
              if (
                Object.keys(params).length !== 2 ||
                typeof a !== "number" ||
                !Number.isFinite(a) ||
                typeof b !== "number" ||
                !Number.isFinite(b) ||
                !Number.isFinite(a + b)
              )
                throw new Error(
                  "Expected two finite numbers with a finite sum",
                );
              return { a, b };
            },
            execute: ({ a, b }, { signal }) => {
              if (signal.aborted || !current())
                return { ok: false, code: "cancelled" };
              const sum = a + b;
              this.#update({
                ...this.#state,
                calls: [...this.#state.calls, { a, b, sum }].slice(-20),
              });
              return {
                ok: true,
                resultForLlm: String(sum),
                origin: { a, b, sum },
              };
            },
          }),
        ],
      });
      this.#client = client;
      const update = () => {
        if (!current()) return;
        const state = client.getSnapshot();
        this.#update({
          ...this.#state,
          status: state.status,
          error: state.error ?? state.lastCallError,
        });
      };
      this.#unsubscribe = client.subscribe(update);
      client.start();
      update();
    } catch (error) {
      connection?.dispose();
      if (current()) {
        this.#connection = undefined;
        this.#update({
          status: "error",
          robotId: robot.id,
          calls: [],
          error:
            error instanceof ManagerIntegrationError &&
            error.code === "authorization"
              ? "authentication"
              : "transport",
        });
      }
    }
  };
  dispose(): void {
    if (this.#disposed) return;
    this.stop();
    this.#disposed = true;
    this.#unwatch();
    this.#listeners.clear();
  }
}

/** One instance per applied environment; credentials never leave SDK memory. */
export const createPlaygroundEnvironment = (baseUrl: string) => {
  const auth = createAuthClient({
    environment:
      baseUrl === MANAGER_ENVIRONMENTS.production ? "production" : "staging",
    transport: createTfRobotAuthTransport({ baseUrl }),
  });
  const routing = {
    allowedOrigins: [new URL(baseUrl).origin],
    isTrustedOrigin: (origin: string) => {
      const url = new URL(origin);
      return (
        url.protocol === "https:" &&
        (url.hostname === "turingfocus.cn" ||
          url.hostname.endsWith(".turingfocus.cn"))
      );
    },
    http: { kind: "routed-server" as const },
  };
  const manager = createManagerClient({ auth, baseUrl, routing });
  const toolManager = createManagerClient({
    auth,
    baseUrl,
    routing,
    robotSessionScopes: ["action:execute"],
  });
  const connections = new Map<string, TFRobotSocketConnection>();
  let disposed = false;
  const resetConnections = () => {
    for (const connection of connections.values()) connection.dispose();
    connections.clear();
  };
  const socketFactory: TFRobotSocketFactory = (input) => {
    if (disposed) throw new Error("Playground environment disposed");
    const origin = new URL(input.namespaceUrl).origin;
    const path = input.path.replace(/\/+$/u, "") || "/";
    const key = JSON.stringify([origin, path]);
    let connection = connections.get(key);
    if (!connection) {
      connection = createTFRobotSocketConnection({
        serverUrl: origin,
        socketPath: path,
      });
      connections.set(key, connection);
    }
    return connection.socketFactory(input);
  };
  const tools = new PlaygroundRemoteTools(toolManager, socketFactory);
  let scope = managerIdentityScope(auth.getSnapshot());
  const unwatch = auth.subscribe((snapshot) => {
    const next = managerIdentityScope(snapshot);
    if (next !== scope) {
      scope = next;
      resetConnections();
    }
  });
  const chat = {
    serverProfile: { kind: "current-server" as const },
    conversationContract: "json-v2" as const,
    socketFactory,
    messageCreatorProvider: () => {
      const account = auth.getSnapshot().account;
      if (!account) throw new Error("Sign in before sending messages");
      return {
        uid: account.userId,
        name: account.displayName ?? account.userId,
      };
    },
  };
  return {
    baseUrl,
    auth,
    manager,
    toolManager,
    tools,
    chat,
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      tools.dispose();
      unwatch();
      resetConnections();
      manager.dispose();
      toolManager.dispose();
      await auth.dispose();
    },
  };
};
export type PlaygroundEnvironment = ReturnType<
  typeof createPlaygroundEnvironment
>;
