import type {
  ChatError,
  ChatLifecycleStatus,
  MaybePromise,
  SessionProvider,
} from "@turingfocus/chat-protocol";

export type TFRobotSession =
  | {
      readonly kind: "admin";
      readonly adminKey: string;
    }
  | {
      readonly kind: "bearer";
      readonly token: string;
    };

export interface TFRobotMessageCreator {
  readonly avatar?: string | null | undefined;
  readonly name: string;
  readonly uid: number | string;
}

export interface TFRobotMessageCreatorRequest {
  readonly conversationId: string;
}

/**
 * Resolves the current host user for TFRobotServer's required outbound
 * `creator` field. Keeping this separate from SessionProvider prevents the
 * adapter from decoding credentials or retaining host identity state.
 */
export type TFRobotMessageCreatorProvider = (
  request: TFRobotMessageCreatorRequest,
) => MaybePromise<TFRobotMessageCreator>;

export const isValidTFRobotSession = (
  value: unknown,
): value is TFRobotSession => {
  if (value === null || typeof value !== "object") return false;
  const session = value as Record<string, unknown>;
  return session["kind"] === "bearer"
    ? typeof session["token"] === "string" && session["token"].trim().length > 0
    : session["kind"] === "admin" &&
        typeof session["adminKey"] === "string" &&
        session["adminKey"].trim().length > 0;
};

export interface TFRobotSocketAuth {
  readonly admin_key?: string | undefined;
  readonly token?: string | undefined;
}

export type TFRobotSocketListener = (...arguments_: unknown[]) => void;
export type TFRobotSocketAnyListener = (
  eventName: string,
  ...arguments_: unknown[]
) => void;

/**
 * The narrow Socket.IO surface owned by the adapter. It is public so tests and
 * non-browser hosts can inject a transport without exposing Socket.IO to the
 * normalized Runtime contract.
 */
export interface TFRobotSocket {
  readonly connected: boolean;
  connect(): void;
  disconnect(): void;
  emit(eventName: string, ...arguments_: unknown[]): unknown;
  off(eventName: string, listener: TFRobotSocketListener): unknown;
  offAny?(listener: TFRobotSocketAnyListener): unknown;
  on(eventName: string, listener: TFRobotSocketListener): unknown;
  onAny?(listener: TFRobotSocketAnyListener): unknown;
}

export interface TFRobotLifecycleDiagnostic {
  readonly kind: "socket.lifecycle";
  readonly conversationId: string;
  readonly subscriptionId: string;
  readonly generation: number;
  readonly status: ChatLifecycleStatus;
  readonly reconnectAttempt: number;
  readonly joinLatencyMs?: number | undefined;
  readonly recoveryComplete?: boolean | undefined;
  readonly recoveryCursor?: string | undefined;
  readonly recoveryReason?: string | undefined;
}

export interface TFRobotSocketFactoryInput {
  readonly getAuth: () => Promise<TFRobotSocketAuth>;
  readonly namespaceUrl: string;
  readonly path: string;
}

export type TFRobotSocketFactory = (
  input: TFRobotSocketFactoryInput,
) => TFRobotSocket;

export interface TFRobotGatewayOptions {
  /** Direct TFRobotServer or host BFF base URL, including any route prefix. */
  readonly baseUrl: string;
  readonly messageCreatorProvider: TFRobotMessageCreatorProvider;
  readonly sessionProvider: SessionProvider<TFRobotSession>;
  /** Optional fixed platform filter for conversation discovery. */
  readonly platformId?: number | string | undefined;
  /** Defaults to the origin of baseUrl plus the `/chat` namespace. */
  readonly socketNamespaceUrl?: string | undefined;
  /** Defaults to `/socket.io`. */
  readonly socketPath?: string | undefined;
  readonly fetch?: typeof globalThis.fetch | undefined;
  readonly socketFactory?: TFRobotSocketFactory | undefined;
  /** Test seam for deterministic deadline handling. */
  readonly now?: (() => number) | undefined;
  /**
   * Optional diagnostic sink. Values are already structured and sanitized;
   * credentials, headers and raw Session values are never supplied.
   */
  readonly onDiagnostic?:
    ((error: ChatError) => MaybePromise<void>) | undefined;
  /** Sanitized lifecycle telemetry; credentials and raw payloads are excluded. */
  readonly onLifecycleDiagnostic?:
    | ((diagnostic: TFRobotLifecycleDiagnostic) => MaybePromise<void>)
    | undefined;
}
