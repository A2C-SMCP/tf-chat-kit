import type {
  TFRobotSession,
  TFRobotSocket,
  TFRobotSocketAnyListener,
  TFRobotSocketFactoryInput,
  TFRobotSocketListener,
} from "../../packages/chat-gateway-tfrobot/src/index.js";
import type {
  SessionProvider,
  SessionRequest,
} from "../../packages/chat-protocol/src/index.js";

type FixturePayload = unknown | (() => Promise<Response> | Response);

export const CURRENT_SERVER_HOLD_ACK = Symbol("current-server-hold-ack");

export interface CurrentServerRequestRecord {
  readonly authorization: string | null;
  readonly method: string;
  readonly url: string;
}

export interface CurrentServerFixtureOptions {
  readonly acknowledgements?:
    readonly (unknown | typeof CURRENT_SERVER_HOLD_ACK)[] | undefined;
  readonly history?: readonly FixturePayload[] | undefined;
  readonly session?: TFRobotSession | undefined;
  readonly status?: readonly FixturePayload[] | undefined;
}

const envelope = (data: unknown): Response =>
  new Response(JSON.stringify({ code: 200, message: "Success", data }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

const asResponse = async (
  payload: FixturePayload | undefined,
): Promise<Response> => {
  const resolved = typeof payload === "function" ? await payload() : payload;
  return resolved instanceof Response
    ? resolved
    : envelope(
        resolved ?? {
          messages: [],
          events: [],
          cursor: null,
        },
      );
};

export class CurrentServerSocket implements TFRobotSocket {
  connected = false;
  readonly authentications: unknown[] = [];
  readonly #acknowledgements: Array<unknown | typeof CURRENT_SERVER_HOLD_ACK>;
  readonly #anyListeners = new Set<TFRobotSocketAnyListener>();
  readonly #input: TFRobotSocketFactoryInput;
  readonly #listeners = new Map<string, Set<TFRobotSocketListener>>();
  readonly pendingAcknowledgements: Array<(value?: unknown) => void> = [];

  constructor(
    input: TFRobotSocketFactoryInput,
    acknowledgements: readonly (unknown | typeof CURRENT_SERVER_HOLD_ACK)[],
  ) {
    this.#input = input;
    this.#acknowledgements = [...acknowledgements];
  }

  connect(): void {
    void this.#connect();
  }

  disconnect(): void {
    this.connected = false;
  }

  emit(eventName: string, ...arguments_: unknown[]): void {
    if (eventName !== "join_conversation") return;
    const acknowledgement = arguments_[1];
    if (typeof acknowledgement !== "function") return;
    const value = this.#acknowledgements.shift();
    if (value === CURRENT_SERVER_HOLD_ACK) {
      this.pendingAcknowledgements.push(
        acknowledgement as (value?: unknown) => void,
      );
      return;
    }
    (acknowledgement as (value?: unknown) => void)(value);
  }

  off(eventName: string, listener: TFRobotSocketListener): void {
    this.#listeners.get(eventName)?.delete(listener);
  }

  offAny(listener: TFRobotSocketAnyListener): void {
    this.#anyListeners.delete(listener);
  }

  on(eventName: string, listener: TFRobotSocketListener): void {
    const listeners =
      this.#listeners.get(eventName) ?? new Set<TFRobotSocketListener>();
    listeners.add(listener);
    this.#listeners.set(eventName, listeners);
  }

  onAny(listener: TFRobotSocketAnyListener): void {
    this.#anyListeners.add(listener);
  }

  forceDisconnect(reason = "transport close"): void {
    this.connected = false;
    this.trigger("disconnect", reason);
  }

  acknowledgeNext(value?: unknown): void {
    const acknowledgement = this.pendingAcknowledgements.shift();
    if (acknowledgement === undefined) {
      throw new Error("No current-server acknowledgement is pending");
    }
    acknowledgement(value);
  }

  trigger(eventName: string, payload?: unknown): void {
    for (const listener of this.#listeners.get(eventName) ?? []) {
      listener(payload);
    }
    for (const listener of this.#anyListeners) {
      listener(eventName, payload);
    }
  }

  async #connect(): Promise<void> {
    try {
      this.authentications.push(await this.#input.getAuth());
      this.connected = true;
      this.trigger("connect");
    } catch (reason) {
      this.connected = false;
      this.trigger("connect_error", reason);
    }
  }
}

export const createCurrentServerFixture = (
  options: CurrentServerFixtureOptions = {},
) => {
  const requests: CurrentServerRequestRecord[] = [];
  const sessionRequests: SessionRequest[] = [];
  const invalidations: unknown[] = [];
  const status = [...(options.status ?? [])];
  const history = [...(options.history ?? [])];
  const session = options.session ?? {
    kind: "bearer" as const,
    token: "fixture-session-token",
  };
  let socket: CurrentServerSocket | undefined;

  const sessionProvider: SessionProvider<TFRobotSession> = {
    getSession(request) {
      sessionRequests.push(request);
      return session;
    },
    onSessionInvalid(reason) {
      invalidations.push(reason);
    },
  };
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    requests.push({
      authorization: request.headers.get("Authorization"),
      method: request.method,
      url: request.url,
    });
    const path = new URL(request.url).pathname;
    if (path.endsWith("/status")) {
      return await asResponse(
        status.shift() ?? { working: false, taskId: null },
      );
    }
    if (path.endsWith("/messages")) return await asResponse(history.shift());
    return new Response("Not found", { status: 404 });
  };
  const socketFactory = (input: TFRobotSocketFactoryInput): TFRobotSocket => {
    socket = new CurrentServerSocket(input, options.acknowledgements ?? []);
    return socket;
  };

  return {
    fetch,
    get socket(): CurrentServerSocket {
      if (socket === undefined) throw new Error("Socket was not created");
      return socket;
    },
    invalidations,
    requests,
    sessionProvider,
    sessionRequests,
    socketFactory,
  };
};
