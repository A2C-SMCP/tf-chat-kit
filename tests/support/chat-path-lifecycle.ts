export type ChatPathKind = "kit" | "legacy";

export interface ChatPath {
  readonly kind: ChatPathKind;
  dispose(options: { readonly deadlineAt: number }): Promise<void>;
  send(text: string): Promise<void>;
}

export interface ChatPathFactory {
  create(): Promise<ChatPath>;
}

export type ChatPathLifecycleState =
  | { readonly kind: "idle" }
  | { readonly kind: "activating"; readonly target: ChatPathKind }
  | { readonly kind: "active"; readonly path: ChatPathKind }
  | {
      readonly kind: "deactivating";
      readonly path: ChatPathKind;
      readonly target?: ChatPathKind | undefined;
    }
  | {
      readonly error: unknown;
      readonly kind: "blocked-dispose";
      readonly path: ChatPathKind;
      readonly target?: ChatPathKind | undefined;
    }
  | {
      readonly error: unknown;
      readonly kind: "activation-failed";
      readonly target: ChatPathKind;
    };

export interface ChatPathLifecycleOptions {
  readonly factories: Readonly<Record<ChatPathKind, ChatPathFactory>>;
  readonly getDisposeDeadlineAt: () => number;
  readonly onActivationError: (target: ChatPathKind, error: unknown) => void;
  readonly onDisposeError: (path: ChatPathKind, error: unknown) => void;
  readonly onFallback: (error: unknown) => void;
  readonly onStateChange?: (state: ChatPathLifecycleState) => void | undefined;
}

/**
 * Test-only model for a host-owned old/new path switch. It serializes resource
 * ownership changes so a replacement is never activated before the selected
 * path has disposed successfully.
 */
export class ChatPathLifecycleController {
  readonly #options: ChatPathLifecycleOptions;
  #active: ChatPath | undefined;
  #activeRevision: number | undefined;
  #queue: Promise<void> = Promise.resolve();
  #revision = 0;
  #state: ChatPathLifecycleState = { kind: "idle" };
  #target: ChatPathKind | undefined;

  constructor(options: ChatPathLifecycleOptions) {
    this.#options = options;
  }

  get activePath(): ChatPathKind | undefined {
    return this.#active?.kind;
  }

  get state(): ChatPathLifecycleState {
    return this.#state;
  }

  dispose(): Promise<void> {
    const revision = ++this.#revision;
    this.#target = undefined;
    this.#markDeactivating(this.#active);
    return this.#enqueue(async () => {
      await this.#deactivate();
      if (revision === this.#revision && this.#active === undefined) {
        this.#setState({ kind: "idle" });
      }
    });
  }

  select(useKit: boolean): Promise<void> {
    const target: ChatPathKind = useKit ? "kit" : "legacy";
    if (
      this.#state.kind === "active" &&
      this.#active?.kind === target &&
      this.#activeRevision === this.#revision
    ) {
      this.#target = target;
      return this.#queue;
    }
    const revision = ++this.#revision;
    this.#target = target;
    this.#markDeactivating(this.#active, target);
    return this.#enqueue(async () => {
      if (revision !== this.#revision) return;
      if (this.#state.kind === "active" && this.#active?.kind === target) {
        this.#activeRevision = revision;
        return;
      }
      if (!(await this.#deactivate(target))) return;
      if (revision !== this.#revision) return;
      this.#setState({ kind: "activating", target });
      try {
        await this.#activate(target, revision);
      } catch (error) {
        this.#reportActivationError(target, error);
        if (target !== "kit" || revision !== this.#revision) {
          this.#setState({ error, kind: "activation-failed", target });
          return;
        }
        this.#reportFallback(error);
        try {
          await this.#activate("legacy", revision);
        } catch (fallbackError) {
          this.#reportActivationError("legacy", fallbackError);
          this.#setState({
            error: fallbackError,
            kind: "activation-failed",
            target: "legacy",
          });
        }
      }
    });
  }

  send(text: string): Promise<void> {
    const active = this.#active;
    const revision = this.#revision;
    if (
      active === undefined ||
      this.#state.kind !== "active" ||
      this.#state.path !== active.kind ||
      this.#activeRevision !== revision
    ) {
      return Promise.reject(new Error("No chat path is active"));
    }
    return this.#enqueue(async () => {
      if (
        revision !== this.#revision ||
        active !== this.#active ||
        this.#state.kind !== "active" ||
        this.#state.path !== active.kind ||
        this.#activeRevision !== revision
      ) {
        throw new Error("No chat path is active");
      }
      await active.send(text);
    });
  }

  settled(): Promise<void> {
    return this.#queue;
  }

  async #activate(target: ChatPathKind, revision: number): Promise<void> {
    const path = await this.#options.factories[target].create();
    if (revision !== this.#revision) {
      this.#active = path;
      this.#activeRevision = revision;
      this.#markDeactivating(path, this.#target);
      try {
        await path.dispose({
          deadlineAt: this.#options.getDisposeDeadlineAt(),
        });
        if (this.#active === path) {
          this.#active = undefined;
          this.#activeRevision = undefined;
        }
      } catch (error) {
        this.#reportDisposeError(path.kind, error);
        this.#setState({
          error,
          kind: "blocked-dispose",
          path: path.kind,
          ...(this.#target === undefined ? {} : { target: this.#target }),
        });
      }
      return;
    }
    this.#active = path;
    this.#activeRevision = revision;
    this.#setState({ kind: "active", path: target });
  }

  async #deactivate(target?: ChatPathKind): Promise<boolean> {
    const active = this.#active;
    if (active === undefined) return true;
    this.#markDeactivating(active, target);
    try {
      await active.dispose({
        deadlineAt: this.#options.getDisposeDeadlineAt(),
      });
      if (this.#active === active) {
        this.#active = undefined;
        this.#activeRevision = undefined;
      }
      return true;
    } catch (error) {
      this.#reportDisposeError(active.kind, error);
      this.#setState({
        error,
        kind: "blocked-dispose",
        path: active.kind,
        ...(target === undefined ? {} : { target }),
      });
      return false;
    }
  }

  #enqueue(operation: () => Promise<void>): Promise<void> {
    const next = this.#queue.then(operation, operation);
    this.#queue = next.catch(() => undefined);
    return next;
  }

  #markDeactivating(active: ChatPath | undefined, target?: ChatPathKind): void {
    if (active === undefined) return;
    if (
      this.#state.kind === "deactivating" &&
      this.#state.path === active.kind &&
      this.#state.target === target
    ) {
      return;
    }
    this.#setState({
      kind: "deactivating",
      path: active.kind,
      ...(target === undefined ? {} : { target }),
    });
  }

  #setState(state: ChatPathLifecycleState): void {
    this.#state = state;
    try {
      this.#options.onStateChange?.(state);
    } catch {
      // Observers cannot participate in or invalidate resource ownership.
    }
  }

  #reportActivationError(target: ChatPathKind, error: unknown): void {
    try {
      this.#options.onActivationError(target, error);
    } catch {
      // Diagnostic callbacks cannot participate in lifecycle decisions.
    }
  }

  #reportDisposeError(path: ChatPathKind, error: unknown): void {
    try {
      this.#options.onDisposeError(path, error);
    } catch {
      // Diagnostic callbacks cannot participate in lifecycle decisions.
    }
  }

  #reportFallback(error: unknown): void {
    try {
      this.#options.onFallback(error);
    } catch {
      // Diagnostic callbacks cannot participate in lifecycle decisions.
    }
  }
}
