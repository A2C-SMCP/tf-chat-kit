import manifest from "../package.json" with { type: "json" };
import {
  safeDiagnosticError,
  sanitizeChatDiagnosticText,
  type ChatDiagnosticRecord,
  type ChatError,
  type ChatErrorSource,
  type ChatErrorScope,
} from "@turingfocus/chat-protocol";

export interface ChatDiagnosticsOptions {
  readonly appVersion?: string | undefined;
  readonly onRecord?:
    ((record: ChatDiagnosticRecord) => void | PromiseLike<void>) | undefined;
}
const EMPTY: readonly ChatDiagnosticRecord[] = Object.freeze([]);
/** Instance-local, bounded independently from the live error state and conversation cache. */
export class DiagnosticStore {
  #records: readonly ChatDiagnosticRecord[] = EMPTY;
  #views = new Map<string, readonly ChatDiagnosticRecord[]>();
  #listeners = new Set<() => void>();
  #sequence = 0;
  #disposed = false;
  constructor(private readonly options: ChatDiagnosticsOptions = {}) {}
  nextId(): string {
    return `local:${++this.#sequence}`;
  }
  read(conversationId?: string): readonly ChatDiagnosticRecord[] {
    if (conversationId === undefined) return this.#records;
    const cached = this.#views.get(conversationId);
    if (cached) return cached;
    const records = Object.freeze(
      this.#records.filter(
        (record) => record.conversationId === conversationId,
      ),
    );
    // Empty selections do not retain arbitrarily many conversation IDs.
    if (records.length === 0) return EMPTY;
    this.#views.set(conversationId, records);
    return records;
  }
  subscribe(listener: () => void): () => void {
    if (!this.#disposed) this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  record(
    error: ChatError,
    source: ChatErrorSource,
    scope: ChatErrorScope,
    id = this.nextId(),
  ): ChatDiagnosticRecord | undefined {
    if (this.#disposed) return;
    const safe = safeDiagnosticError(error);
    const safeId = sanitizeChatDiagnosticText(id).slice(0, 256);
    const safeScope = Object.freeze(
      scope.kind === "global"
        ? { kind: "global" as const }
        : {
            kind: scope.kind,
            id: sanitizeChatDiagnosticText(scope.id).slice(0, 256),
          },
    );
    const existing = this.#records.find(
      (record) =>
        record.id === safeId &&
        record.conversationId === safe.conversationId &&
        JSON.stringify(record.scope) === JSON.stringify(safeScope),
    );
    const now = Date.now();
    let record: ChatDiagnosticRecord = Object.freeze({
      id: safeId,
      error: existing?.error ?? safe,
      scope: safeScope,
      source,
      conversationId: safe.conversationId,
      firstAt: existing?.firstAt ?? now,
      lastAt: now,
      count: (existing?.count ?? 0) + 1,
      resolved: false,
      kitVersion: manifest.version,
      appVersion:
        this.options.appVersion === undefined
          ? undefined
          : sanitizeChatDiagnosticText(this.options.appVersion).slice(0, 128),
    });
    const bytes = (value: unknown) =>
      [...JSON.stringify(value)].reduce((total, character) => {
        const code = character.codePointAt(0)!;
        return (
          total + (code <= 127 ? 1 : code <= 2047 ? 2 : code <= 65535 ? 3 : 4)
        );
      }, 0);
    // Retain the newest failure even when individually valid multibyte fields exceed the record budget.
    for (const limit of [128, 64, 32]) {
      if (bytes(record) <= 8192) break;
      record = Object.freeze({
        ...record,
        truncated: true,
        error: safeDiagnosticError({
          ...record.error,
          diagnostic: Object.fromEntries(
            Object.entries(record.error.diagnostic ?? {}).map(
              ([key, value]) => [
                key,
                typeof value === "string" &&
                !["errorId", "operationId", "operation", "reasonCode"].includes(
                  key,
                )
                  ? value.slice(0, limit)
                  : value,
              ],
            ),
          ),
        }),
      });
    }
    const records = [
      ...this.#records.filter((item) => item !== existing),
      record,
    ].slice(-50);
    while (records.length && bytes(records) > 131072) records.shift();
    this.#records = Object.freeze(records);
    this.#changed();
    try {
      void Promise.resolve(this.options.onRecord?.(record)).catch(
        () => undefined,
      );
    } catch {
      /* Observational callback. */
    }
    return record;
  }
  resolve(id: string, conversationId?: string): void {
    if (this.#disposed) return;
    let changed = false;
    this.#records = Object.freeze(
      this.#records.map((record) => {
        if (
          record.id !== id ||
          record.conversationId !== conversationId ||
          record.resolved
        )
          return record;
        changed = true;
        return Object.freeze({ ...record, resolved: true });
      }),
    );
    if (changed) this.#changed();
  }
  #changed(): void {
    this.#views.clear();
    for (const listener of this.#listeners) {
      try {
        listener();
      } catch {
        /* Isolated observer. */
      }
    }
  }
  dispose(): void {
    this.#disposed = true;
    this.#records = EMPTY;
    this.#views.clear();
    this.#listeners.clear();
  }
}
