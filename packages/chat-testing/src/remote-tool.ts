import type {
  RemoteToolConnectionState,
  RemoteToolDefinition,
  RemoteToolInvocation,
  RemoteToolObserver,
  RemoteToolResult,
  RemoteToolTransport,
} from "@turingfocus/chat-protocol";
import { MemoryGatewayClock } from "./memory-gateway-clock.js";

/** Controlled transport for Runtime tests and DOM-free host examples. */
export class MemoryRemoteToolTransport implements RemoteToolTransport {
  readonly #time = new MemoryGatewayClock(0);
  readonly clock = {
    now: (): number => this.#time.now(),
    schedule: (callback: () => void, delayMs: number): (() => void) => {
      const signal = this.#time.signal(this.#time.now() + delayMs);
      let active = true;
      void signal.promise.then(() => {
        if (active) callback();
      });
      return () => {
        active = false;
        signal.cancel();
      };
    },
  };
  #observer: RemoteToolObserver | undefined;
  #disposed = false;
  #definitions: readonly RemoteToolDefinition[] = [];
  get definitions(): readonly RemoteToolDefinition[] {
    return this.#definitions;
  }
  get disposed(): boolean {
    return this.#disposed;
  }
  start(
    definitions: readonly RemoteToolDefinition[],
    observer: RemoteToolObserver,
  ): void {
    if (this.#disposed || this.#observer !== undefined) return;
    this.#definitions = definitions;
    this.#observer = observer;
    observer.state({ status: "registering" });
  }
  setConnectionState(state: RemoteToolConnectionState): void {
    this.#observer?.state(state);
  }
  retry(): void {
    this.setConnectionState({ status: "registering" });
  }
  invoke(
    invocation: RemoteToolInvocation,
    respond: (result: RemoteToolResult) => void,
  ): void {
    this.#observer?.invoke(invocation, respond);
  }
  advanceTo(timestamp: number): void {
    this.#time.advanceTo(timestamp);
  }
  dispose(): void {
    this.#disposed = true;
    this.#definitions = [];
    this.#observer = undefined;
  }
}
