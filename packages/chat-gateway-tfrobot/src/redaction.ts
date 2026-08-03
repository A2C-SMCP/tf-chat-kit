import {
  sanitizeDiagnosticText,
  sanitizeRaw,
  type ChatError,
  type ReadonlyJsonValue,
} from "@turingfocus/chat-protocol";

const REDACTED_VALUE = "[REDACTED]";

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

const redactJsonValue = (
  value: ReadonlyJsonValue,
  credentialValues: Iterable<string>,
): ReadonlyJsonValue => {
  if (typeof value === "string") {
    return sanitizeCredentialText(value, credentialValues);
  }
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return Object.freeze(
      value.map((entry) => redactJsonValue(entry, credentialValues)),
    );
  }
  const output: Record<string, ReadonlyJsonValue> = {};
  for (const [key, entry] of Object.entries(value)) {
    const safeKey = sanitizeCredentialText(key, credentialValues);
    if (Object.hasOwn(output, safeKey)) continue;
    Object.defineProperty(output, safeKey, {
      configurable: false,
      enumerable: true,
      value: redactJsonValue(entry, credentialValues),
      writable: false,
    });
  }
  return Object.freeze(output);
};

export const sanitizeCredentialRaw = (
  value: unknown,
  credentialValues: Iterable<string>,
): ReadonlyJsonValue => redactJsonValue(sanitizeRaw(value), credentialValues);

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
