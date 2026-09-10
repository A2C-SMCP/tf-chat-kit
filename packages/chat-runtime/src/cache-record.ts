import {
  chatSnapshotSchema,
  sanitizeDiagnosticText,
  type ChatSnapshot,
  type TimelineItem,
} from "@turingfocus/chat-protocol";

import {
  resolveComposerDraftText,
  type ComposerDraft,
} from "./composer-draft.js";

/** A display-only disk projection, deliberately distinct from ChatSnapshot. */
export interface ConversationCacheRecord {
  readonly version: 1;
  readonly scope: string;
  readonly conversationId: string;
  readonly savedAt: number;
  readonly snapshot: ChatSnapshot;
  readonly draft: {
    readonly text: string;
    readonly attachmentKeys: readonly string[];
    readonly unavailableAttachments: number;
  };
}

// Resource URLs and structured tool/raw payloads are not a persistence contract.
// Plain authored text is retained, with recognizable credential material removed.
const cacheText = (text: string): string =>
  sanitizeDiagnosticText(text)
    .replace(
      /(?:https?:\/\/[^\s<>"')]+[?#][^\s<>"')]*|(?:blob|data):[^\s<>"')]+)/gi,
      "[resource requires revalidation]",
    )
    .replace(
      /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi,
      "[credential removed]",
    )
    .replace(
      /\b(token|password|secret|api[_-]?key|authorization|cookie)\s*[:=]\s*[^\s,;]+/gi,
      "$1=[removed]",
    );

const persistedItem = (item: TimelineItem): TimelineItem => {
  const base = {
    id: item.id,
    conversationId: item.conversationId,
    createdAt: item.createdAt,
    ...(item.sequence === undefined ? {} : { sequence: item.sequence }),
    ...(item.updatedAt === undefined ? {} : { updatedAt: item.updatedAt }),
  };
  if (item.kind === "message") {
    return {
      ...base,
      kind: "message",
      role: item.role,
      content:
        item.content.kind === "text"
          ? { kind: "text", text: cacheText(item.content.text) }
          : {
              kind: "unknown",
              summary: "Cached resource; reconnect to restore content.",
            },
    };
  }
  if (item.kind === "agent-event")
    return {
      ...base,
      kind: "agent-event",
      eventCategory: item.eventCategory,
      eventType: item.eventType,
      status: "unknown",
      summary: cacheText(
        item.summary ?? "Cached event; reconnect for details.",
      ),
      transitions: [
        {
          id: "cache",
          status: "unknown",
          occurredAt: item.createdAt,
          ...(item.eventCategory === "tool"
            ? { toolReturn: { result: "Cached event; reconnect for details." } }
            : {}),
        },
      ],
    };
  return {
    ...base,
    kind: "unknown-event",
    originalType: item.originalType,
    summary: cacheText(item.summary ?? "Cached event; reconnect for details."),
  };
};

/** Cached state is readable, but never grants live command or interaction rights. */
export const cachedDisplaySnapshot = (
  snapshot: ChatSnapshot,
): ChatSnapshot => ({
  conversation: snapshot.conversation,
  timeline: snapshot.timeline,
  pageInfo: snapshot.pageInfo,
  run: null,
  capabilities: {
    ...snapshot.capabilities,
    answerInteraction: false,
    interrupt: false,
    sendText: false,
    sendAttachments: false,
    loadHistory: false,
  },
  lifecycle: { status: "offline", generation: 0, subscriptionId: "cache" },
});

export const createCacheRecord = (
  scope: string,
  snapshot: ChatSnapshot,
  draft: ComposerDraft,
  savedAt: number,
  attachmentKeys: readonly string[],
): ConversationCacheRecord => ({
  version: 1,
  scope,
  conversationId: snapshot.conversation.id,
  savedAt,
  snapshot: cachedDisplaySnapshot({
    ...snapshot,
    conversation: {
      id: snapshot.conversation.id,
      title: cacheText(snapshot.conversation.title),
      ...(snapshot.conversation.updatedAt === undefined
        ? {}
        : { updatedAt: snapshot.conversation.updatedAt }),
    },
    timeline: snapshot.timeline.map(persistedItem),
  }),
  draft: {
    text: cacheText(resolveComposerDraftText(draft)),
    attachmentKeys,
    unavailableAttachments: draft.attachments.length - attachmentKeys.length,
  },
});

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const parseCacheRecord = (
  value: unknown,
  scope: string,
  conversationId: string,
): ConversationCacheRecord | undefined => {
  if (
    !isObject(value) ||
    value["version"] !== 1 ||
    value["scope"] !== scope ||
    value["conversationId"] !== conversationId ||
    typeof value["savedAt"] !== "number" ||
    !Number.isFinite(value["savedAt"]) ||
    value["savedAt"] < 0 ||
    !isObject(value["draft"])
  )
    return undefined;
  const draft = value["draft"];
  if (
    typeof draft["text"] !== "string" ||
    !Array.isArray(draft["attachmentKeys"]) ||
    draft["attachmentKeys"].length > 100 ||
    !draft["attachmentKeys"].every(
      (key): key is string =>
        typeof key === "string" && key.length > 0 && key.length <= 1024,
    ) ||
    typeof draft["unavailableAttachments"] !== "number" ||
    !Number.isSafeInteger(draft["unavailableAttachments"]) ||
    draft["unavailableAttachments"] < 0
  )
    return undefined;
  const parsed = chatSnapshotSchema.safeParse(value["snapshot"]);
  if (!parsed.success || parsed.data.conversation.id !== conversationId)
    return undefined;
  // Validate and project again: storage is untrusted and cannot inject commands,
  // raw payloads, or active resource links into a restored view.
  return {
    version: 1,
    scope,
    conversationId,
    savedAt: value["savedAt"],
    snapshot: cachedDisplaySnapshot({
      ...parsed.data,
      conversation: {
        id: parsed.data.conversation.id,
        title: cacheText(parsed.data.conversation.title),
      },
      timeline: parsed.data.timeline.map(persistedItem),
    }),
    draft: {
      text: cacheText(draft["text"]),
      attachmentKeys: draft["attachmentKeys"],
      unavailableAttachments: draft["unavailableAttachments"],
    },
  };
};
