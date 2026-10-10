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

interface ConversationIdentities {
  readonly aliases: Map<string, string>;
  readonly unpersistedAliases: Map<string, string>;
  readonly recent: Map<string, Identity>;
  readonly canonicalIds: Set<string>;
  nextProvisionalId: number;
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

/** Current-server emits user messages before their database ID is assigned. */
export class TFRobotMessageIdentities {
  readonly #conversations = new Map<string, ConversationIdentities>();

  map(dto: MessageDto): Message {
    const message = mapMessage(dto);
    let state = this.#conversations.get(message.conversationId);
    if (state === undefined) {
      state = {
        aliases: new Map(),
        unpersistedAliases: new Map(),
        recent: new Map(),
        canonicalIds: new Set(),
        nextProvisionalId: 0,
      };
      this.#conversations.set(message.conversationId, state);
    }
    const persistedId = dto.msgId == null ? undefined : String(dto.msgId);
    const alias =
      persistedId === undefined ? undefined : state.aliases.get(persistedId);
    if (alias !== undefined) return { ...message, id: alias };
    const allocateId = (): string => {
      let id = message.id;
      while (state.canonicalIds.has(id)) {
        id = `${message.id}:provisional-${++state.nextProvisionalId}`;
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
      else state.aliases.set(persistedId, canonicalId);
      return canonicalId === message.id
        ? message
        : { ...message, id: canonicalId };
    }
    const identityDto = {
      ...dto,
      // Retain the complete business DTO, including loose creator extensions.
      // Confirmed processing additions are compared separately below.
      msgId: undefined,
      conversationId: message.conversationId,
      ...(dto.creator != null &&
      (typeof dto.creator.uid === "string" ||
        typeof dto.creator.uid === "number")
        ? { creator: { ...dto.creator, uid: String(dto.creator.uid) } }
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
    if (persistedId !== undefined) state.aliases.set(persistedId, canonicalId);
    if (state.recent.size > MAX_RECENT_SIGNATURES) {
      state.recent.delete(state.recent.keys().next().value!);
    }
    return canonicalId === message.id
      ? message
      : { ...message, id: canonicalId };
  }

  forgetConversation(conversationId: string): void {
    this.#conversations.delete(conversationId);
  }

  clear(): void {
    this.#conversations.clear();
  }
}
