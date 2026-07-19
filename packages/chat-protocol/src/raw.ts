export type JsonPrimitive = boolean | null | number | string;

export type ReadonlyJsonValue =
  | JsonPrimitive
  | readonly ReadonlyJsonValue[]
  | { readonly [key: string]: ReadonlyJsonValue };

const MAX_RAW_DEPTH = 32;
const MAX_RAW_KEY_LENGTH = 1_024;
const MAX_RAW_NODES = 10_000;
const MAX_RAW_STRING_LENGTH = 262_144;
const MAX_RAW_TOTAL_CHARACTERS = 1_048_576;
const REDACTED_VALUE = "[REDACTED]";

const sensitiveKeyNames = new Set([
  "adminkey",
  "apikey",
  "auth",
  "authorization",
  "bearer",
  "clientsecret",
  "cookie",
  "credentials",
  "credential",
  "password",
  "privatekey",
  "refreshtoken",
  "jwt",
  "secret",
  "secretkey",
  "setcookie",
  "sig",
  "signature",
  "token",
  "accesstoken",
  "xamzcredential",
  "xamzsignature",
]);
const sensitiveKeySuffixes = [
  "adminkey",
  "apikey",
  "authorization",
  "clientsecret",
  "cookie",
  "credentials",
  "credential",
  "password",
  "privatekey",
  "secret",
  "secretkey",
  "signature",
  "token",
] as const;

const canonicalizeKey = (key: string): string =>
  key.toLocaleLowerCase("en-US").replaceAll(/[^a-z0-9]/gu, "");

export const isSensitiveRawKey = (key: string): boolean => {
  const canonicalKey = canonicalizeKey(key);
  return (
    sensitiveKeyNames.has(canonicalKey) ||
    sensitiveKeySuffixes.some((suffix) => canonicalKey.endsWith(suffix))
  );
};

const authorizationValuePattern =
  /\b(?:basic|bearer)\s+[A-Za-z0-9+/_:.~-]+={0,}/giu;
const credentialHeaderValuePattern =
  /\b(?:(?:x[-_])?(?:admin|api)[-_]?key|(?:proxy[-_])?authorization|cookie|set-cookie)\s*[:=]\s*[^\r\n]+/giu;
const jwtValuePattern = /\b(?:[A-Za-z0-9_-]{8,}\.){2,4}[A-Za-z0-9_-]+\b/gu;
const pemPrivateKeyPattern =
  /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/iu;
const providerTokenPattern =
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/gu;
const awsAccessKeyPattern =
  /\b(?:A3T[A-Z0-9]{17}|A(?:GPA|IDA|IPA|KIA|NPA|NVA|ROA|SCA|SIA)[A-Z0-9]{16})\b/gu;
const urlParameterPattern = /([?&#])([^?&#=]+)=([^&#]*)/gu;
const urlUserInfoPattern = /((?:\b[A-Za-z][A-Za-z0-9+.-]*:)?\/\/)([^/@\s]+)@/gu;
const embeddedParameterPattern =
  /(^|[\s,;])([^?&#:=\s,;]+)\s*([:=])\s*([^\s,;&#]+)/gu;

const decodeUrlKey = (key: string): string => {
  try {
    return decodeURIComponent(key.replaceAll("+", " "));
  } catch {
    return key;
  }
};

/** Removes credential-shaped fragments from user-visible diagnostic text. */
export const sanitizeDiagnosticText = (input: string): string => {
  const trimmed = input.trim();
  const standaloneParameter = /^([^?&#:=\s]+)\s*[:=]\s*\S+/u.exec(trimmed);
  if (
    pemPrivateKeyPattern.test(trimmed) ||
    (standaloneParameter !== null &&
      isSensitiveRawKey(decodeUrlKey(standaloneParameter[1]!)))
  ) {
    return REDACTED_VALUE;
  }

  return input
    .replace(urlUserInfoPattern, `$1${REDACTED_VALUE}@`)
    .replace(
      urlParameterPattern,
      (match, separator: string, encodedKey: string) =>
        isSensitiveRawKey(decodeUrlKey(encodedKey))
          ? `${separator}${encodedKey}=${encodeURIComponent(REDACTED_VALUE)}`
          : match,
    )
    .replace(credentialHeaderValuePattern, REDACTED_VALUE)
    .replace(authorizationValuePattern, REDACTED_VALUE)
    .replace(jwtValuePattern, REDACTED_VALUE)
    .replace(providerTokenPattern, REDACTED_VALUE)
    .replace(awsAccessKeyPattern, REDACTED_VALUE)
    .replace(
      embeddedParameterPattern,
      (match, prefix: string, encodedKey: string, separator: string): string =>
        isSensitiveRawKey(decodeUrlKey(encodedKey))
          ? `${prefix}${encodedKey}${separator}${REDACTED_VALUE}`
          : match,
    );
};

interface SanitizeState {
  readonly ancestors: WeakSet<object>;
  nodes: number;
  totalCharacters: number;
}

const addCharacters = (state: SanitizeState, count: number): void => {
  state.totalCharacters += count;
  if (state.totalCharacters > MAX_RAW_TOTAL_CHARACTERS) {
    throw new TypeError(
      `raw data exceeds the maximum total character count of ${MAX_RAW_TOTAL_CHARACTERS}`,
    );
  }
};

const addNodes = (state: SanitizeState, count: number = 1): void => {
  state.nodes += count;
  if (state.nodes > MAX_RAW_NODES) {
    throw new TypeError(
      `raw data exceeds the maximum node count of ${MAX_RAW_NODES}`,
    );
  }
};

const addRedactedLeaf = (state: SanitizeState): string => {
  addNodes(state);
  addCharacters(state, REDACTED_VALUE.length);
  return REDACTED_VALUE;
};

const sanitizeValue = (
  input: unknown,
  depth: number,
  state: SanitizeState,
): ReadonlyJsonValue => {
  addNodes(state);

  if (depth > MAX_RAW_DEPTH) {
    throw new TypeError(
      `raw data exceeds the maximum depth of ${MAX_RAW_DEPTH}`,
    );
  }

  if (input === null || typeof input === "boolean") {
    return input;
  }

  if (typeof input === "string") {
    if (input.length > MAX_RAW_STRING_LENGTH) {
      throw new TypeError(
        `raw data strings must not exceed ${MAX_RAW_STRING_LENGTH} characters`,
      );
    }
    const sanitized = sanitizeDiagnosticText(input);
    if (sanitized.length > MAX_RAW_STRING_LENGTH) {
      throw new TypeError(
        `sanitized raw data strings must not exceed ${MAX_RAW_STRING_LENGTH} characters`,
      );
    }
    addCharacters(state, sanitized.length);
    return sanitized;
  }

  if (typeof input === "number") {
    if (!Number.isFinite(input)) {
      throw new TypeError("raw data numbers must be finite");
    }
    return input;
  }

  if (typeof input !== "object") {
    throw new TypeError(`raw data contains unsupported ${typeof input} value`);
  }

  if (state.ancestors.has(input)) {
    throw new TypeError("raw data must not contain circular references");
  }
  state.ancestors.add(input);

  try {
    if (Array.isArray(input)) {
      if (input.length > MAX_RAW_NODES - state.nodes) {
        throw new TypeError(
          `raw data exceeds the maximum node count of ${MAX_RAW_NODES}`,
        );
      }
      if (
        input.length === 2 &&
        Object.hasOwn(input, 0) &&
        Object.hasOwn(input, 1) &&
        typeof input[0] === "string" &&
        isSensitiveRawKey(input[0])
      ) {
        if (input[0].length > MAX_RAW_STRING_LENGTH) {
          throw new TypeError(
            `raw data strings must not exceed ${MAX_RAW_STRING_LENGTH} characters`,
          );
        }
        addNodes(state, 2);
        addCharacters(state, input[0].length + REDACTED_VALUE.length);
        return Object.freeze([input[0], REDACTED_VALUE]);
      }
      const output: ReadonlyJsonValue[] = [];
      for (let index = 0; index < input.length; index += 1) {
        if (!Object.hasOwn(input, index)) {
          throw new TypeError("raw data arrays must not be sparse");
        }
        output.push(sanitizeValue(input[index], depth + 1, state));
      }
      return Object.freeze(output);
    }

    const prototype = Object.getPrototypeOf(input) as object | null;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("raw data objects must be plain JSON objects");
    }

    const output: Record<string, ReadonlyJsonValue> = {};
    for (const key in input) {
      if (!Object.hasOwn(input, key)) continue;
      if (key.length > MAX_RAW_KEY_LENGTH) {
        throw new TypeError(
          `raw data keys must not exceed ${MAX_RAW_KEY_LENGTH} characters`,
        );
      }
      addCharacters(state, key.length);
      const sanitizedValue = isSensitiveRawKey(key)
        ? addRedactedLeaf(state)
        : sanitizeValue(
            (input as Record<string, unknown>)[key],
            depth + 1,
            state,
          );
      Object.defineProperty(output, key, {
        configurable: false,
        enumerable: true,
        writable: false,
        value: sanitizedValue,
      });
    }
    return Object.freeze(output);
  } finally {
    state.ancestors.delete(input);
  }
};

/**
 * Produces an immutable JSON value and redacts credential-shaped keys, header
 * tuples, authorization strings, JWTs, URL userinfo, and signed query values.
 * The retained result is bounded by depth, nodes, per-string size, and total
 * key/string characters so many individually valid values cannot amplify it.
 * Gateway adapters must still allowlist transport fields before retaining raw;
 * this sanitizer is the final defense rather than permission to keep headers.
 */
export const sanitizeRaw = (input: unknown): ReadonlyJsonValue =>
  sanitizeValue(input, 0, {
    ancestors: new WeakSet<object>(),
    nodes: 0,
    totalCharacters: 0,
  });
