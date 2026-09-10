import type { MessageResource } from "./models.js";
import type { MaybePromise, UploadCancellationSignal } from "./gateway.js";

export type ChatResourcePurpose = "display" | "open" | "download";
export interface ChatResourceRequest {
  readonly resource: MessageResource;
  readonly purpose: ChatResourcePurpose;
  readonly signal: UploadCancellationSignal;
  readonly conversationId?: string | undefined;
}
export interface ChatResolvedResource {
  readonly url: string;
  /** Release object URLs or other leases, including results arriving after cancellation. */
  readonly dispose?: (() => void) | undefined;
}
export interface ChatResourcePort {
  resolve?(request: ChatResourceRequest): MaybePromise<ChatResolvedResource>;
  open?(request: ChatResourceRequest): MaybePromise<void>;
  download?(request: ChatResourceRequest): MaybePromise<void>;
}

/** Safe resource outcomes; host diagnostics must never be included in UI state. */
export type ChatResourceErrorCode =
  | "unauthorized"
  | "network"
  | "not-found"
  | "expired"
  | "unsupported"
  | "cancelled"
  | "unknown";

export interface ChatResourceFailure {
  readonly code: ChatResourceErrorCode;
  /** Explicit retry is useful; this never requests automatic retries. */
  readonly retryable: boolean;
}

/** Hosts may throw this error or reject with an object carrying a supported code. */
export class ChatResourceError extends Error {
  constructor(readonly code: ChatResourceErrorCode) {
    super("Chat resource operation did not complete.");
    this.name = "ChatResourceError";
  }
}

/** Whitelist only stable codes, discarding messages, causes, URLs and stacks. */
export function normalizeChatResourceError(
  error: unknown,
): ChatResourceFailure {
  let code: ChatResourceErrorCode = "unknown";
  try {
    if (typeof error === "object" && error !== null) {
      if ("code" in error) {
        const candidate = error.code;
        switch (candidate) {
          case "unauthorized":
          case "network":
          case "not-found":
          case "expired":
          case "unsupported":
          case "cancelled":
            code = candidate;
        }
      }
      if (code === "unknown" && "name" in error && error.name === "AbortError")
        code = "cancelled";
    }
  } catch {
    // Even malformed host errors must have a safe fallback.
  }
  return {
    code,
    retryable: ["unauthorized", "network", "expired", "unknown"].includes(code),
  };
}
