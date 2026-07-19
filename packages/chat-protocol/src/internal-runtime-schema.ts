import type { z } from "zod/v4";

import {
  ProtocolValidationError,
  type ProtocolParseResult,
  type ProtocolValidationPathSegment,
  type RuntimeSchema,
} from "./schema.js";

const normalizePath = (
  path: readonly PropertyKey[],
): readonly ProtocolValidationPathSegment[] =>
  Object.freeze(
    path.map((segment) =>
      typeof segment === "symbol"
        ? (segment.description ?? segment.toString())
        : segment,
    ),
  );

const freezeRecursively = <T>(value: T, seen = new WeakSet<object>()): T => {
  if (
    value === null ||
    (typeof value !== "object" && typeof value !== "function")
  ) {
    return value;
  }

  const objectValue = value as object;
  if (seen.has(objectValue)) return value;
  seen.add(objectValue);

  for (const key of Reflect.ownKeys(objectValue)) {
    const property = (objectValue as Record<PropertyKey, unknown>)[key];
    freezeRecursively(property, seen);
  }

  return Object.freeze(value);
};

export const createRuntimeSchema = <T>(
  schema: z.ZodType<T>,
): RuntimeSchema<T> => {
  const safeParse = (input: unknown): ProtocolParseResult<T> => {
    const result = schema.safeParse(input);
    if (result.success) {
      return Object.freeze({
        success: true as const,
        data: freezeRecursively(result.data),
      });
    }

    const issues = result.error.issues.map((issue) =>
      Object.freeze({
        code: issue.code,
        message: issue.message,
        path: normalizePath(issue.path),
      }),
    );
    return Object.freeze({
      success: false as const,
      error: new ProtocolValidationError(issues),
    });
  };

  return Object.freeze({
    parse: (input: unknown): T => {
      const result = safeParse(input);
      if (!result.success) throw result.error;
      return result.data;
    },
    safeParse,
  });
};
