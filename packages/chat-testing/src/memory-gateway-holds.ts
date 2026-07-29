export type MemoryGatewayOperation =
  | "answerInteraction"
  | "interrupt"
  | "listConversations"
  | "loadConversation"
  | "sendText"
  | "subscribe";

export type MemoryGatewayHoldPoint =
  MemoryGatewayOperation | "gateway.dispose" | "subscription.dispose";

export interface MemoryGatewayHold {
  readonly completed: Promise<void>;
  readonly resourceDisposeCount: number;
  readonly started: Promise<void>;
  release(): void;
}

export interface HeldTransportCompletion {
  readonly subscription?: FakeTransportSubscription | undefined;
}

export class FakeTransportSubscription {
  readonly #onDispose: () => void;
  #disposed = false;

  constructor(onDispose: () => void) {
    this.#onDispose = onDispose;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#onDispose();
  }
}

export class PendingHold implements MemoryGatewayHold {
  readonly #completedPromise: Promise<HeldTransportCompletion>;
  readonly #publicCompletedPromise: Promise<void>;
  readonly #resolveCompleted: (completion: HeldTransportCompletion) => void;
  readonly #resolveStarted: () => void;
  readonly #startedPromise: Promise<void>;
  #released = false;
  #resourceDisposeCount = 0;
  #started = false;
  readonly #transportSubscription: FakeTransportSubscription | undefined;

  constructor(point: MemoryGatewayHoldPoint) {
    let resolveCompleted:
      ((completion: HeldTransportCompletion) => void) | undefined;
    this.#completedPromise = new Promise<HeldTransportCompletion>((resolve) => {
      resolveCompleted = resolve;
    });
    this.#publicCompletedPromise = this.#completedPromise.then(() => undefined);
    this.#resolveCompleted = resolveCompleted!;
    let resolveStarted: (() => void) | undefined;
    this.#startedPromise = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    this.#resolveStarted = resolveStarted!;
    this.#transportSubscription =
      point === "subscribe"
        ? new FakeTransportSubscription(() => {
            this.#resourceDisposeCount += 1;
          })
        : undefined;
  }

  get completed(): Promise<void> {
    return this.#publicCompletedPromise;
  }

  get resourceDisposeCount(): number {
    return this.#resourceDisposeCount;
  }

  get started(): Promise<void> {
    return this.#startedPromise;
  }

  start(): Promise<HeldTransportCompletion> {
    if (this.#started) {
      throw new Error("A Memory Gateway hold can only start once");
    }
    this.#started = true;
    this.#resolveStarted();
    return this.#completedPromise;
  }

  release(): void {
    if (this.#released) return;
    this.#released = true;
    this.#resolveCompleted({ subscription: this.#transportSubscription });
  }
}
