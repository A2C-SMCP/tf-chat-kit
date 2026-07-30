export interface ChatContractCase {
  readonly name: string;
  run(): Promise<void>;
}

export class ChatContractViolation extends Error {
  override readonly name = "ChatContractViolation";
}

export const deadlineFrom = (now: number): number => now + 60_000;

const normalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(normalize);
  if (value === null || typeof value !== "object") return value;

  const output: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const property = (value as Record<string, unknown>)[key];
    if (property !== undefined) {
      Object.defineProperty(output, key, {
        configurable: true,
        enumerable: true,
        value: normalize(property),
        writable: true,
      });
    }
  }
  return output;
};

export const display = (value: unknown): string =>
  JSON.stringify(normalize(value));

export const assert: (
  condition: unknown,
  message: string,
) => asserts condition = (condition, message) => {
  if (!condition) throw new ChatContractViolation(message);
};

export const assertEqual = (
  actual: unknown,
  expected: unknown,
  message: string,
): void => {
  if (display(actual) !== display(expected)) {
    throw new ChatContractViolation(
      `${message}; expected ${display(expected)}, received ${display(actual)}`,
    );
  }
};
