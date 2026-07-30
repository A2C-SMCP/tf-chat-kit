import type {
  GatewayRequestOptions,
  MaybePromise,
} from "@turingfocus/chat-protocol";

const MAX_TIMER_DELAY = 2_147_483_647;

export type BoundedOutcome<T> =
  | { readonly kind: "aborted" }
  | { readonly kind: "deadline" }
  | { readonly kind: "error"; readonly reason: unknown }
  | { readonly kind: "value"; readonly value: T };

interface BoundedOptions extends GatewayRequestOptions {
  readonly now: () => number;
  readonly signal?: AbortSignal | undefined;
}

/**
 * Bounds host-owned asynchronous hooks that cannot be force-cancelled.
 * Late fulfillment/rejection is observed and discarded by the raced promise.
 */
export const awaitBounded = async <T>(
  operation: () => MaybePromise<T>,
  options: BoundedOptions,
): Promise<BoundedOutcome<T>> => {
  const interruption = (): BoundedOutcome<T> | undefined => {
    if (options.signal?.aborted === true) return { kind: "aborted" };
    if (options.now() >= options.deadlineAt) return { kind: "deadline" };
    return undefined;
  };
  const initialInterruption = interruption();
  if (initialInterruption !== undefined) return initialInterruption;

  let timeout: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const deadline = new Promise<BoundedOutcome<T>>((resolve) => {
    timeout = setTimeout(
      () => resolve({ kind: "deadline" }),
      Math.min(
        MAX_TIMER_DELAY,
        Math.max(0, options.deadlineAt - options.now()),
      ),
    );
  });
  const aborted =
    options.signal === undefined
      ? undefined
      : new Promise<BoundedOutcome<T>>((resolve) => {
          onAbort = () => resolve({ kind: "aborted" });
          options.signal!.addEventListener("abort", onAbort, { once: true });
        });
  const result = Promise.resolve()
    .then(operation)
    .then<BoundedOutcome<T>, BoundedOutcome<T>>(
      (value) => interruption() ?? { kind: "value", value },
      (reason: unknown) => interruption() ?? { kind: "error", reason },
    );

  try {
    const outcome = await Promise.race(
      aborted === undefined ? [result, deadline] : [result, deadline, aborted],
    );
    return interruption() ?? outcome;
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    if (onAbort !== undefined) {
      options.signal?.removeEventListener("abort", onAbort);
    }
  }
};
