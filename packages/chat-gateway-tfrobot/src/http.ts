import {
  chatErrorSchema,
  createGatewayDeadlineExceededError,
  isGatewayDeadlineExceeded,
  type ChatError,
  type GatewayRequestOptions,
  type GatewayResult,
  type SessionOperation,
  type SessionRequest,
} from "@turingfocus/chat-protocol";
import type { z } from "zod/v4";

import { awaitBounded } from "./bounded.js";
import { responseEnvelopeSchema } from "./dto.js";
import {
  sanitizeCredentialError,
  sanitizeCredentialRaw,
  sanitizeCredentialText,
} from "./redaction.js";
import { isValidTFRobotSession } from "./types.js";
import type { TFRobotGatewayOptions, TFRobotSession } from "./types.js";

const HTTP_TIMEOUT_STATUS = 408;
const MAX_TIMER_DELAY = 2_147_483_647;

const sessionHeaders = (session: TFRobotSession): Headers => {
  const headers = new Headers({ Accept: "application/json" });
  if (session.kind === "bearer") {
    headers.set("Authorization", `Bearer ${session.token}`);
  } else {
    headers.set("admin_key", session.adminKey);
  }
  return headers;
};

const statusErrorCode = (status: number): ChatError["code"] => {
  if (status === 401) return "authentication";
  if (status === 403) return "authorization";
  if (status === 404) return "not-found";
  if (status === 409) return "conflict";
  if (status === 422) return "validation";
  if (status >= 500) return "server";
  return "unknown";
};

const isRetryableStatus = (status: number): boolean =>
  status === HTTP_TIMEOUT_STATUS || status === 429 || status >= 500;

const safeDetails = (
  value: unknown,
  credentialValues: Iterable<string>,
): {
  readonly details?: ReturnType<typeof sanitizeCredentialRaw> | undefined;
} => {
  try {
    return { details: sanitizeCredentialRaw(value, credentialValues) };
  } catch {
    return {};
  }
};

const responseMessage = (
  payload: unknown,
  fallback: string,
  credentialValues: Iterable<string>,
): string => {
  if (typeof payload === "string") {
    return sanitizeCredentialText(payload, credentialValues);
  }
  if (payload !== null && typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    if (typeof record["detail"] === "string") {
      return sanitizeCredentialText(record["detail"], credentialValues);
    }
    if (typeof record["message"] === "string") {
      return sanitizeCredentialText(record["message"], credentialValues);
    }
  }
  return fallback;
};

interface RequestInput<T> {
  readonly body?: unknown;
  readonly conversationId?: string | undefined;
  readonly method: "GET" | "POST";
  readonly operation: SessionOperation;
  readonly options: GatewayRequestOptions;
  readonly path: string;
  readonly query?: Readonly<Record<string, number | string | undefined>>;
  readonly schema: z.ZodType<T>;
}

export class TFRobotHttpClient {
  readonly #baseUrl: URL;
  readonly #fetch: typeof globalThis.fetch;
  readonly #inFlight = new Set<AbortController>();
  readonly #now: () => number;
  readonly #options: TFRobotGatewayOptions;
  #disposed = false;

  constructor(options: TFRobotGatewayOptions) {
    this.#options = options;
    this.#baseUrl = new URL(
      options.baseUrl.endsWith("/") ? options.baseUrl : `${options.baseUrl}/`,
    );
    this.#fetch =
      options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.#now = options.now ?? Date.now;
  }

  async request<T>(input: RequestInput<T>): Promise<GatewayResult<T>> {
    if (this.#disposed) {
      return {
        ok: false,
        error: chatErrorSchema.parse({
          code: "conflict",
          message: "TFRobot Gateway is disposed",
          retryable: false,
        }),
      };
    }
    if (isGatewayDeadlineExceeded(input.options, this.#now())) {
      return {
        ok: false,
        error: createGatewayDeadlineExceededError(),
      };
    }

    const controller = new AbortController();
    this.#inFlight.add(controller);
    const timeout = setTimeout(
      () => controller.abort(),
      Math.min(
        MAX_TIMER_DELAY,
        Math.max(0, input.options.deadlineAt - this.#now()),
      ),
    );
    let credentialValues: readonly string[] = [];
    let errorConversationId: string | undefined;
    try {
      const sessionRequest: SessionRequest = {
        purpose: "request",
        operation: input.operation,
        ...(input.conversationId === undefined
          ? {}
          : { conversationId: input.conversationId }),
      };
      let session: TFRobotSession;
      const sessionOutcome = await awaitBounded(
        () => this.#options.sessionProvider.getSession(sessionRequest),
        {
          deadlineAt: input.options.deadlineAt,
          now: this.#now,
          signal: controller.signal,
        },
      );
      switch (sessionOutcome.kind) {
        case "aborted":
        case "deadline": {
          return this.#interruptedResult(errorConversationId);
        }
        case "error": {
          return {
            ok: false,
            error: chatErrorSchema.parse({
              code: "authentication",
              message: "Unable to obtain a TFRobot session",
              retryable: true,
            }),
          };
        }
        case "value": {
          session = sessionOutcome.value;
        }
      }
      if (!isValidTFRobotSession(session)) {
        return {
          ok: false,
          error: chatErrorSchema.parse({
            code: "authentication",
            message: "SessionProvider returned invalid TFRobot credentials",
            retryable: true,
          }),
        };
      }
      if (session.kind === "bearer") {
        credentialValues = [session.token];
      } else {
        credentialValues = [session.adminKey];
      }
      if (input.conversationId !== undefined) {
        errorConversationId = sanitizeCredentialText(
          input.conversationId,
          credentialValues,
        );
      }
      const url = new URL(input.path.replace(/^\//u, ""), this.#baseUrl);
      for (const [key, value] of Object.entries(input.query ?? {})) {
        if (value !== undefined) url.searchParams.set(key, String(value));
      }
      const headers = sessionHeaders(session);
      if (input.body !== undefined) {
        headers.set("Content-Type", "application/json");
      }
      const responseOutcome = await awaitBounded(
        () =>
          this.#fetch(url, {
            method: input.method,
            headers,
            signal: controller.signal,
            ...(input.body === undefined
              ? {}
              : { body: JSON.stringify(input.body) }),
          }),
        {
          deadlineAt: input.options.deadlineAt,
          now: this.#now,
          signal: controller.signal,
        },
      );
      if (
        responseOutcome.kind === "aborted" ||
        responseOutcome.kind === "deadline"
      ) {
        return this.#interruptedResult(errorConversationId);
      }
      if (responseOutcome.kind === "error") throw responseOutcome.reason;
      const response = responseOutcome.value;
      let payload: unknown;
      const payloadOutcome = await awaitBounded(() => response.json(), {
        deadlineAt: input.options.deadlineAt,
        now: this.#now,
        signal: controller.signal,
      });
      if (
        payloadOutcome.kind === "aborted" ||
        payloadOutcome.kind === "deadline"
      ) {
        return this.#interruptedResult(errorConversationId);
      }
      if (payloadOutcome.kind === "error") {
        payload = undefined;
      } else {
        try {
          payload = sanitizeCredentialRaw(
            payloadOutcome.value,
            credentialValues,
          );
        } catch {
          payload = undefined;
        }
      }
      if (!response.ok) {
        const error = chatErrorSchema.parse({
          code: statusErrorCode(response.status),
          message: responseMessage(
            payload,
            `TFRobot request failed with HTTP ${response.status}`,
            credentialValues,
          ),
          retryable: isRetryableStatus(response.status),
          ...(errorConversationId === undefined
            ? {}
            : { conversationId: errorConversationId }),
          ...safeDetails(
            {
              status: response.status,
              payload,
            },
            credentialValues,
          ),
        });
        this.#invalidateSession(response.status, error);
        return { ok: false, error };
      }
      const envelope = responseEnvelopeSchema.safeParse(payload);
      if (!envelope.success || envelope.data.code !== 200) {
        return {
          ok: false,
          error: chatErrorSchema.parse({
            code: "validation",
            message: envelope.success
              ? sanitizeCredentialText(envelope.data.message, credentialValues)
              : "TFRobot response envelope is invalid",
            retryable: false,
            ...(errorConversationId === undefined
              ? {}
              : { conversationId: errorConversationId }),
          }),
        };
      }
      const parsed = input.schema.safeParse(envelope.data.data);
      if (!parsed.success) {
        return {
          ok: false,
          error: chatErrorSchema.parse({
            code: "validation",
            message: "TFRobot response data is invalid",
            retryable: false,
            ...(errorConversationId === undefined
              ? {}
              : { conversationId: errorConversationId }),
            ...safeDetails(
              {
                issues: parsed.error.issues.map(({ code, path }) => ({
                  code,
                  path,
                })),
              },
              credentialValues,
            ),
          }),
        };
      }
      if (
        controller.signal.aborted ||
        isGatewayDeadlineExceeded(input.options, this.#now())
      ) {
        return this.#interruptedResult(errorConversationId);
      }
      return { ok: true, value: parsed.data };
    } catch (reason) {
      const injectedError = chatErrorSchema.safeParse(reason);
      if (injectedError.success) {
        return {
          ok: false,
          error: sanitizeCredentialError(injectedError.data, credentialValues),
        };
      }
      if (
        controller.signal.aborted ||
        isGatewayDeadlineExceeded(input.options, this.#now())
      ) {
        return {
          ok: false,
          error: createGatewayDeadlineExceededError(errorConversationId),
        };
      }
      return {
        ok: false,
        error: chatErrorSchema.parse({
          code: "network",
          message:
            reason instanceof Error
              ? sanitizeCredentialText(reason.message, credentialValues)
              : "TFRobot network request failed",
          retryable: true,
          ...(errorConversationId === undefined
            ? {}
            : { conversationId: errorConversationId }),
        }),
      };
    } finally {
      clearTimeout(timeout);
      this.#inFlight.delete(controller);
    }
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const controller of this.#inFlight) controller.abort();
    this.#inFlight.clear();
  }

  #interruptedResult<T>(conversationId?: string): GatewayResult<T> {
    if (this.#disposed) {
      return {
        ok: false,
        error: chatErrorSchema.parse({
          code: "conflict",
          message: "TFRobot Gateway is disposed",
          retryable: false,
          ...(conversationId === undefined ? {} : { conversationId }),
        }),
      };
    }
    return {
      ok: false,
      error: createGatewayDeadlineExceededError(conversationId),
    };
  }

  #invalidateSession(status: number, error: ChatError): void {
    if (status !== 401 && status !== 403) return;
    try {
      void Promise.resolve(
        this.#options.sessionProvider.onSessionInvalid?.({
          reason: status === 401 ? "expired" : "forbidden",
          error,
        }),
      ).catch(() => undefined);
    } catch {
      // A host refresh failure must not replace the original request error.
    }
  }
}
