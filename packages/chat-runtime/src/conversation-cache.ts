import {
  compareTimelineItems,
  getTimelineItemKey,
} from "@turingfocus/chat-protocol";
import { createTimelineState, mergeHistoryTimeline } from "./timeline.js";
import type {
  ChatSnapshot,
  GatewayRequestOptions,
  UploadedAttachment,
} from "@turingfocus/chat-protocol";
import { cloneImmutable } from "./immutable.js";
import { emptyComposerDraft, type ComposerDraft } from "./composer-draft.js";
import {
  createCacheRecord,
  parseCacheRecord,
  type ConversationCacheRecord,
} from "./cache-record.js";

/** Host-owned storage. update must be atomic and ordered for a given scope,
 * including across adapter instances sharing a backend. Callbacks are synchronous.
 * Implementations must honor deadlineAt, including reads and lock acquisition.
 * The default namespace is local to this host-isolated adapter, never global.
 */
export interface ConversationCacheStorage {
  read(scope: string, options: GatewayRequestOptions): Promise<string | null>;
  update(
    scope: string,
    transform: (current: string | null) => string | null,
    options: GatewayRequestOptions,
  ): Promise<void>;
}

/** Keys must be stable opaque identifiers, never credentials or signed URLs. */
export interface CachedAttachmentResolver {
  identify(attachment: UploadedAttachment): string | undefined;
  resolve(
    key: string,
    options: GatewayRequestOptions,
  ): Promise<UploadedAttachment | undefined>;
}

export interface ConversationCacheOptions {
  readonly scope?: string;
  readonly maxConversations?: number;
  readonly maxItems?: number;
  readonly maxBytes?: number;
  readonly staleAfterMs?: number;
  readonly expireAfterMs?: number;
  readonly storage?: ConversationCacheStorage;
  readonly attachments?: CachedAttachmentResolver;
  readonly now?: () => number;
  readonly onEvent?: (event: ConversationCacheEvent) => void;
}

export interface ConversationCacheEvent {
  readonly kind:
    | "evicted"
    | "expired"
    | "cleared"
    | "storage-error"
    | "invalid-record"
    | "write-conflict";
  readonly conversationId?: string;
  readonly hadDraft?: boolean;
}

export interface ConversationCacheState {
  readonly conversationId?: string;
  readonly status: "disabled" | "idle" | "syncing" | "ready" | "error";
  readonly source: "none" | "memory" | "storage";
  readonly freshness: "miss" | "fresh" | "stale" | "expired";
  readonly savedAt?: number;
  readonly unavailableAttachments: number;
  readonly storageError: boolean;
}

export interface CacheEntry {
  readonly snapshot: ChatSnapshot;
  readonly draft: ComposerDraft;
  readonly savedAt: number;
  readonly bytes: number;
  readonly attachmentKeys?: readonly string[];
  readonly unavailableAttachments?: number;
}

interface DiskEntry {
  revision: number;
  record: ConversationCacheRecord;
}
interface DiskScope {
  version: 1;
  epoch: number;
  entries: Record<string, DiskEntry>;
}

const emptyDisk = (): DiskScope => ({
  version: 1,
  epoch: 0,
  entries: Object.create(null) as Record<string, DiskEntry>,
});
const positive = (value: number | undefined, fallback: number): number => {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0)
    throw new TypeError("Cache limits must be positive safe integers");
  return resolved;
};
const encodedBytes = (value: unknown): number => {
  const text = JSON.stringify(value);
  let bytes = 0;
  for (const character of text) {
    const point = character.codePointAt(0)!;
    bytes += point < 128 ? 1 : point < 2048 ? 2 : point < 65536 ? 3 : 4;
  }
  return bytes;
};

/** Instance-local bounded LRU and persistence coordinator. No background polling. */
export class ConversationCache {
  readonly scope: string;
  readonly #options: ConversationCacheOptions;
  readonly #entries = new Map<string, CacheEntry>();
  readonly #expired = new Set<string>();
  readonly #versions = new Map<string, number>();
  readonly #pendingSaves = new Map<
    string,
    { entry: CacheEntry; options: GatewayRequestOptions }
  >();
  #saveScheduled = false;
  readonly #maxConversations: number;
  readonly #maxItems: number;
  readonly #maxBytes: number;
  readonly #staleAfterMs: number;
  readonly #expireAfterMs: number;
  readonly #onEvict: (id: string) => void;
  #epoch = 0;
  #scopeEpoch = 0;
  readonly #conversationEpochs = new Map<string, number>();
  #diskEpoch = 0;
  #disk: DiskScope | undefined;
  #read: Promise<void> | undefined;
  #writes: Promise<void> = Promise.resolve();
  #closed = false;
  #storageError = false;
  readonly #clearedIds = new Set<string>();
  #clearedAll = false;
  readonly #savedAfterClear = new Set<string>();

  constructor(
    options: ConversationCacheOptions,
    onEvict: (id: string) => void,
  ) {
    this.#options = options;
    this.scope = options.scope ?? "default";
    if (this.scope.length === 0)
      throw new TypeError("Cache scope must not be empty");
    this.#maxConversations = positive(options.maxConversations, 20);
    this.#maxItems = positive(options.maxItems, 10_000);
    this.#maxBytes = positive(options.maxBytes, 8_000_000);
    this.#staleAfterMs = positive(options.staleAfterMs, 300_000);
    this.#expireAfterMs = positive(options.expireAfterMs, 86_400_000);
    if (this.#staleAfterMs > this.#expireAfterMs)
      throw new TypeError("Cache freshness must not exceed expiry");
    this.#onEvict = onEvict;
  }

  wasExpired(id: string): boolean {
    return this.#expired.has(id);
  }

  get hasStorage(): boolean {
    return this.#options.storage !== undefined;
  }

  epochFor(id: string): number {
    return Math.max(this.#scopeEpoch, this.#conversationEpochs.get(id) ?? 0);
  }
  get storageError(): boolean {
    return this.#storageError;
  }
  now(): number {
    return (this.#options.now ?? Date.now)();
  }
  freshness(savedAt: number): "fresh" | "stale" | "expired" {
    const age = this.now() - savedAt;
    return age < 0 || age >= this.#expireAfterMs
      ? "expired"
      : age >= this.#staleAfterMs
        ? "stale"
        : "fresh";
  }

  peek(id: string): CacheEntry | undefined {
    const entry = this.#entries.get(id);
    if (entry === undefined) return undefined;
    if (this.freshness(entry.savedAt) === "expired") {
      this.#entries.delete(id);
      this.#expired.add(id);
      this.#notify({
        kind: "expired",
        conversationId: id,
        hadDraft: this.#hasDraft(entry),
      });
      return undefined;
    }
    this.#entries.delete(id);
    this.#entries.set(id, entry);
    return entry;
  }

  async restore(
    id: string,
    options: GatewayRequestOptions,
  ): Promise<CacheEntry | undefined> {
    const epoch = this.epochFor(id);
    await this.#readDisk(options);
    if (this.#closed || epoch !== this.epochFor(id)) return undefined;
    if (
      (this.#clearedAll && !this.#savedAfterClear.has(id)) ||
      this.#clearedIds.has(id)
    )
      return undefined;
    const record = this.#disk?.entries[id]?.record;
    if (record === undefined) return undefined;
    if (this.freshness(record.savedAt) === "expired") {
      this.#expired.add(id);
      this.#notify({
        kind: "expired",
        conversationId: id,
        hadDraft:
          record.draft.text.length > 0 ||
          record.draft.attachmentKeys.length > 0 ||
          record.draft.unavailableAttachments > 0,
      });
      return undefined;
    }
    const entry: CacheEntry = {
      snapshot: record.snapshot,
      draft: { ...emptyComposerDraft(id), text: record.draft.text },
      savedAt: record.savedAt,
      bytes: encodedBytes(record),
      attachmentKeys: record.draft.attachmentKeys,
      unavailableAttachments: record.draft.unavailableAttachments,
    };
    this.#entries.set(id, entry);
    this.#trim(id);
    return entry;
  }

  async restoreAttachments(
    entry: CacheEntry,
    options: GatewayRequestOptions,
  ): Promise<{
    attachments: readonly UploadedAttachment[];
    unavailable: number;
  }> {
    const attachments: UploadedAttachment[] = [];
    let unavailable = entry.unavailableAttachments ?? 0;
    for (const key of entry.attachmentKeys ?? []) {
      try {
        const attachment = await this.#options.attachments?.resolve(
          key,
          options,
        );
        if (attachment === undefined) unavailable += 1;
        else attachments.push(attachment);
      } catch {
        unavailable += 1;
      }
    }
    return { attachments, unavailable };
  }

  updateDraft(
    conversationId: string,
    draft: ComposerDraft,
    options: GatewayRequestOptions,
    preserveAttachmentKeys = true,
  ): void {
    const entry = this.#entries.get(conversationId);
    if (entry !== undefined) {
      if (!preserveAttachmentKeys) {
        const resolved: CacheEntry = {
          snapshot: entry.snapshot,
          draft: entry.draft,
          savedAt: entry.savedAt,
          bytes: entry.bytes,
        };
        this.#entries.set(conversationId, resolved);
      }
      this.put(entry.snapshot, draft, options, entry.savedAt);
    }
  }

  setUnavailableAttachments(
    id: string,
    count: number,
    options: GatewayRequestOptions,
  ): void {
    const current = this.#entries.get(id);
    if (current === undefined) return;
    const entry = { ...current, unavailableAttachments: count };
    this.#entries.set(id, entry);
    if (this.#options.storage !== undefined) {
      this.#pendingSaves.set(id, { entry, options });
      this.#scheduleSaves();
    }
  }

  put(
    snapshot: ChatSnapshot,
    draft: ComposerDraft,
    options: GatewayRequestOptions,
    savedAt = this.now(),
  ): void {
    if (this.#closed) return;
    const id = snapshot.conversation.id;
    const previous = this.#entries.get(id);
    if (previous?.snapshot === snapshot && previous.draft === draft) return;
    const bytes = encodedBytes({ snapshot, draft });
    if (bytes > this.#maxBytes || snapshot.timeline.length > this.#maxItems) {
      this.#entries.delete(id);
      this.#notify({
        kind: "evicted",
        conversationId: id,
        hadDraft: this.#hasDraft({ draft }),
      });
      return;
    }
    this.#expired.delete(id);
    const entry: CacheEntry = {
      snapshot,
      draft,
      savedAt,
      bytes,
      ...(previous?.attachmentKeys === undefined
        ? {}
        : {
            attachmentKeys: previous.attachmentKeys,
          }),
      ...(previous?.unavailableAttachments === undefined
        ? {}
        : { unavailableAttachments: previous.unavailableAttachments }),
    };
    this.#entries.delete(id);
    this.#entries.set(id, entry);
    this.#trim(id);
    if (this.#options.storage === undefined) return;
    this.#pendingSaves.set(id, { entry, options });
    this.#scheduleSaves();
  }

  #scheduleSaves(): void {
    if (this.#saveScheduled || this.#pendingSaves.size === 0) return;
    this.#saveScheduled = true;
    void this.#queue(async () => {
      const batch = [...this.#pendingSaves];
      this.#pendingSaves.clear();
      try {
        for (const [id, pending] of batch)
          await this.#save(id, pending.entry, pending.options);
      } finally {
        this.#saveScheduled = false;
        this.#scheduleSaves();
      }
    }).catch(() => undefined);
  }

  async #save(
    id: string,
    entry: CacheEntry,
    options: GatewayRequestOptions,
  ): Promise<void> {
    const epoch = this.#epoch;
    const { snapshot, draft, savedAt } = entry;
    await this.#readDisk(options);
    const keys =
      entry.attachmentKeys ??
      draft.attachments.flatMap((attachment) => {
        const key = this.#options.attachments?.identify(attachment);
        return key === undefined ||
          key.length === 0 ||
          key.length > 1024 ||
          /[:/?#\s]/.test(key)
          ? []
          : [key];
      });
    const projected = createCacheRecord(
      this.scope,
      snapshot,
      draft,
      savedAt,
      keys,
    );
    const record: ConversationCacheRecord = {
      ...projected,
      draft: {
        ...projected.draft,
        unavailableAttachments:
          entry.unavailableAttachments ??
          projected.draft.unavailableAttachments,
      },
    };
    const expected = this.#versions.get(id) ?? 0;
    const expectedEpoch = this.#diskEpoch;
    let committed: DiskScope | undefined;
    await this.#options.storage!.update(
      this.scope,
      (raw) => {
        const disk = this.#parseDisk(raw);
        if (
          disk.epoch !== expectedEpoch ||
          (disk.entries[id]?.revision ?? 0) !== expected
        ) {
          this.#notify({ kind: "write-conflict", conversationId: id });
          return raw;
        }
        disk.entries[id] = { revision: expected + 1, record };
        this.#trimDisk(disk, id);
        const encoded = JSON.stringify(disk);
        if (encodedBytes(disk) > this.#maxBytes) return raw;
        committed = disk;
        return encoded;
      },
      options,
    );
    if (committed !== undefined) {
      if (epoch === this.#epoch) {
        this.#clearedIds.delete(id);
        this.#savedAfterClear.add(id);
      }
      this.#versions.clear();
      for (const [key, value] of Object.entries(committed.entries))
        this.#versions.set(key, value.revision);
      this.#disk = committed;
    }
  }

  async clear(
    id: string | undefined,
    options: GatewayRequestOptions,
  ): Promise<void> {
    this.#epoch += 1;
    if (id === undefined) {
      this.#scopeEpoch = this.#epoch;
      this.#conversationEpochs.clear();
    } else this.#conversationEpochs.set(id, this.#epoch);
    if (id === undefined) {
      this.#clearedAll = true;
      this.#savedAfterClear.clear();
    } else {
      this.#clearedIds.add(id);
      this.#savedAfterClear.delete(id);
    }
    if (id === undefined) {
      this.#entries.clear();
      this.#pendingSaves.clear();
    } else {
      this.#entries.delete(id);
      this.#pendingSaves.delete(id);
    }
    this.#notify(
      id === undefined
        ? { kind: "cleared" }
        : { kind: "cleared", conversationId: id },
    );
    await this.#queue(async () => {
      await this.#readDisk(options);
      let committed: DiskScope | undefined;
      await this.#options.storage?.update(
        this.scope,
        (raw) => {
          let disk: DiskScope;
          try {
            disk = this.#parseDisk(raw);
          } catch {
            disk = emptyDisk();
          }
          disk.epoch += 1;
          if (id === undefined)
            disk.entries = Object.create(null) as Record<string, DiskEntry>;
          else delete disk.entries[id];
          committed = disk;
          return JSON.stringify(disk);
        },
        options,
      );
      if (committed !== undefined) {
        this.#diskEpoch = committed.epoch;
        this.#disk = committed;
        this.#versions.clear();
        for (const [key, entry] of Object.entries(committed.entries))
          this.#versions.set(key, entry.revision);
      }
      if (this.#options.storage === undefined) this.#disk = undefined;
    });
  }

  async flush(): Promise<void> {
    let pending: Promise<void>;
    do {
      pending = this.#writes;
      await pending;
    } while (pending !== this.#writes);
  }
  close(): Promise<void> {
    this.#closed = true;
    this.#epoch += 1;
    this.#entries.clear();
    return this.flush();
  }

  #hasDraft(entry: Pick<CacheEntry, "draft">): boolean {
    return entry.draft.text.length > 0 || entry.draft.attachments.length > 0;
  }
  #trim(active: string): void {
    let items = 0;
    let bytes = 0;
    for (const entry of this.#entries.values()) {
      items += entry.snapshot.timeline.length;
      bytes += entry.bytes;
    }
    for (const [id, entry] of this.#entries) {
      if (
        this.#entries.size <= this.#maxConversations &&
        items <= this.#maxItems &&
        bytes <= this.#maxBytes
      )
        break;
      if (id === active) continue;
      this.#entries.delete(id);
      this.#pendingSaves.delete(id);
      items -= entry.snapshot.timeline.length;
      bytes -= entry.bytes;
      this.#onEvict(id);
      this.#notify({
        kind: "evicted",
        conversationId: id,
        hadDraft: this.#hasDraft(entry),
      });
    }
  }
  #trimDisk(disk: DiskScope, active: string): void {
    const entries = Object.entries(disk.entries).sort(
      (a, b) => a[1].record.savedAt - b[1].record.savedAt,
    );
    let items = entries.reduce(
      (sum, [, entry]) => sum + entry.record.snapshot.timeline.length,
      0,
    );
    for (const [id, entry] of entries) {
      if (
        Object.keys(disk.entries).length <= this.#maxConversations &&
        items <= this.#maxItems &&
        encodedBytes(disk) <= this.#maxBytes
      )
        break;
      if (id === active) continue;
      delete disk.entries[id];
      items -= entry.record.snapshot.timeline.length;
    }
  }
  #parseDisk(raw: string | null): DiskScope {
    if (raw === null) return emptyDisk();
    if (raw.length > this.#maxBytes || encodedBytes(raw) > this.#maxBytes * 2)
      throw new TypeError("Cache record exceeds size limit");
    const value: unknown = JSON.parse(raw);
    if (
      typeof value !== "object" ||
      value === null ||
      !("version" in value) ||
      value.version !== 1 ||
      !("epoch" in value) ||
      !Number.isSafeInteger(value.epoch) ||
      Number(value.epoch) < 0 ||
      !("entries" in value) ||
      typeof value.entries !== "object" ||
      value.entries === null ||
      Array.isArray(value.entries)
    ) {
      throw new TypeError("Cache record version or shape is invalid");
    }
    const result = emptyDisk();
    result.epoch = Number(value.epoch);
    for (const [id, candidate] of Object.entries(value.entries)) {
      if (
        typeof candidate !== "object" ||
        candidate === null ||
        !("record" in candidate) ||
        !("revision" in candidate) ||
        !Number.isSafeInteger(candidate.revision) ||
        Number(candidate.revision) <= 0
      )
        continue;
      const record = parseCacheRecord(candidate.record, this.scope, id);
      if (
        record !== undefined &&
        record.snapshot.timeline.length <= this.#maxItems &&
        encodedBytes(record) <= this.#maxBytes
      )
        result.entries[id] = { revision: Number(candidate.revision), record };
      else this.#notify({ kind: "invalid-record", conversationId: id });
    }
    return result;
  }
  #readDisk(options: GatewayRequestOptions): Promise<void> {
    if (this.#read !== undefined) return this.#read;
    this.#read = (async () => {
      const raw =
        (await this.#options.storage?.read(this.scope, options)) ?? null;
      this.#disk = this.#parseDisk(raw);
      this.#diskEpoch = this.#disk.epoch;
      for (const [id, entry] of Object.entries(this.#disk.entries))
        this.#versions.set(id, entry.revision);
    })().catch(() => {
      this.#storageError = true;
      this.#notify({ kind: "storage-error" });
    });
    return this.#read;
  }
  #queue(operation: () => Promise<void>): Promise<void> {
    const task = this.#writes.then(operation);
    this.#writes = task.catch(() => {
      this.#storageError = true;
      this.#notify({ kind: "storage-error" });
    });
    return task;
  }
  #notify(event: ConversationCacheEvent): void {
    if (
      event.kind === "storage-error" ||
      event.kind === "invalid-record" ||
      event.kind === "write-conflict"
    )
      this.#storageError = true;
    try {
      this.#options.onEvent?.(cloneImmutable(event));
    } catch {
      /* Diagnostic consumers cannot stop cache operations. */
    }
  }
}

/** Latest pages replace overlapping items, while retaining already loaded older coverage. */
export const mergeCachedHistory = (
  latest: ChatSnapshot,
  cached: ChatSnapshot | undefined,
): ChatSnapshot => {
  if (cached === undefined || !latest.pageInfo.hasPreviousPage) return latest;
  const cachedOldest = cached.timeline[0];
  const latestOldest = latest.timeline[0];
  const cachedKeys = new Set(cached.timeline.map(getTimelineItemKey));
  const overlaps = latest.timeline.some((item) =>
    cachedKeys.has(getTimelineItemKey(item)),
  );
  return {
    ...latest,
    timeline: mergeHistoryTimeline(
      createTimelineState(latest.timeline),
      cached.timeline,
    ).items,
    pageInfo:
      overlaps &&
      cachedOldest !== undefined &&
      latestOldest !== undefined &&
      compareTimelineItems(cachedOldest, latestOldest) < 0
        ? cached.pageInfo
        : latest.pageInfo,
  };
};
