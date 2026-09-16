import type { ReadonlyJsonValue } from "./raw.js";
import { z } from "zod/v4";
import type { MaybePromise, UploadCancellationSignal } from "./gateway.js";
import { createRuntimeSchema } from "./internal-runtime-schema.js";

/** JSON-only data crossing the tool boundary; never executable schema code. */
export type RemoteToolJson = ReadonlyJsonValue;

export interface RemoteToolDefinition {
  readonly toolName: string;
  readonly description: string;
  readonly parameters: Readonly<Record<string, RemoteToolJson>>;
  readonly tags: readonly string[];
}

export type RemoteToolErrorCode =
  | "invalid-parameters"
  | "unknown-tool"
  | "handler-failed"
  | "invalid-result"
  | "timeout"
  | "cancelled"
  | "disconnected"
  | "disposed"
  | "capacity"
  | "conversation-unavailable";
export type RemoteToolResult =
  | {
      readonly ok: true;
      readonly resultForLlm: string;
      readonly origin?: RemoteToolJson | undefined;
    }
  | { readonly ok: false; readonly code: RemoteToolErrorCode };

export interface RemoteToolInvocation {
  readonly requestId: string;
  readonly toolName: string;
  readonly params: Readonly<Record<string, RemoteToolJson>>;
}

export interface RemoteToolExecutionContext {
  readonly requestId: string;
  readonly deadlineAt: number;
  readonly clock: RemoteToolClock;
  readonly cancellationReason: RemoteToolErrorCode | undefined;
  /** Cooperative, DOM-free cancellation. Cancellation cannot undo side effects. */
  readonly signal: UploadCancellationSignal;
}

/** validate returns normalized parameters or throws; exceptions are never sent to the caller. */
export interface RemoteTool {
  readonly definition: RemoteToolDefinition;
  validate(
    params: Readonly<Record<string, RemoteToolJson>>,
  ): MaybePromise<unknown>;
  execute(
    params: unknown,
    context: RemoteToolExecutionContext,
  ): MaybePromise<RemoteToolResult>;
}

/** Preserves the validator's inferred type without exposing it to the dispatcher. */
export const defineRemoteTool = <T>(tool: {
  readonly definition: RemoteToolDefinition;
  validate(params: Readonly<Record<string, RemoteToolJson>>): MaybePromise<T>;
  execute(
    params: T,
    context: RemoteToolExecutionContext,
  ): MaybePromise<RemoteToolResult>;
}): RemoteTool => ({
  ...tool,
  execute: (params, context) => tool.execute(params as T, context),
});

export type RemoteToolConnectionStatus =
  | "idle"
  | "connecting"
  | "registering"
  | "ready"
  | "disconnected"
  | "error"
  | "disposed";
export type RemoteToolConnectionError =
  | "authentication"
  | "name-conflict"
  | "registration-rejected"
  | "invalid-ack"
  | "timeout"
  | "transport";
export interface RemoteToolConnectionState {
  readonly status: RemoteToolConnectionStatus;
  readonly error?: RemoteToolConnectionError;
}
export interface RemoteToolObserver {
  state(state: RemoteToolConnectionState): void;
  invoke(
    invocation: RemoteToolInvocation,
    respond: (result: RemoteToolResult) => void,
  ): void;
}

/** Timing is a platform port so Runtime remains usable without DOM or Node globals. */
export interface RemoteToolClock {
  now(): number;
  schedule(callback: () => void, delayMs: number): () => void;
}

/** One client owns one transport. start is called once; dispose must be synchronous and idempotent. */
export interface RemoteToolTransport {
  readonly clock: RemoteToolClock;
  start(
    definitions: readonly RemoteToolDefinition[],
    observer: RemoteToolObserver,
  ): void;
  /** Explicit recovery after terminal registration/authentication failure. */
  retry(): void;
  dispose(): void;
}

const json: z.ZodType<RemoteToolJson> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.array(json),
    z.record(z.string(), json),
  ]),
);
const id = z.string().min(1).max(256);
export const remoteToolDefinitionSchema =
  createRuntimeSchema<RemoteToolDefinition>(
    z.object({
      toolName: id.regex(/^[A-Za-z_][A-Za-z0-9_-]*$/u),
      description: z.string().max(16_000),
      parameters: z
        .record(z.string(), json)
        .refine(
          (value) => value["type"] === "object",
          "parameters must describe an object",
        ),
      tags: z.array(z.string().min(1).max(256)).max(100),
    }),
  );
export const remoteToolInvocationSchema =
  createRuntimeSchema<RemoteToolInvocation>(
    z.object({
      requestId: id,
      toolName: id,
      params: z.record(z.string(), json),
    }),
  );
export const remoteToolResultSchema = createRuntimeSchema<RemoteToolResult>(
  z.discriminatedUnion("ok", [
    z.object({
      ok: z.literal(true),
      resultForLlm: z.string().max(1_000_000),
      origin: json.optional(),
    }),
    z.object({
      ok: z.literal(false),
      code: z.enum([
        "invalid-parameters",
        "unknown-tool",
        "handler-failed",
        "invalid-result",
        "timeout",
        "cancelled",
        "disconnected",
        "disposed",
        "capacity",
        "conversation-unavailable",
      ]),
    }),
  ]),
);
