import { z } from "zod/v4";
import type { ChatError, ChatErrorScope, ChatErrorSource } from "./models.js";
import { sanitizeDiagnosticText } from "./raw.js";

export const sanitizeChatDiagnosticText = (value: string): string =>
  sanitizeDiagnosticText(
    [...value]
      .filter(
        (character) =>
          character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
      )
      .map((character) => {
        const code = character.codePointAt(0)!;
        return code >= 0xd800 && code <= 0xdfff ? "\ufffd" : character;
      })
      .join(""),
  ).slice(0, 256);

const text = z.string().transform(sanitizeChatDiagnosticText);
const number = z.number().finite().nonnegative();
/** Diagnostic fields are an allowlist, never arbitrary transport payloads. */
export const chatErrorDiagnosticParser = z.object({
  originalMessage: z
    .enum([
      "Failed to fetch",
      "fetch failed",
      "Unauthorized",
      "Forbidden",
      "Not Found",
      "Internal Server Error",
      "Request timeout",
      "TFRobot response envelope is invalid",
      "TFRobot response data is invalid",
    ])
    .optional(),
  operation: text.optional(),
  phase: text.optional(),
  reasonCode: text.optional(),
  operationId: text.optional(),
  errorId: text.optional(),
  runId: text.optional(),
  requestId: text.optional(),
  traceId: text.optional(),
  businessCode: text.optional(),
  method: z.enum(["GET", "POST", "PATCH", "DELETE"]).optional(),
  path: z
    .string()
    .regex(/^\/[a-zA-Z0-9_/:.-]*$/u)
    .max(256)
    .optional(),
  httpStatus: number.optional(),
  elapsedMs: number.optional(),
  timeoutMs: number.optional(),
  generation: number.optional(),
  reconnectAttempt: number.optional(),
  recoveryComplete: z.boolean().optional(),
  recoveryAssurance: z.enum(["verified", "best-effort"]).optional(),
  outcome: z.enum(["not-started", "unknown", "failed"]).optional(),
});
export type ChatErrorDiagnostic = z.infer<typeof chatErrorDiagnosticParser>;
export interface ChatDiagnosticRecord {
  readonly truncated?: boolean | undefined;
  readonly id: string;
  readonly conversationId?: string | undefined;
  readonly scope: ChatErrorScope;
  readonly source: ChatErrorSource;
  readonly error: ChatError;
  readonly firstAt: number;
  readonly lastAt: number;
  readonly count: number;
  readonly resolved: boolean;
  readonly kitVersion?: string | undefined;
  readonly appVersion?: string | undefined;
}

/** Do not copy untrusted messages, details, headers or response bodies to diagnostics. */
export function safeDiagnosticError(error: ChatError): ChatError {
  const parsed = chatErrorDiagnosticParser.safeParse(error.diagnostic);
  return Object.freeze({
    code: error.code,
    retryable: error.retryable,
    message: `Chat operation failed (${error.code}).`,
    ...(error.conversationId === undefined
      ? {}
      : {
          conversationId: sanitizeChatDiagnosticText(error.conversationId),
        }),
    ...(parsed.success ? { diagnostic: Object.freeze(parsed.data) } : {}),
  });
}

/** Every requested field is represented; local IDs never masquerade as server IDs. */
export function formatChatDiagnostic(record: ChatDiagnosticRecord): string {
  const error = safeDiagnosticError(record.error);
  const d = error.diagnostic;
  const missing = "Not provided";
  return JSON.stringify(
    {
      recordId: sanitizeChatDiagnosticText(record.id),
      truncated: record.truncated ?? false,
      conversationId:
        record.conversationId === undefined
          ? missing
          : sanitizeChatDiagnosticText(record.conversationId),
      scope:
        record.scope.kind === "global"
          ? { kind: "global" }
          : {
              kind: record.scope.kind,
              id: sanitizeChatDiagnosticText(record.scope.id),
            },
      source: record.source,
      category: error.code,
      reasonCode: d?.reasonCode ?? missing,
      originalMessage:
        d?.originalMessage ?? "Not provided (unverified content omitted)",
      operation: d?.operation ?? missing,
      phase: d?.phase ?? missing,
      firstAt: record.firstAt || missing,
      lastAt: record.lastAt || missing,
      count: record.count,
      resolved: record.resolved,
      localOperationId: d?.operationId ?? missing,
      errorId: d?.errorId ?? sanitizeChatDiagnosticText(record.id),
      runId: d?.runId ?? missing,
      requestId: d?.requestId ?? missing,
      traceId: d?.traceId ?? missing,
      httpStatus: d?.httpStatus ?? missing,
      method: d?.method ?? missing,
      path: d?.path ?? missing,
      elapsedMs: d?.elapsedMs ?? missing,
      timeoutMs: d?.timeoutMs ?? missing,
      businessCode: d?.businessCode ?? missing,
      generation: d?.generation ?? missing,
      reconnectAttempt: d?.reconnectAttempt ?? missing,
      recoveryComplete: d?.recoveryComplete ?? missing,
      recoveryAssurance: d?.recoveryAssurance ?? missing,
      outcome: d?.outcome ?? missing,
      kitVersion:
        record.kitVersion === undefined
          ? missing
          : sanitizeChatDiagnosticText(record.kitVersion),
      appVersion:
        record.appVersion === undefined
          ? missing
          : sanitizeChatDiagnosticText(record.appVersion),
    },
    null,
    2,
  );
}
