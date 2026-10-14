import type { Message } from "@turingfocus/chat-protocol";

import type { MessageDto } from "./dto.js";
import { mapMessage } from "./mapper.js";

const MAX_RECENT_SIGNATURES = 256;
const SERVER_ENRICHMENT_KEYS = new Set([
  "chain_result",
  "__tf_parent_uuid",
  "__tf_element_uuid",
]);

interface Identity {
  readonly signature: string;
  readonly baseSignature: string;
  enrichment: Readonly<Record<string, unknown>>;
  readonly canonicalId: string;
  persistedId: string | undefined;
  ambiguous: boolean;
}

interface PersistedAlias {
  readonly canonicalId: string;
  readonly persistedId: string;
  confirmedHistory?: {
    readonly author: Message["author"];
    readonly revision: number;
  };
}

interface ConversationIdentities {
  // Small author/revision metadata shares the stable database alias lifecycle.
  // Do not retain the full DTO/content beyond the bounded signature window.
  readonly aliases: Map<string, PersistedAlias>;
  readonly unpersistedAliases: Map<string, string>;
  readonly recent: Map<string, Identity>;
  readonly canonicalIds: Set<string>;
  nextProvisionalId: number;
  latestObservedHistoryAt: number | undefined;
}

const stableJson = (value: unknown): string =>
  JSON.stringify(value, (_key, entry: unknown) =>
    entry !== null && typeof entry === "object" && !Array.isArray(entry)
      ? Object.fromEntries(
          Object.entries(entry).sort(([left], [right]) =>
            left.localeCompare(right),
          ),
        )
      : entry,
  );

const messageSignatures = (dto: MessageDto, message: Message) => {
  const identityDto = {
    ...dto,
    // Retain identity and loose business extensions; name/avatar are mutable display.
    // Confirmed processing additions are compared separately below.
    msgId: undefined,
    conversationId: message.conversationId,
    ...(dto.creator != null &&
    (typeof dto.creator.uid === "string" || typeof dto.creator.uid === "number")
      ? {
          creator: {
            ...Object.fromEntries(
              Object.entries(dto.creator).filter(
                ([key]) => key !== "name" && key !== "avatar",
              ),
            ),
            uid: String(dto.creator.uid),
          },
        }
      : {}),
  };
  const additional = dto.additionalKwargs;
  const entries =
    additional !== null &&
    typeof additional === "object" &&
    !Array.isArray(additional)
      ? Object.entries(additional)
      : undefined;
  const enrichment = Object.fromEntries(
    entries?.filter(([key]) => SERVER_ENRICHMENT_KEYS.has(key)) ?? [],
  );
  const signature = stableJson(identityDto);
  const baseSignature = stableJson({
    ...identityDto,
    ...(entries === undefined
      ? {}
      : {
          additionalKwargs: Object.fromEntries(
            entries.filter(([key]) => !SERVER_ENRICHMENT_KEYS.has(key)),
          ),
        }),
  });
  return { signature, baseSignature, enrichment };
};

/** Current-server emits user messages before their database ID is assigned. */
export class TFRobotMessageIdentities {
  readonly #conversations = new Map<string, ConversationIdentities>();
  #historyReadRevision = 0;
  // A transient display key is not a globally stable message identity. Keep
  // independent Gateway instances from joining cached null-ID facts by time.
  readonly #provisionalNamespace = Array.from(
    globalThis.crypto.getRandomValues(new Uint32Array(4)),
    (part) => part.toString(16).padStart(8, "0"),
  ).join("");

  /** Capture before awaiting HTTP so stale completion cannot undo a newer read. */
  beginHistoryRead(): number {
    return ++this.#historyReadRevision;
  }

  map(
    dto: MessageDto,
    source: "history" | "live" = "live",
    readRevision?: number,
  ): Message {
    const historyRevision =
      source === "history" ? (readRevision ?? this.beginHistoryRead()) : 0;
    const persistedId = dto.msgId == null ? undefined : String(dto.msgId);
    const message: Message = {
      ...mapMessage(dto),
      provenance:
        persistedId === undefined
          ? { kind: "provisional", source }
          : { kind: "persisted", id: persistedId, source },
    };
    let state = this.#conversations.get(message.conversationId);
    if (state === undefined) {
      state = {
        aliases: new Map(),
        unpersistedAliases: new Map(),
        recent: new Map(),
        canonicalIds: new Set(),
        nextProvisionalId: 0,
        latestObservedHistoryAt: undefined,
      };
      this.#conversations.set(message.conversationId, state);
    }
    if (source === "history" && persistedId !== undefined)
      state.latestObservedHistoryAt = Math.max(
        state.latestObservedHistoryAt ?? message.createdAt,
        message.createdAt,
      );
    const observedAt = state.latestObservedHistoryAt;
    // Ordering only marks uncertainty. It never aliases or deletes a fact,
    // including messages from a different UID or a backwards-moving clock.
    const reviewHint = (mapped: Message, ambiguous = false): Message =>
      mapped.provenance?.kind === "provisional" &&
      (ambiguous ||
        (source === "live" &&
          observedAt !== undefined &&
          mapped.createdAt <= observedAt))
        ? {
            ...mapped,
            provenance: { ...mapped.provenance, reviewRequired: true },
          }
        : mapped;
    const alias =
      persistedId === undefined ? undefined : state.aliases.get(persistedId);
    if (alias !== undefined) {
      const identity = state.recent.get(alias.canonicalId);
      if (
        message.role === "user" &&
        source === "history" &&
        identity !== undefined &&
        historyRevision >= (alias.confirmedHistory?.revision ?? 0)
      ) {
        state.recent.set(alias.canonicalId, {
          ...identity,
          ...messageSignatures(dto, message),
        });
      }
      return this.#confirmedMessage(
        { ...message, id: alias.canonicalId },
        alias,
        source,
        historyRevision,
      );
    }
    const allocateId = (): string => {
      const baseId =
        persistedId === undefined
          ? `${message.id}:${this.#provisionalNamespace}`
          : message.id;
      let id = baseId;
      while (state.canonicalIds.has(id)) {
        id = `${baseId}:provisional-${++state.nextProvisionalId}`;
      }
      return id;
    };
    // All roles share Runtime's message ID space. Reserve explicit IDs for
    // every role, but never infer assistant persistence from evolving content.
    if (message.role !== "user") {
      const provisionalKey = stableJson({
        role: message.role,
        createdAt: message.createdAt,
        author: message.author,
      });
      const canonicalId =
        persistedId === undefined
          ? (state.unpersistedAliases.get(provisionalKey) ?? allocateId())
          : allocateId();
      state.canonicalIds.add(canonicalId);
      if (persistedId === undefined)
        state.unpersistedAliases.set(provisionalKey, canonicalId);
      const mapped =
        canonicalId === message.id ? message : { ...message, id: canonicalId };
      if (persistedId === undefined) return reviewHint(mapped);
      const persistedAlias: PersistedAlias = { canonicalId, persistedId };
      state.aliases.set(persistedId, persistedAlias);
      return this.#confirmedMessage(
        mapped,
        persistedAlias,
        source,
        historyRevision,
      );
    }
    const { signature, baseSignature, enrichment } = messageSignatures(
      dto,
      message,
    );
    const compatible = [...state.recent.values()].filter(
      (candidate) =>
        candidate.baseSignature === baseSignature &&
        Object.entries(enrichment).every(
          ([key, value]) =>
            !Object.hasOwn(candidate.enrichment, key) ||
            stableJson(candidate.enrichment[key]) === stableJson(value),
        ),
    );
    // Repeated provisional delivery retains its own identity, including an
    // unbound ambiguous occurrence. Known database IDs are handled by aliases.
    let identity =
      persistedId === undefined
        ? [...state.recent.values()].find(
            (candidate) =>
              candidate.persistedId === undefined &&
              candidate.signature === signature,
          )
        : undefined;
    const candidates = compatible.filter((candidate) =>
      persistedId === undefined
        ? candidate.persistedId !== undefined
        : candidate.persistedId === undefined && !candidate.ambiguous,
    );
    if (identity === undefined && candidates.length === 1)
      identity = candidates[0];
    let canonicalId: string;
    if (identity === undefined) {
      canonicalId = allocateId();
      identity = {
        canonicalId,
        signature,
        baseSignature,
        enrichment,
        persistedId,
        ambiguous: persistedId === undefined && candidates.length > 1,
      };
    } else {
      canonicalId = identity.canonicalId;
      if (persistedId !== undefined) identity.persistedId = persistedId;
      identity.enrichment = { ...identity.enrichment, ...enrichment };
    }
    // Keep each distinct persisted fact independently, so enrichment cannot
    // turn an ambiguous provisional message into an arbitrary database alias.
    state.recent.delete(canonicalId);
    state.recent.set(canonicalId, identity);
    state.canonicalIds.add(canonicalId);
    let persistedAlias: PersistedAlias | undefined;
    if (persistedId !== undefined) {
      persistedAlias = { canonicalId, persistedId };
      state.aliases.set(persistedId, persistedAlias);
    } else if (identity.persistedId !== undefined) {
      persistedAlias = state.aliases.get(identity.persistedId);
    }
    if (state.recent.size > MAX_RECENT_SIGNATURES) {
      state.recent.delete(state.recent.keys().next().value!);
    }
    return this.#confirmedMessage(
      reviewHint(
        canonicalId === message.id ? message : { ...message, id: canonicalId },
        identity.ambiguous,
      ),
      persistedAlias,
      source,
      historyRevision,
    );
  }

  #confirmedMessage(
    message: Message,
    alias: PersistedAlias | undefined,
    source: "history" | "live",
    historyRevision: number,
  ): Message {
    if (alias === undefined) return message;
    if (
      source === "history" &&
      historyRevision >= (alias.confirmedHistory?.revision ?? 0)
    ) {
      alias.confirmedHistory = {
        author: message.author,
        revision: historyRevision,
      };
    }
    const confirmed = alias.confirmedHistory;
    return confirmed === undefined
      ? message
      : {
          ...message,
          author: confirmed.author,
          provenance: { kind: "persisted", id: alias.persistedId, source },
        };
  }

  forgetConversation(conversationId: string): void {
    this.#conversations.delete(conversationId);
  }

  clear(): void {
    this.#conversations.clear();
  }
}
