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
  readonly recoveryAssurance?: "best-effort" | "verified" | undefined;
  readonly recoveryCursor?: string | undefined;
  readonly recoveryReason?: string | undefined;
  readonly recoverySource?: "rest-rebase" | "server-replay" | undefined;
}

export interface TFRobotSocketFactoryInput {
  readonly getAuth: () => Promise<TFRobotSocketAuth>;
  readonly namespaceUrl: string;
  readonly path: string;
}

export type TFRobotSocketFactory = (
  input: TFRobotSocketFactoryInput,
) => TFRobotSocket;

export interface TFRobotCurrentServerRebaseOptions {
  /** Maximum history items accepted across all pages. Defaults to 500. */
  readonly maxItems?: number | undefined;
  /** Maximum history requests per reconnect. Defaults to 10. */
  readonly maxPages?: number | undefined;
  /** REST rebase budget in milliseconds. Defaults to 10 seconds. */
  readonly deadlineMs?: number | undefined;
  /** Requested messages per history page. Defaults to 50; maximum 100. */
  readonly pageSize?: number | undefined;
}

export type TFRobotServerProfile =
  | { readonly kind: "verified" }
  | {
      readonly kind: "current-server";
      readonly rebase?: TFRobotCurrentServerRebaseOptions | undefined;
    };

export interface ResolvedTFRobotCurrentServerRebaseOptions {
  readonly deadlineMs: number;
  readonly maxItems: number;
  readonly maxPages: number;
  readonly pageSize: number;
}

export type ResolvedTFRobotServerProfile =
  | { readonly kind: "verified" }
  | {
      readonly kind: "current-server";
      readonly rebase: ResolvedTFRobotCurrentServerRebaseOptions;
    };

const positiveInteger = (
  value: number | undefined,
  fallback: number,
  maximum: number,
  label: string,
): number => {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved <= 0 || resolved > maximum) {
    throw new TypeError(`${label} must be a positive integer up to ${maximum}`);
  }
  return resolved;
};

export function resolveTFRobotServerProfile(
  value: TFRobotServerProfile | undefined,
): ResolvedTFRobotServerProfile {
  if (value === undefined) {
    return Object.freeze({ kind: "verified" });
  }
  if (
    value === null ||
    typeof value !== "object" ||
    !("kind" in value) ||
    (value.kind !== "verified" && value.kind !== "current-server")
  ) {
    throw new TypeError(
      'TFRobot serverProfile.kind must be "verified" or "current-server"',
    );
  }
  if (value.kind === "verified") return Object.freeze({ kind: "verified" });
  return Object.freeze({
    kind: "current-server",
    rebase: Object.freeze({
      deadlineMs: positiveInteger(
        value.rebase?.deadlineMs,
        10_000,
        60_000,
        "current-server rebase deadlineMs",
      ),
      maxItems: positiveInteger(
        value.rebase?.maxItems,
        500,
        10_000,
        "current-server rebase maxItems",
      ),
      maxPages: positiveInteger(
        value.rebase?.maxPages,
        10,
        100,
        "current-server rebase maxPages",
      ),
      pageSize: positiveInteger(
        value.rebase?.pageSize,
        50,
        100,
        "current-server rebase pageSize",
      ),
    }),
  });
}

export interface TFRobotGatewayOptions {
  /** Direct TFRobotServer or host BFF base URL, including any route prefix. */
  readonly baseUrl: string;
  readonly messageCreatorProvider: TFRobotMessageCreatorProvider;
  readonly sessionProvider: SessionProvider<TFRobotSession>;
  /** Defaults to strict, replay-verified Server semantics. */
  readonly serverProfile?: TFRobotServerProfile | undefined;
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
