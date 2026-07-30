interface DeadlineWaiter {
  readonly deadlineAt: number;
  resolve(): void;
}

export interface DeadlineSignal {
  cancel(): void;
  readonly promise: Promise<void>;
}

/** Deterministic clock used to drive Memory Gateway deadlines without timers. */
export class MemoryGatewayClock {
  readonly #deadlineWaiters = new Set<DeadlineWaiter>();
  #time: number;

  constructor(now: number) {
    this.#time = now;
  }

  now(): number {
    return this.#time;
  }

  signal(deadlineAt: number): DeadlineSignal {
    if (this.#time >= deadlineAt) {
      return { cancel: () => undefined, promise: Promise.resolve() };
    }

    let active = true;
    let resolvePromise: (() => void) | undefined;
    const promise = new Promise<void>((resolve) => {
      resolvePromise = resolve;
    });
    const waiter: DeadlineWaiter = {
      deadlineAt,
      resolve: () => {
        if (!active) return;
        active = false;
        this.#deadlineWaiters.delete(waiter);
        resolvePromise!();
      },
    };
    this.#deadlineWaiters.add(waiter);
    return {
      cancel: () => {
        if (!active) return;
        active = false;
        this.#deadlineWaiters.delete(waiter);
      },
      promise,
    };
  }

  advanceTo(timestamp: number): void {
    if (!Number.isSafeInteger(timestamp) || timestamp < this.#time) {
      throw new TypeError("Memory Gateway time must advance to a safe integer");
    }
    this.#time = timestamp;
    for (const waiter of [...this.#deadlineWaiters]) {
      if (waiter.deadlineAt <= timestamp) waiter.resolve();
    }
  }
}
