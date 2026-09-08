import {
  isSensitiveRawKey,
  sanitizeDiagnosticText,
  sanitizeRaw,
  type ChatError,
  type ReadonlyJsonValue,
} from "@turingfocus/chat-protocol";

const REDACTED_VALUE = "[REDACTED]";

// Transport pages contain many independent model items. Their traversal guard
// must not impose the diagnostic raw budget on the whole business response.
const MAX_TRANSPORT_DEPTH = 64;
const MAX_TRANSPORT_NODES = 100_000;

export class TransportPayloadError extends TypeError {}

export const sanitizeCredentialText = (
  input: string,
  credentialValues: Iterable<string>,
): string => {
  let output = sanitizeDiagnosticText(input);
  const uniqueValues = [...new Set(credentialValues)]
    .filter((value) => value.length > 0)
    .sort((left, right) => right.length - left.length);
  for (const value of uniqueValues) {
    output = output.replaceAll(value, REDACTED_VALUE);
  }
  return output;
};

export const sanitizeCredentialRaw = (
  value: unknown,
  credentialValues: Iterable<string>,
): ReadonlyJsonValue =>
  sanitizeCredentialPayload(sanitizeRaw(value), credentialValues);

/** Redacts transport JSON before mapping, without diagnostic string/total limits. */
export const sanitizeCredentialPayload = (
  input: unknown,
  credentialValues: Iterable<string>,
): ReadonlyJsonValue => {
  const credentials = [...credentialValues];
  const ancestors = new WeakSet<object>();
  let nodes = 0;
  const visit = (value: unknown, depth: number): ReadonlyJsonValue => {
    nodes += 1;
    if (nodes > MAX_TRANSPORT_NODES || depth > MAX_TRANSPORT_DEPTH) {
      throw new TransportPayloadError(
        "TFRobot payload exceeds transport structure limits (100000 nodes or depth 64)",
      );
    }
    if (typeof value === "string") {
      return sanitizeCredentialText(value, credentials);
    }
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value !== "object") {
      throw new TransportPayloadError(
        "TFRobot payload must contain valid JSON values",
      );
    }
    if (ancestors.has(value)) {
      throw new TransportPayloadError(
        "TFRobot payload must not contain circular references",
      );
    }
    ancestors.add(value);
    try {
      if (Array.isArray(value)) {
        if (value.length > MAX_TRANSPORT_NODES - nodes) {
          throw new TransportPayloadError(
            "TFRobot payload exceeds transport node limit (100000)",
          );
        }
        const headerTuple =
          value.length === 2 &&
          typeof value[0] === "string" &&
          isSensitiveRawKey(value[0]);
        const output: ReadonlyJsonValue[] = [];
        for (let index = 0; index < value.length; index += 1) {
          if (!Object.hasOwn(value, index)) {
            throw new TransportPayloadError(
              "TFRobot payload arrays must not be sparse",
            );
          }
          output.push(
            visit(
              headerTuple && index === 1 ? REDACTED_VALUE : value[index],
              depth + 1,
            ),
          );
        }
        return Object.freeze(output);
      }
      const prototype: unknown = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new TransportPayloadError(
          "TFRobot payload must contain plain JSON objects",
        );
      }
      const output: Record<string, ReadonlyJsonValue> = {};
      for (const key of Object.keys(value)) {
        const safeKey = sanitizeCredentialText(key, credentials);
        const entry = visit(
          isSensitiveRawKey(key)
            ? REDACTED_VALUE
            : (value as Record<string, unknown>)[key],
          depth + 1,
        );
        if (Object.hasOwn(output, safeKey)) continue;
        Object.defineProperty(output, safeKey, {
          value: entry,
          enumerable: true,
          configurable: false,
          writable: false,
        });
      }
      return Object.freeze(output);
    } finally {
      ancestors.delete(value);
    }
  };
  return visit(input, 0);
};

export const sanitizeCredentialError = (
  error: ChatError,
  credentialValues: Iterable<string>,
): ChatError => ({
  ...error,
  message: sanitizeCredentialText(error.message, credentialValues),
  ...(error.conversationId === undefined
    ? {}
    : {
        conversationId: sanitizeCredentialText(
          error.conversationId,
          credentialValues,
        ),
      }),
  ...(error.details === undefined
    ? {}
    : { details: sanitizeCredentialRaw(error.details, credentialValues) }),
});
