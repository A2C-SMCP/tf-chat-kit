import { io } from "socket.io-client";

import {
  chatErrorSchema,
  chatUpdateSchema,
  createGatewayDeadlineExceededError,
  isGatewayDeadlineExceeded,
  type ChatError,
  type ChatErrorSource,
  type ChatLifecycle,
  type ChatUpdate,
  type GatewayObserver,
  type GatewayRequestOptions,
  type GatewayResult,
  type GatewaySubscription,
  type Run,
  type SessionInvalidationReason,
} from "@turingfocus/chat-protocol";

import { awaitBounded } from "./bounded.js";
import {
  chatErrorEventDtoSchema,
  eventDtoSchema,
  messageDtoSchema,
  socketProtocolErrorDtoSchema,
  stateChangedDtoSchema,
  statusDtoSchema,
} from "./dto.js";
import {
  mapEventUpdate,
  mapMessageUpdate,
  mapRun,
  mapUnknownSocketEvent,
} from "./mapper.js";
import {
  sanitizeCredentialError,
  sanitizeCredentialRaw,
  sanitizeCredentialText,
} from "./redaction.js";
import { isValidTFRobotSession } from "./types.js";
import type { StatusDto } from "./dto.js";
import type {
  TFRobotGatewayOptions,
  TFRobotSession,
  TFRobotSocket,
  TFRobotSocketAuth,
  TFRobotSocketAnyListener,
  TFRobotSocketFactory,
  TFRobotSocketListener,
} from "./types.js";

const KNOWN_EVENTS = new Set([
  "chat_error",
  "chat_event",
  "chat_message",
  "connect",
  "connect_error",
  "conversation_state_changed",
  "disconnect",
  "error",
]);
const MAX_TIMER_DELAY = 2_147_483_647;
const RECONNECT_AUTH_TIMEOUT_MS = 10_000;
const RECONNECT_JOIN_TIMEOUT_MS = 10_000;

interface JoinAcknowledgement {
  readonly accepted: boolean;
  readonly rejectionCode?:
    "authentication" | "authorization" | "validation" | undefined;
  readonly recoveryComplete: boolean;
  readonly cursor?: string | undefined;
  readonly message?: string | undefined;
}

const parseJoinAcknowledgement = (
  value: unknown,
  reconnect: boolean,
): JoinAcknowledgement => {
  if (value === undefined) {
    return {
      accepted: reconnect,
      recoveryComplete: false,
      ...(reconnect ? {} : { rejectionCode: "validation" as const }),
    };
  }
  if (value === null) {
    return {
      accepted: false,
      recoveryComplete: false,
      rejectionCode: "validation",
    };
  }
  if (value === false) {
    return {
      accepted: false,
      recoveryComplete: false,
      rejectionCode: "validation",
    };
  }
  if (value === true) {
    return { accepted: true, recoveryComplete: !reconnect };
  }
  if (typeof value !== "object") {
    return {
      accepted: false,
      recoveryComplete: false,
      rejectionCode: "validation",
    };
  }
  const record = value as Record<string, unknown>;
  const booleanAliases = ["ok", "accepted", "success"] as const;
  const hasInvalidBooleanAlias = booleanAliases.some(
    (alias) =>
      Object.hasOwn(record, alias) && typeof record[alias] !== "boolean",
  );
  const statusAliases = ["status", "statusCode", "code"] as const;
  const hasInvalidStatusAlias = statusAliases.some(
    (alias) => Object.hasOwn(record, alias) && record[alias] === undefined,
  );
  const statuses = [record["status"], record["statusCode"], record["code"]]
    .filter((status) => status !== undefined)
    .map((status) => {
      const numeric =
        typeof status === "number"
          ? status
          : typeof status === "string" && /^\d{3}$/u.test(status)
            ? Number(status)
            : undefined;
      const normalized =
        typeof status === "string" ? status.trim().toLowerCase() : undefined;
      const accepted =
        (numeric !== undefined && numeric >= 200 && numeric < 300) ||
        normalized === "ok" ||
        normalized === "success" ||
        normalized === "accepted" ||
        normalized === "joined";
      const rejected =
        (numeric !== undefined && numeric >= 400) ||
        normalized === "error" ||
        normalized === "failed" ||
        normalized === "forbidden" ||
        normalized === "unauthorized" ||
        normalized === "rejected";
      return { accepted, normalized, numeric, rejected };
    });
  const hasUnknownStatus = statuses.some(
    (status) => !status.accepted && !status.rejected,
  );
  const explicitlyAccepted =
    record["ok"] === true ||
    record["accepted"] === true ||
    record["success"] === true ||
    statuses.some((status) => status.accepted);
  const cursorAliases = ["cursor", "recoveryCursor"] as const;
  const cursorValues = cursorAliases
    .filter((alias) => Object.hasOwn(record, alias))
    .map((alias) => record[alias]);
  const cursorInvalid = cursorValues.some(
    (cursorValue) => typeof cursorValue !== "string",
  );
  const cursorConflict =
    cursorValues.length > 1 &&
    cursorValues.some((cursorValue) => cursorValue !== cursorValues[0]);
  const recoveryAliases = ["recovered", "recoveryComplete"] as const;
  const recoveryDeclarations = recoveryAliases
    .filter((alias) => Object.hasOwn(record, alias))
    .map((alias) => record[alias]);
  const recoveryInvalid = recoveryDeclarations.some(
    (declaration) => typeof declaration !== "boolean",
  );
  const recoveryConflict =
    recoveryDeclarations.includes(true) && recoveryDeclarations.includes(false);
  const normalizedError =
    typeof record["error"] === "string"
      ? record["error"].trim().toLowerCase()
      : undefined;
  const explicitlyRejected =
    hasInvalidBooleanAlias ||
    hasInvalidStatusAlias ||
    record["ok"] === false ||
    record["accepted"] === false ||
    record["success"] === false ||
    record["error"] !== undefined ||
    cursorInvalid ||
    cursorConflict ||
    recoveryInvalid ||
    recoveryConflict ||
    (!reconnect && recoveryDeclarations.includes(false)) ||
    hasUnknownStatus ||
    statuses.some((status) => status.rejected);
  const accepted = explicitlyAccepted && !explicitlyRejected;
  const cursor = cursorValues[0];
  const recoveryComplete =
    !reconnect ||
    (recoveryDeclarations.length > 0 &&
      recoveryDeclarations.every((declaration) => declaration === true));
  const authenticationRejected =
    statuses.some(
      ({ normalized, numeric }) =>
        numeric === 401 || normalized === "unauthorized",
    ) || normalizedError === "unauthorized";
  const authorizationRejected =
    statuses.some(
      ({ normalized, numeric }) =>
        numeric === 403 || normalized === "forbidden",
    ) || normalizedError === "forbidden";
  return {
    accepted,
    ...(authenticationRejected
      ? { rejectionCode: "authentication" as const }
      : authorizationRejected
        ? { rejectionCode: "authorization" as const }
        : accepted
          ? {}
          : { rejectionCode: "validation" as const }),
    recoveryComplete,
    ...(typeof cursor === "string" ? { cursor } : {}),
    ...(typeof record["message"] === "string"
      ? { message: record["message"] }
      : {}),
  };
};

const sameRun = (first: Run | null | undefined, second: Run | null): boolean =>
  first === second ||
  (first != null &&
    second != null &&
    first.id === second.id &&
    first.status === second.status &&
    first.canInterrupt === second.canInterrupt &&
    first.startedAt === second.startedAt);

const socketAuthRejectionCode = (
  reason: unknown,
): "authentication" | "authorization" | undefined => {
  if (reason === null || typeof reason !== "object") return undefined;
  const record = reason as Record<string, unknown>;
  const data =
    record["data"] !== null && typeof record["data"] === "object"
      ? (record["data"] as Record<string, unknown>)
      : undefined;
  const status = data?.["status"] ?? data?.["statusCode"] ?? record["status"];
  if (status === 401 || status === "401") return "authentication";
  if (status === 403 || status === "403") return "authorization";
  const code = String(data?.["code"] ?? record["code"] ?? "").toLowerCase();
  if (code.includes("forbidden") || code.includes("permission")) {
    return "authorization";
  }
  if (
    code.includes("auth") ||
    code.includes("credential") ||
    code.includes("token")
  ) {
    return "authentication";
  }
  const message =
    reason instanceof Error && typeof reason.message === "string"
      ? reason.message.toLowerCase()
      : "";
  if (
    message.includes("connection rejected by server") ||
    message.includes("not authorized") ||
    message.includes("unauthorized") ||
    message.includes("authentication") ||
    message.includes("invalid token") ||
    message.includes("jwt")
  ) {
    return "authentication";
  }
  if (message.includes("forbidden") || message.includes("permission denied")) {
    return "authorization";
  }
  return undefined;
};

const transportConversationId = (payload: unknown): string | undefined => {
  if (payload === null || typeof payload !== "object") return undefined;
  const record = payload as Record<string, unknown>;
  const value = record["conversationId"] ?? record["conversation_id"];
  if (typeof value === "string" && value.trim().length > 0) return value;
  return typeof value === "number" && Number.isFinite(value)
    ? String(value)
    : undefined;
};

const belongsToForeignConversation = (
  payload: unknown,
  conversationId: string,
): boolean => {
  const target = transportConversationId(payload);
  return target !== undefined && target !== conversationId;
};

const authOf = (session: TFRobotSession): TFRobotSocketAuth => {
  const auth: Record<string, string> = {};
  const [field, value] =
    session.kind === "bearer"
      ? ["token", session.token]
      : ["admin_key", session.adminKey];
  Object.defineProperty(auth, field, {
    configurable: false,
    enumerable: true,
    value,
    writable: false,
  });
  return auth;
};

export const createSocketIoFactoryWith =
  (connect: typeof io): TFRobotSocketFactory =>
  ({ getAuth, namespaceUrl, path }) =>
    connect(namespaceUrl, {
      autoConnect: false,
      path,
      reconnection: true,
      transports: ["websocket"],
      auth(callback) {
        void getAuth()
          .then(callback)
          .catch(() => callback({}));
      },
    }) as unknown as TFRobotSocket;

export const createSocketIoFactory = createSocketIoFactoryWith(io);

interface ActiveSubscription {
  acceptingEvents: boolean;
  active: boolean;
  authRequired: boolean;
  readonly cancelEstablishment: () => void;
  readonly cleanup: () => void;
  readonly conversationId: string;
  readonly generation: number;
  manualReconnectAttempted: boolean;
  manualReconnectPending: boolean;
  readonly observer: GatewayObserver;
  reconnectAttempt: number;
  recoveryRevision: number;
  runRevision: number;
  readonly socket: TFRobotSocket;
  readonly subscriptionId: string;
  terminal: boolean;
}

type ReconnectStatusLoader = (
  conversationId: string,
) => Promise<GatewayResult<StatusDto>>;
type RecoveryOutcome =
  "success" | "superseded-by-realtime" | "failure" | "auth-required";

export class TFRobotSocketClient {
  #disposed = false;
  #establishmentAbort: AbortController | undefined;
  #establishing: ActiveSubscription | undefined;
  readonly #factory: TFRobotSocketFactory;
  readonly #namespaceUrl: string;
  readonly #now: () => number;
  readonly #options: TFRobotGatewayOptions;
  readonly #path: string;
  readonly #reconnectStatusLoader: ReconnectStatusLoader;
  readonly #runs = new Map<string, Run | null>();
  readonly #subscriptions = new Set<ActiveSubscription>();
  #subscriptionGeneration = 0;

  constructor(
    options: TFRobotGatewayOptions,
    reconnectStatusLoader: ReconnectStatusLoader,
  ) {
    this.#options = options;
    this.#factory = options.socketFactory ?? createSocketIoFactory;
    this.#path = options.socketPath ?? "/socket.io";
    this.#now = options.now ?? Date.now;
    this.#namespaceUrl =
      options.socketNamespaceUrl ?? this.#defaultNamespaceUrl(options.baseUrl);
    this.#reconnectStatusLoader = reconnectStatusLoader;
  }

  async subscribe(
    conversationId: string,
    options: GatewayRequestOptions,
    observer: GatewayObserver,
  ): Promise<GatewayResult<GatewaySubscription>> {
    if (this.#disposed) {
      return {
        ok: false,
        error: this.#error(
          "conflict",
          "TFRobot Gateway is disposed",
          false,
          undefined,
        ),
      };
    }
    if (isGatewayDeadlineExceeded(options, this.#now())) {
      return {
        ok: false,
        error: createGatewayDeadlineExceededError(),
      };
    }
    const generation = ++this.#subscriptionGeneration;
    const subscriptionId = `tfrobot-subscription-${generation}`;
    this.#cancelEstablishment();
    const establishmentAbort = new AbortController();
    this.#establishmentAbort = establishmentAbort;
    const authOutcome = await awaitBounded(
      () => this.#getSocketAuth(conversationId, "connect"),
      {
        deadlineAt: options.deadlineAt,
        now: this.#now,
        signal: establishmentAbort.signal,
      },
    );
    switch (authOutcome.kind) {
      case "aborted": {
        return {
          ok: false,
          error: this.#error(
            "conflict",
            this.#disposed
              ? "TFRobot Gateway was disposed during subscription"
              : "TFRobot subscription was replaced during authentication",
            false,
            undefined,
          ),
        };
      }
      case "deadline": {
        return {
          ok: false,
          error: createGatewayDeadlineExceededError(),
        };
      }
      case "error": {
        return {
          ok: false,
          error: this.#error(
            "authentication",
            "Unable to obtain a TFRobot Socket session",
            true,
            undefined,
          ),
        };
      }
      case "value": {
        break;
      }
    }
    if (this.#disposed || establishmentAbort.signal.aborted) {
      return {
        ok: false,
        error: this.#error(
          "conflict",
          "TFRobot Gateway was disposed during subscription",
          false,
          undefined,
        ),
      };
    }

    const credentialValues = new Set(Object.values(authOutcome.value));
    const errorConversationId = (): string =>
      sanitizeCredentialText(conversationId, credentialValues);
    let firstAuth: TFRobotSocketAuth | undefined = authOutcome.value;
    let authenticationFailure: unknown;
    const connectionAbort = new AbortController();
    let socket: TFRobotSocket;
    try {
      socket = this.#factory({
        namespaceUrl: this.#namespaceUrl,
        path: this.#path,
        getAuth: async () => {
          if (connectionAbort.signal.aborted) {
            throw new Error("TFRobot Socket session refresh was cancelled");
          }
          if (firstAuth !== undefined) {
            const auth = firstAuth;
            firstAuth = undefined;
            return auth;
          }
          const reconnectAuth = await awaitBounded(
            () => this.#getSocketAuth(conversationId, "reconnect"),
            {
              deadlineAt: this.#now() + RECONNECT_AUTH_TIMEOUT_MS,
              now: this.#now,
              signal: connectionAbort.signal,
            },
          );
          if (reconnectAuth.kind === "value") {
            for (const value of Object.values(reconnectAuth.value)) {
              credentialValues.add(value);
            }
            return reconnectAuth.value;
          }
          const reason =
            reconnectAuth.kind === "error"
              ? reconnectAuth.reason
              : new Error(
                  reconnectAuth.kind === "deadline"
                    ? "TFRobot Socket session refresh exceeded its deadline"
                    : "TFRobot Socket session refresh was cancelled",
                );
          authenticationFailure = reason;
          throw reason;
        },
      });
    } catch (reason) {
      connectionAbort.abort();
      return {
        ok: false,
        error: this.#transportError(
          reason,
          "Unable to create the TFRobot Socket transport",
          conversationId,
          credentialValues,
        ),
      };
    }
    const listeners = new Map<string, TFRobotSocketListener>();
    let joinTimeout: ReturnType<typeof setTimeout> | undefined;
    const activeErrorIds = new Map<ChatErrorSource, string>();
    const replaceableErrorSources = new Set<ChatErrorSource>([
      "authentication",
      "connection",
      "recovery",
      "subscription",
    ]);
    let errorSequence = 0;
    let publishUpdate: GatewayObserver["next"] = () => undefined;
    const pendingNotifications: Array<
      | { readonly kind: "update"; readonly update: ChatUpdate }
      | { readonly kind: "error"; readonly error: ChatError }
    > = [];
    const pendingRealtimeActions: Array<() => void> = [];
    let joinPending = false;
    let subscriptionEstablished = false;
    let setupFailure: { readonly reason: unknown } | undefined;
    const add = (eventName: string, listener: TFRobotSocketListener): void => {
      if (setupFailure !== undefined) return;
      try {
        socket.on(eventName, listener);
        listeners.set(eventName, listener);
      } catch (reason) {
        setupFailure = { reason };
      }
    };
    const diagnose = (error: ChatError): void => {
      try {
        void Promise.resolve(this.#options.onDiagnostic?.(error)).catch(
          () => undefined,
        );
      } catch {
        // Diagnostics are observational and cannot break the chat stream.
      }
    };
    const notifyError = (error: ChatError): void => {
      try {
        observer.error?.(error);
      } catch {
        // Host observers are isolated from the transport listener.
      }
    };
    const resolveError = (source: ChatErrorSource): void => {
      const errorId = activeErrorIds.get(source);
      if (errorId === undefined || !active.active) return;
      activeErrorIds.delete(source);
      publishUpdate(
        chatUpdateSchema.parse({
          kind: "error.resolved",
          conversationId: errorConversationId(),
          errorId,
        }),
      );
    };
    const report = (
      error: ChatError,
      source: ChatErrorSource = "protocol",
    ): void => {
      if (!active.active) return;
      if (replaceableErrorSources.has(source)) resolveError(source);
      const errorId = `${subscriptionId}:error:${++errorSequence}`;
      if (replaceableErrorSources.has(source)) {
        activeErrorIds.set(source, errorId);
      }
      const occurrenceError =
        error.conversationId === undefined
          ? error
          : { ...error, conversationId: errorConversationId() };
      publishUpdate(
        chatUpdateSchema.parse({
          kind: "error.reported",
          conversationId: errorConversationId(),
          error: occurrenceError,
          errorId,
          source,
          scope:
            source === "domain"
              ? { kind: "conversation", id: errorConversationId() }
              : { kind: "subscription", id: subscriptionId },
          generation,
        }),
      );
      if (subscriptionEstablished) notifyError(error);
      else pendingNotifications.push({ kind: "error", error });
      diagnose(error);
    };
    const sanitizePayload = (payload: unknown): unknown => {
      try {
        return sanitizeCredentialRaw(payload, credentialValues);
      } catch {
        return undefined;
      }
    };
    const next = (update: Parameters<GatewayObserver["next"]>[0]): void => {
      if (!active.active) return;
      const updateConversationId =
        update.kind === "snapshot.replace"
          ? update.snapshot.conversation.id
          : update.kind === "conversation.upsert"
            ? update.conversation.id
            : update.conversationId;
      if (
        updateConversationId !== undefined &&
        updateConversationId !== conversationId &&
        updateConversationId !== errorConversationId()
      ) {
        return;
      }
      if (!subscriptionEstablished) {
        pendingNotifications.push({ kind: "update", update });
        return;
      }
      try {
        observer.next(update);
      } catch {
        diagnose(
          this.#error(
            "unknown",
            "TFRobot Gateway observer rejected an update",
            false,
            errorConversationId(),
          ),
        );
      }
    };
    publishUpdate = next;
    const dispatchRealtime = (action: () => void): void => {
      if (active.acceptingEvents) action();
      else if (joinPending) pendingRealtimeActions.push(action);
    };
    const flushRealtime = (): void => {
      for (const action of pendingRealtimeActions.splice(0)) action();
    };
    const lifecycle = (
      status: ChatLifecycle["status"],
      recovery?: ChatLifecycle["recovery"],
      joinLatencyMs?: number,
    ): void => {
      if (!active.active) return;
      const value: ChatLifecycle = {
        status,
        generation,
        reconnectAttempt: active.reconnectAttempt,
        subscriptionId,
        ...(recovery === undefined ? {} : { recovery }),
      };
      const update = chatUpdateSchema.parse({
        kind: "lifecycle.changed",
        conversationId: errorConversationId(),
        lifecycle: value,
      });
      next(update);
      try {
        void Promise.resolve(
          this.#options.onLifecycleDiagnostic?.({
            kind: "socket.lifecycle",
            conversationId: errorConversationId(),
            subscriptionId,
            generation,
            status,
            reconnectAttempt: active.reconnectAttempt,
            ...(joinLatencyMs === undefined ? {} : { joinLatencyMs }),
            ...(recovery === undefined
              ? {}
              : {
                  recoveryComplete: recovery.complete,
                  ...(recovery.cursor === undefined
                    ? {}
                    : { recoveryCursor: recovery.cursor }),
                  ...(recovery.reason === undefined
                    ? {}
                    : { recoveryReason: recovery.reason }),
                }),
          }),
        ).catch(() => undefined);
      } catch {
        // Lifecycle diagnostics are observational.
      }
    };
    const enterAuthRequired = (): void => {
      active.acceptingEvents = false;
      active.authRequired = true;
      active.terminal = true;
      joinPending = false;
      pendingRealtimeActions.length = 0;
      active.recoveryRevision += 1;
      lifecycle("auth-required");
      try {
        active.socket.disconnect();
      } catch {
        // Authentication is already terminal for this subscription episode.
      }
    };
    const mapAndNext = (
      invalidMessage: string,
      map: () => Parameters<GatewayObserver["next"]>[0],
    ): void => {
      let update: Parameters<GatewayObserver["next"]>[0];
      try {
        update = map();
      } catch {
        report(
          this.#error(
            "validation",
            invalidMessage,
            false,
            errorConversationId(),
          ),
        );
        return;
      }
      next(update);
    };
    let settleEstablishment:
      ((result: GatewayResult<GatewaySubscription>) => void) | undefined;
    add("connect", () => {
      if (!active.active) return;
      if (active.terminal) {
        try {
          active.socket.disconnect();
        } catch {
          // Terminal subscriptions never rejoin.
        }
        return;
      }
      if (
        settleEstablishment !== undefined &&
        isGatewayDeadlineExceeded(options, this.#now())
      ) {
        settleEstablishment({
          ok: false,
          error: createGatewayDeadlineExceededError(errorConversationId()),
        });
        return;
      }
      if (joinTimeout !== undefined) {
        clearTimeout(joinTimeout);
        joinTimeout = undefined;
      }
      const reconnect = subscriptionEstablished;
      if (reconnect) active.reconnectAttempt += 1;
      const recoveryRevision = ++active.recoveryRevision;
      const runRevision = active.runRevision;
      const joinStartedAt = this.#now();
      active.acceptingEvents = false;
      joinPending = true;
      pendingRealtimeActions.length = 0;
      lifecycle("joining");
      let acknowledgementSettled = false;
      const settleJoin = (...acknowledgementArguments: unknown[]): void => {
        if (
          !active.active ||
          !this.#subscriptions.has(active) ||
          active.recoveryRevision !== recoveryRevision
        ) {
          return;
        }
        if (acknowledgementSettled) return;
        acknowledgementSettled = true;
        if (joinTimeout !== undefined) {
          clearTimeout(joinTimeout);
          joinTimeout = undefined;
        }
        let acknowledgement: JoinAcknowledgement;
        try {
          const rawAcknowledgement = acknowledgementArguments[0];
          acknowledgement = parseJoinAcknowledgement(
            rawAcknowledgement === undefined || rawAcknowledgement === true
              ? rawAcknowledgement
              : sanitizeCredentialRaw(rawAcknowledgement, credentialValues),
            reconnect,
          );
        } catch {
          acknowledgement = {
            accepted: false,
            recoveryComplete: false,
            rejectionCode: "validation",
            message:
              "Invalid TFRobot conversation subscription acknowledgement",
          };
        }
        if (!acknowledgement.accepted) {
          joinPending = false;
          pendingRealtimeActions.length = 0;
          const rejectionCode = acknowledgement.rejectionCode ?? "validation";
          const error = this.#error(
            rejectionCode,
            acknowledgement.message ??
              "TFRobot conversation subscription was rejected",
            false,
            errorConversationId(),
          );
          if (settleEstablishment !== undefined) {
            lifecycle("subscription-failed");
            if (
              rejectionCode === "authentication" ||
              rejectionCode === "authorization"
            ) {
              void this.#invalidateSession(error, "rejected");
            }
            settleEstablishment({ ok: false, error });
          } else {
            const authenticationRejected =
              rejectionCode === "authentication" ||
              rejectionCode === "authorization";
            if (authenticationRejected) {
              enterAuthRequired();
            } else {
              active.acceptingEvents = false;
              active.terminal = true;
              active.recoveryRevision += 1;
              try {
                active.socket.disconnect();
              } catch {
                // Subscription failure is already terminal for this episode.
              }
              lifecycle("subscription-failed");
            }
            report(
              error,
              authenticationRejected ? "authentication" : "subscription",
            );
            if (authenticationRejected) {
              void this.#invalidateSession(error, "rejected");
            }
          }
          return;
        }
        if (!reconnect) {
          joinPending = false;
          subscriptionEstablished = true;
          for (const notification of pendingNotifications.splice(0)) {
            if (notification.kind === "update") next(notification.update);
            else notifyError(notification.error);
          }
          settleEstablishment?.({
            ok: true,
            value: {
              dispose: () => {
                if (!active.active) return;
                active.active = false;
                active.cleanup();
                this.#subscriptions.delete(active);
              },
            },
          });
          resolveError("connection");
          resolveError("authentication");
          lifecycle(
            "active",
            {
              complete: true,
              ...(acknowledgement.cursor === undefined
                ? {}
                : { cursor: acknowledgement.cursor }),
            },
            this.#now() - joinStartedAt,
          );
          active.acceptingEvents = true;
          flushRealtime();
          return;
        }

        joinPending = false;
        const joinLatencyMs = this.#now() - joinStartedAt;
        lifecycle(
          "recovering",
          {
            complete: false,
            ...(acknowledgement.cursor === undefined
              ? {}
              : { cursor: acknowledgement.cursor }),
            ...(acknowledgement.recoveryComplete
              ? {}
              : { reason: "server-replay-contract-unavailable" }),
          },
          joinLatencyMs,
        );
        active.acceptingEvents = true;
        flushRealtime();
        void this.#reconcileRunAfterReconnect(
          active,
          conversationId,
          credentialValues,
          recoveryRevision,
          runRevision,
          next,
          report,
        )
          .then((outcome) => {
            if (outcome === "auth-required") {
              enterAuthRequired();
              return;
            }
            if (
              (outcome !== "success" && outcome !== "superseded-by-realtime") ||
              !acknowledgement.recoveryComplete
            ) {
              return;
            }
            resolveError("connection");
            resolveError("recovery");
            resolveError("authentication");
            active.manualReconnectAttempted = false;
            active.manualReconnectPending = false;
            active.authRequired = false;
            active.terminal = false;
            lifecycle(
              "active",
              {
                complete: true,
                ...(acknowledgement.cursor === undefined
                  ? {}
                  : { cursor: acknowledgement.cursor }),
              },
              joinLatencyMs,
            );
          })
          .catch(() => {
            active.acceptingEvents = false;
            active.terminal = true;
            try {
              active.socket.disconnect();
            } catch {
              // Offline is already terminal for this subscription episode.
            }
            lifecycle("offline");
            report(
              this.#error(
                "unknown",
                "TFRobot reconnect reconciliation failed",
                true,
                errorConversationId(),
              ),
              "recovery",
            );
          });
      };
      const joinDeadlineAt = reconnect
        ? this.#now() + RECONNECT_JOIN_TIMEOUT_MS
        : options.deadlineAt;
      joinTimeout = setTimeout(
        () => {
          joinTimeout = undefined;
          if (!active.active || active.recoveryRevision !== recoveryRevision) {
            return;
          }
          active.recoveryRevision += 1;
          joinPending = false;
          pendingRealtimeActions.length = 0;
          const error = createGatewayDeadlineExceededError(
            errorConversationId(),
          );
          if (settleEstablishment !== undefined) {
            lifecycle("subscription-failed");
            settleEstablishment({ ok: false, error });
          } else {
            if (active.manualReconnectPending) enterAuthRequired();
            else {
              active.acceptingEvents = false;
              active.terminal = true;
              lifecycle("subscription-failed");
            }
            report(
              error,
              active.manualReconnectPending ? "connection" : "subscription",
            );
            try {
              active.socket.disconnect();
            } catch {
              // The failed join attempt is already invalidated.
            }
          }
        },
        Math.min(MAX_TIMER_DELAY, Math.max(0, joinDeadlineAt - this.#now())),
      );
      try {
        socket.emit(
          "join_conversation",
          { conversation_id: conversationId },
          settleJoin,
        );
      } catch (reason) {
        const error = this.#transportError(
          reason,
          "Unable to join the TFRobot conversation",
          conversationId,
          credentialValues,
        );
        if (settleEstablishment !== undefined) {
          settleEstablishment({ ok: false, error });
        } else {
          report(error, "subscription");
          active.active = false;
          active.cleanup();
          this.#subscriptions.delete(active);
        }
        return;
      }
    });
    add("chat_message", (payload) => {
      dispatchRealtime(() => {
        if (belongsToForeignConversation(payload, conversationId)) return;
        const parsed = messageDtoSchema.safeParse(sanitizePayload(payload));
        if (!parsed.success) {
          report(
            this.#error(
              "validation",
              "Invalid TFRobot chat_message payload",
              false,
              errorConversationId(),
            ),
          );
          return;
        }
        mapAndNext("TFRobot chat_message could not be normalized", () =>
          mapMessageUpdate(parsed.data),
        );
      });
    });
    add("chat_event", (payload) => {
      dispatchRealtime(() => {
        if (belongsToForeignConversation(payload, conversationId)) return;
        const parsed = eventDtoSchema.safeParse(sanitizePayload(payload));
        if (!parsed.success) {
          report(
            this.#error(
              "validation",
              "Invalid TFRobot chat_event payload",
              false,
              errorConversationId(),
            ),
          );
          return;
        }
        mapAndNext("TFRobot chat_event could not be normalized", () =>
          mapEventUpdate(parsed.data),
        );
      });
    });
    add("conversation_state_changed", (payload) => {
      dispatchRealtime(() => {
        if (belongsToForeignConversation(payload, conversationId)) return;
        const parsed = stateChangedDtoSchema.safeParse(
          sanitizePayload(payload),
        );
        if (!parsed.success) {
          report(
            this.#error(
              "validation",
              "Invalid TFRobot conversation_state_changed payload",
              false,
              errorConversationId(),
            ),
          );
          return;
        }
        const targetConversationId = String(parsed.data.conversationId);
        if (
          targetConversationId !== conversationId &&
          targetConversationId !== errorConversationId()
        ) {
          return;
        }
        active.runRevision += 1;
        mapAndNext("TFRobot run state could not be normalized", () => {
          const run = mapRun(targetConversationId, {
            working: parsed.data.state === "working",
            taskId: parsed.data.taskId,
          });
          this.#runs.set(targetConversationId, run);
          return chatUpdateSchema.parse({
            kind: "run.replace",
            conversationId: targetConversationId,
            run,
          });
        });
      });
    });
    add("chat_error", (payload) => {
      dispatchRealtime(() => {
        if (belongsToForeignConversation(payload, conversationId)) return;
        const parsed = chatErrorEventDtoSchema.safeParse(
          sanitizePayload(payload),
        );
        if (!parsed.success) {
          report(
            this.#error(
              "validation",
              "Invalid TFRobot chat_error payload",
              false,
              errorConversationId(),
            ),
          );
          return;
        }
        const targetConversationId = String(parsed.data.conversationId);
        if (
          targetConversationId !== conversationId &&
          targetConversationId !== errorConversationId()
        ) {
          return;
        }
        report(
          this.#error(
            "server",
            typeof parsed.data.error === "string"
              ? parsed.data.error
              : "TFRobot run failed",
            false,
            targetConversationId,
            parsed.data,
            credentialValues,
          ),
          "domain",
        );
      });
    });
    add("error", (payload) => {
      dispatchRealtime(() => {
        const parsed = socketProtocolErrorDtoSchema.safeParse(
          sanitizePayload(payload),
        );
        report(
          this.#error(
            "validation",
            parsed.success && typeof parsed.data.message === "string"
              ? parsed.data.message
              : "TFRobot Socket protocol error",
            false,
            conversationId,
            undefined,
            credentialValues,
          ),
        );
      });
    });
    add("connect_error", (reason) => {
      if (!active.active || active.terminal) return;
      const injectedError = chatErrorSchema.safeParse(reason);
      const rejectionCode = socketAuthRejectionCode(reason);
      const error =
        authenticationFailure !== undefined
          ? this.#error(
              "authentication",
              "Unable to refresh the TFRobot Socket session",
              true,
              conversationId,
              undefined,
              credentialValues,
            )
          : injectedError.success
            ? sanitizeCredentialError(injectedError.data, credentialValues)
            : rejectionCode !== undefined
              ? this.#error(
                  rejectionCode,
                  reason instanceof Error
                    ? reason.message
                    : "TFRobot Socket rejected the session",
                  false,
                  conversationId,
                  undefined,
                  credentialValues,
                )
              : this.#error(
                  "network",
                  reason instanceof Error
                    ? reason.message
                    : "TFRobot Socket connection failed",
                  true,
                  conversationId,
                  undefined,
                  credentialValues,
                );
      authenticationFailure = undefined;
      if (error.code === "authentication" || error.code === "authorization") {
        void this.#invalidateSession(
          error,
          rejectionCode === undefined ? undefined : "rejected",
        );
      }
      if (settleEstablishment !== undefined) {
        settleEstablishment({ ok: false, error });
        return;
      }
      if (active.manualReconnectPending) {
        enterAuthRequired();
        report(
          error,
          error.code === "authentication" || error.code === "authorization"
            ? "authentication"
            : "connection",
        );
        return;
      }
      if (error.code === "authentication" || error.code === "authorization") {
        enterAuthRequired();
      }
      report(
        error,
        error.code === "authentication" || error.code === "authorization"
          ? "authentication"
          : "connection",
      );
    });
    add("disconnect", (reason) => {
      if (reason === "io client disconnect") return;
      if (active.terminal) return;
      active.acceptingEvents = false;
      joinPending = false;
      pendingRealtimeActions.length = 0;
      if (joinTimeout !== undefined) {
        clearTimeout(joinTimeout);
        joinTimeout = undefined;
      }
      active.recoveryRevision += 1;
      lifecycle("reconnecting");
      const injectedError = chatErrorSchema.safeParse(reason);
      report(
        injectedError.success
          ? sanitizeCredentialError(injectedError.data, credentialValues)
          : this.#error(
              "network",
              `TFRobot Socket disconnected: ${String(reason)}`,
              true,
              conversationId,
              undefined,
              credentialValues,
            ),
        "connection",
      );
      if (reason !== "io server disconnect") return;
      if (active.manualReconnectAttempted) {
        enterAuthRequired();
        return;
      }
      active.manualReconnectAttempted = true;
      active.manualReconnectPending = true;
      const invalidationRevision = active.recoveryRevision;
      const invalidationError = this.#error(
        "authentication",
        "TFRobot Socket session was invalidated by the server",
        true,
        errorConversationId(),
      );
      void awaitBounded(
        () => this.#invalidateSession(invalidationError, "unknown"),
        {
          deadlineAt: this.#now() + RECONNECT_AUTH_TIMEOUT_MS,
          now: this.#now,
          signal: connectionAbort.signal,
        },
      ).then((outcome) => {
        if (
          !active.active ||
          active.socket.connected ||
          active.authRequired ||
          !active.manualReconnectPending ||
          active.recoveryRevision !== invalidationRevision
        ) {
          return;
        }
        if (outcome.kind !== "value" || !outcome.value) {
          report(
            this.#error(
              "authentication",
              "Unable to invalidate the TFRobot Socket session",
              false,
              errorConversationId(),
            ),
            "authentication",
          );
          enterAuthRequired();
          return;
        }
        try {
          active.socket.connect();
        } catch (reconnectError) {
          report(
            this.#transportError(
              reconnectError,
              "Unable to reconnect the TFRobot Socket transport",
              conversationId,
              credentialValues,
            ),
            "authentication",
          );
          enterAuthRequired();
        }
      });
    });
    const anyListener: TFRobotSocketAnyListener = (
      eventName,
      payload,
    ): void => {
      dispatchRealtime(() => {
        if (KNOWN_EVENTS.has(eventName)) return;
        if (belongsToForeignConversation(payload, conversationId)) return;
        mapAndNext("Unknown TFRobot Socket event could not be normalized", () =>
          mapUnknownSocketEvent(
            sanitizeCredentialText(eventName, credentialValues),
            sanitizePayload(payload),
            errorConversationId(),
            this.#now(),
          ),
        );
      });
    };
    if (setupFailure === undefined) {
      try {
        socket.onAny?.(anyListener);
      } catch (reason) {
        setupFailure = { reason };
      }
    }
    const cleanup = (): void => {
      connectionAbort.abort();
      if (joinTimeout !== undefined) {
        clearTimeout(joinTimeout);
        joinTimeout = undefined;
      }
      for (const [eventName, listener] of listeners) {
        try {
          socket.off(eventName, listener);
        } catch {
          // Continue releasing every transport resource best-effort.
        }
      }
      try {
        socket.offAny?.(anyListener);
      } catch {
        // Continue to the transport disconnect.
      }
      try {
        socket.disconnect();
      } catch {
        // Adapter ownership is cleared even if an injected transport misbehaves.
      }
      firstAuth = undefined;
      credentialValues.clear();
      pendingNotifications.length = 0;
      pendingRealtimeActions.length = 0;
    };
    if (setupFailure !== undefined) {
      const error = this.#transportError(
        setupFailure.reason,
        "Unable to configure the TFRobot Socket transport",
        conversationId,
        credentialValues,
      );
      cleanup();
      return {
        ok: false,
        error,
      };
    }
    const active: ActiveSubscription = {
      acceptingEvents: true,
      active: true,
      authRequired: false,
      cancelEstablishment: () => {
        settleEstablishment?.({
          ok: false,
          error: this.#error(
            "conflict",
            "TFRobot Gateway was disposed during subscription",
            false,
            errorConversationId(),
          ),
        });
      },
      cleanup,
      conversationId,
      generation,
      manualReconnectAttempted: false,
      manualReconnectPending: false,
      observer,
      reconnectAttempt: 0,
      recoveryRevision: 0,
      runRevision: 0,
      socket,
      subscriptionId,
      terminal: false,
    };
    this.#subscriptions.add(active);
    this.#establishing = active;
    return new Promise((resolve) => {
      let settled = false;
      const settle = (result: GatewayResult<GatewaySubscription>): void => {
        if (settled) return;
        settled = true;
        settleEstablishment = undefined;
        if (this.#establishmentAbort === establishmentAbort) {
          this.#establishmentAbort = undefined;
        }
        if (this.#establishing === active) this.#establishing = undefined;
        clearTimeout(timeout);
        if (!result.ok) {
          active.active = false;
          active.cleanup();
          this.#subscriptions.delete(active);
        }
        resolve(result);
      };
      settleEstablishment = settle;
      const timeout = setTimeout(
        () => {
          settle({
            ok: false,
            error: createGatewayDeadlineExceededError(errorConversationId()),
          });
        },
        Math.min(
          MAX_TIMER_DELAY,
          Math.max(0, options.deadlineAt - this.#now()),
        ),
      );
      if (isGatewayDeadlineExceeded(options, this.#now())) {
        settle({
          ok: false,
          error: createGatewayDeadlineExceededError(errorConversationId()),
        });
        return;
      }
      try {
        lifecycle("connecting");
        socket.connect();
      } catch (reason) {
        settle({
          ok: false,
          error: this.#transportError(
            reason,
            "Unable to connect the TFRobot Socket transport",
            conversationId,
            credentialValues,
          ),
        });
        return;
      }
      if (isGatewayDeadlineExceeded(options, this.#now())) {
        settle({
          ok: false,
          error: createGatewayDeadlineExceededError(errorConversationId()),
        });
      }
    });
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#cancelEstablishment();
    for (const subscription of this.#subscriptions) {
      subscription.active = false;
      subscription.cleanup();
    }
    this.#subscriptions.clear();
    this.#runs.clear();
  }

  rememberRun(conversationId: string, run: Run | null): void {
    if (this.#disposed) return;
    this.#runs.set(conversationId, run);
  }

  #cancelEstablishment(): void {
    this.#establishmentAbort?.abort();
    this.#establishmentAbort = undefined;
    this.#establishing?.cancelEstablishment();
    this.#establishing = undefined;
  }

  #defaultNamespaceUrl(baseUrl: string): string {
    const url = new URL(baseUrl);
    url.pathname = "/chat";
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/u, "");
  }

  async #getSocketAuth(
    conversationId: string,
    purpose: "connect" | "reconnect",
  ) {
    const session = await this.#options.sessionProvider.getSession({
      purpose,
      operation: "subscribe",
      conversationId,
    });
    if (!isValidTFRobotSession(session)) {
      throw new TypeError(
        "SessionProvider returned invalid TFRobot credentials",
      );
    }
    return authOf(session);
  }

  async #reconcileRunAfterReconnect(
    active: ActiveSubscription,
    conversationId: string,
    credentialValues: Iterable<string>,
    recoveryRevision: number,
    runRevision: number,
    next: GatewayObserver["next"],
    report: (error: ChatError, source: ChatErrorSource) => void,
  ): Promise<RecoveryOutcome> {
    const result = await this.#reconnectStatusLoader(conversationId);
    if (
      !active.active ||
      !this.#subscriptions.has(active) ||
      !active.socket.connected ||
      active.recoveryRevision !== recoveryRevision
    ) {
      return "failure";
    }
    if (!result.ok) {
      const error = sanitizeCredentialError(result.error, credentialValues);
      if (error.code === "authentication" || error.code === "authorization") {
        report(error, "authentication");
        return "auth-required";
      }
      if (active.runRevision !== runRevision) {
        return "superseded-by-realtime";
      }
      report(error, "recovery");
      return "failure";
    }
    if (active.runRevision !== runRevision) {
      return "superseded-by-realtime";
    }
    try {
      const updateConversationId = sanitizeCredentialText(
        conversationId,
        credentialValues,
      );
      const safeStatus = statusDtoSchema.parse(
        sanitizeCredentialRaw(result.value, credentialValues),
      );
      const run = mapRun(updateConversationId, safeStatus);
      const previous = this.#runs.get(conversationId);
      this.#runs.set(conversationId, run);
      if (!sameRun(previous, run)) {
        next(
          chatUpdateSchema.parse({
            kind: "run.replace",
            conversationId: updateConversationId,
            run,
          }),
        );
      }
      return "success";
    } catch {
      report(
        this.#error(
          "validation",
          "Reconnected TFRobot run status could not be normalized",
          false,
          conversationId,
          undefined,
          credentialValues,
        ),
        "recovery",
      );
      return "failure";
    }
  }

  async #invalidateSession(
    error: ChatError,
    reason?: SessionInvalidationReason,
  ): Promise<boolean> {
    try {
      await this.#options.sessionProvider.onSessionInvalid?.({
        reason:
          reason ?? (error.code === "authorization" ? "forbidden" : "expired"),
        error,
      });
      return true;
    } catch {
      return false;
    }
  }

  #transportError(
    reason: unknown,
    fallback: string,
    conversationId: string,
    credentialValues: Iterable<string> = [],
  ): ChatError {
    return this.#error(
      "network",
      reason instanceof Error ? reason.message : fallback,
      true,
      conversationId,
      undefined,
      credentialValues,
    );
  }

  #error(
    code: ChatError["code"],
    message: string,
    retryable: boolean,
    conversationId?: string,
    details?: unknown,
    credentialValues: Iterable<string> = [],
  ): ChatError {
    let safeDetails: ReturnType<typeof sanitizeCredentialRaw> | undefined;
    try {
      safeDetails =
        details === undefined
          ? undefined
          : sanitizeCredentialRaw(details, credentialValues);
    } catch {
      safeDetails = undefined;
    }
    return chatErrorSchema.parse({
      code,
      message: sanitizeCredentialText(message, credentialValues),
      retryable,
      ...(conversationId === undefined
        ? {}
        : {
            conversationId: sanitizeCredentialText(
              conversationId,
              credentialValues,
            ),
          }),
      ...(safeDetails === undefined ? {} : { details: safeDetails }),
    });
  }
}
