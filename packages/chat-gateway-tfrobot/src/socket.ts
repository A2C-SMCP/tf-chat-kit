import { io } from "socket.io-client";

import {
  chatErrorSchema,
  chatUpdateSchema,
  createGatewayDeadlineExceededError,
  isGatewayDeadlineExceeded,
  type ChatError,
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
  active: boolean;
  readonly cancelEstablishment: () => void;
  readonly cleanup: () => void;
  readonly conversationId: string;
  readonly observer: GatewayObserver;
  recoveryRevision: number;
  readonly socket: TFRobotSocket;
}

type ReconnectStatusLoader = (
  conversationId: string,
) => Promise<GatewayResult<StatusDto>>;

export class TFRobotSocketClient {
  #active: ActiveSubscription | undefined;
  #disposed = false;
  #establishmentAbort: AbortController | undefined;
  readonly #factory: TFRobotSocketFactory;
  readonly #namespaceUrl: string;
  readonly #now: () => number;
  readonly #options: TFRobotGatewayOptions;
  readonly #path: string;
  readonly #reconnectStatusLoader: ReconnectStatusLoader;
  readonly #runs = new Map<string, Run | null>();

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
    this.#deactivateCurrent();
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
    if (this.#establishmentAbort === establishmentAbort) {
      this.#establishmentAbort = undefined;
    }
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
    const report = (error: ChatError): void => {
      if (!active.active) return;
      try {
        observer.error?.(error);
      } catch {
        // Host observers are isolated from the transport listener.
      }
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
    let connectedOnce = false;
    add("connect", () => {
      if (!active.active) return;
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
      const reconnect = connectedOnce;
      connectedOnce = true;
      const recoveryRevision = ++active.recoveryRevision;
      try {
        socket.emit("join_conversation", {
          conversation_id: conversationId,
        });
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
          report(error);
          active.active = false;
          active.cleanup();
          if (this.#active === active) this.#active = undefined;
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
      settleEstablishment?.({
        ok: true,
        value: {
          dispose: () => {
            if (!active.active) return;
            active.active = false;
            active.cleanup();
            if (this.#active === active) this.#active = undefined;
          },
        },
      });
      if (reconnect) {
        void this.#reconcileRunAfterReconnect(
          active,
          conversationId,
          credentialValues,
          recoveryRevision,
          next,
          report,
        ).catch(() => {
          report(
            this.#error(
              "unknown",
              "TFRobot reconnect reconciliation failed",
              true,
              errorConversationId(),
            ),
          );
        });
      }
    });
    add("chat_message", (payload) => {
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
    add("chat_event", (payload) => {
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
    add("conversation_state_changed", (payload) => {
      if (belongsToForeignConversation(payload, conversationId)) return;
      const parsed = stateChangedDtoSchema.safeParse(sanitizePayload(payload));
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
      active.recoveryRevision += 1;
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
    add("chat_error", (payload) => {
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
      );
    });
    add("error", (payload) => {
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
    add("connect_error", (reason) => {
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
      report(error);
    });
    add("disconnect", (reason) => {
      if (reason === "io client disconnect") return;
      active.recoveryRevision += 1;
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
      );
    });
    const anyListener: TFRobotSocketAnyListener = (
      eventName,
      payload,
    ): void => {
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
      active: true,
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
      observer,
      recoveryRevision: 0,
      socket,
    };
    this.#active = active;
    return new Promise((resolve) => {
      let settled = false;
      const settle = (result: GatewayResult<GatewaySubscription>): void => {
        if (settled) return;
        settled = true;
        settleEstablishment = undefined;
        clearTimeout(timeout);
        if (!result.ok) {
          active.active = false;
          active.cleanup();
          if (this.#active === active) this.#active = undefined;
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
    this.#deactivateCurrent();
    this.#runs.clear();
  }

  rememberRun(conversationId: string, run: Run | null): void {
    if (this.#disposed) return;
    this.#runs.set(conversationId, run);
  }

  #deactivateCurrent(): void {
    this.#establishmentAbort?.abort();
    this.#establishmentAbort = undefined;
    const current = this.#active;
    if (current === undefined) return;
    current.cancelEstablishment();
    current.active = false;
    current.cleanup();
    this.#active = undefined;
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
    next: GatewayObserver["next"],
    report: (error: ChatError) => void,
  ): Promise<void> {
    const result = await this.#reconnectStatusLoader(conversationId);
    if (
      !active.active ||
      this.#active !== active ||
      !active.socket.connected ||
      active.recoveryRevision !== recoveryRevision
    ) {
      return;
    }
    if (!result.ok) {
      report(sanitizeCredentialError(result.error, credentialValues));
      return;
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
      if (sameRun(previous, run)) return;
      next(
        chatUpdateSchema.parse({
          kind: "run.replace",
          conversationId: updateConversationId,
          run,
        }),
      );
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
      );
    }
  }

  async #invalidateSession(
    error: ChatError,
    reason?: SessionInvalidationReason,
  ): Promise<void> {
    try {
      await this.#options.sessionProvider.onSessionInvalid?.({
        reason:
          reason ?? (error.code === "authorization" ? "forbidden" : "expired"),
        error,
      });
    } catch {
      // Host refresh/login failures must not replace the Socket error.
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
