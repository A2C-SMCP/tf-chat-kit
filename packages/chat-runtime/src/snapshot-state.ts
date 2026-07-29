import {
  compareAgentEventTransitions,
  hasCompatibleAgentEventMetadata,
  type AgentEvent,
  type AgentEventTransitionUpdate,
  type AskUserInteractionRequest,
  type ChatError,
  type ChatSnapshot,
  type ChatUpdate,
} from "@turingfocus/chat-protocol";

import { cloneImmutable, deepEqual } from "./immutable.js";
import {
  createTimelineState,
  findEventTimelineItem,
  rebaseTimelineState,
  type TimelineState,
  upsertTimelineItem,
} from "./timeline.js";

export interface SnapshotState {
  readonly snapshot: ChatSnapshot;
  readonly timeline: TimelineState;
}

const freezeSnapshot = (snapshot: ChatSnapshot): ChatSnapshot =>
  Object.freeze(snapshot);

export const createSnapshotState = (snapshot: ChatSnapshot): SnapshotState => {
  const timeline = createTimelineState(snapshot.timeline);
  return {
    timeline,
    snapshot: freezeSnapshot({
      conversation: cloneImmutable(snapshot.conversation),
      timeline: timeline.items,
      run: cloneImmutable(snapshot.run),
      capabilities: cloneImmutable(snapshot.capabilities),
      pageInfo: cloneImmutable(snapshot.pageInfo),
      ...(snapshot.pendingInteraction === undefined
        ? {}
        : { pendingInteraction: cloneImmutable(snapshot.pendingInteraction) }),
      ...(snapshot.error === undefined
        ? {}
        : { error: cloneImmutable(snapshot.error) }),
    }),
  };
};

export const updateSnapshotState = (
  state: SnapshotState,
  changes: Partial<Omit<ChatSnapshot, "timeline">> & {
    readonly timeline?: TimelineState | undefined;
  },
): SnapshotState => {
  const timeline = changes.timeline ?? state.timeline;
  const snapshot = freezeSnapshot({
    ...state.snapshot,
    ...changes,
    timeline: timeline.items,
  });
  return { timeline, snapshot };
};

const rebaseValue = <T>(baseline: T, loaded: T, current: T): T =>
  deepEqual(current, baseline) ? loaded : current;

const interactionMetadataError = (conversationId: string): ChatError =>
  cloneImmutable({
    code: "validation",
    message: "Conflicting metadata was received for an interaction revision",
    retryable: false,
    conversationId,
  });

const hasSameInteractionIdentity = (
  left: AskUserInteractionRequest | undefined,
  right: AskUserInteractionRequest | undefined,
): boolean =>
  left !== undefined &&
  right !== undefined &&
  left.requestId === right.requestId &&
  left.revision === right.revision;

const hasConflictingInteractionMetadata = (
  existing: AskUserInteractionRequest | undefined,
  incoming: AskUserInteractionRequest | undefined,
): boolean =>
  hasSameInteractionIdentity(existing, incoming) &&
  !deepEqual(existing, incoming);

/**
 * Three-way merge a full reload with state published after that reload began.
 * This keeps reload publication atomic without discarding newer subscription or
 * history changes.
 */
export const rebaseSnapshotState = (
  baseline: SnapshotState,
  loaded: SnapshotState,
  current: SnapshotState,
): SnapshotState => {
  const timeline = rebaseTimelineState(
    baseline.timeline,
    loaded.timeline,
    current.timeline,
  );
  const rebasedError = rebaseValue(
    baseline.snapshot.error,
    loaded.snapshot.error,
    current.snapshot.error,
  );
  const pendingWasUnchanged = deepEqual(
    current.snapshot.pendingInteraction,
    baseline.snapshot.pendingInteraction,
  );
  const hasLoadedInteractionConflict =
    pendingWasUnchanged &&
    hasConflictingInteractionMetadata(
      current.snapshot.pendingInteraction,
      loaded.snapshot.pendingInteraction,
    );
  const pendingInteraction = hasLoadedInteractionConflict
    ? current.snapshot.pendingInteraction
    : rebaseValue(
        baseline.snapshot.pendingInteraction,
        loaded.snapshot.pendingInteraction,
        current.snapshot.pendingInteraction,
      );
  const error = hasLoadedInteractionConflict
    ? interactionMetadataError(current.snapshot.conversation.id)
    : rebasedError;
  const rebased: SnapshotState = {
    timeline,
    snapshot: freezeSnapshot({
      conversation: rebaseValue(
        baseline.snapshot.conversation,
        loaded.snapshot.conversation,
        current.snapshot.conversation,
      ),
      timeline: timeline.items,
      run: rebaseValue(
        baseline.snapshot.run,
        loaded.snapshot.run,
        current.snapshot.run,
      ),
      capabilities: rebaseValue(
        baseline.snapshot.capabilities,
        loaded.snapshot.capabilities,
        current.snapshot.capabilities,
      ),
      pageInfo: rebaseValue(
        baseline.snapshot.pageInfo,
        loaded.snapshot.pageInfo,
        current.snapshot.pageInfo,
      ),
      ...(pendingInteraction === undefined ? {} : { pendingInteraction }),
      ...(error === undefined ? {} : { error }),
    }),
  };

  if (deepEqual(rebased.snapshot, current.snapshot)) return current;
  if (deepEqual(rebased.snapshot, loaded.snapshot)) return loaded;
  return rebased;
};

const eventMetadataError = (conversationId: string): ChatError =>
  cloneImmutable({
    code: "validation",
    message: "Conflicting metadata was received for an existing agent event",
    retryable: false,
    conversationId,
  });

const retainedEventFields = (
  existing?: AgentEvent,
): Pick<AgentEvent, "raw"> | Record<never, never> =>
  existing?.raw === undefined ? {} : { raw: existing.raw };

const buildAgentEvent = (
  update: AgentEventTransitionUpdate,
  existing?: AgentEvent,
): AgentEvent => {
  if (update.event.eventCategory === "tool") {
    const byId = new Map(
      existing?.eventCategory === "tool"
        ? existing.transitions.map((transition) => [transition.id, transition])
        : [],
    );
    const transition = cloneImmutable(update.event.transition);
    byId.set(transition.id, transition);
    const transitions = Object.freeze(
      [...byId.values()].sort(compareAgentEventTransitions),
    );
    const latest = transitions.at(-1)!;
    return cloneImmutable({
      kind: "agent-event",
      eventCategory: "tool",
      id: update.event.id,
      conversationId: update.conversationId,
      eventType: update.event.eventType,
      status: latest.status,
      createdAt: update.event.createdAt,
      updatedAt: latest.occurredAt,
      ...(update.event.sequence === undefined
        ? {}
        : { sequence: update.event.sequence }),
      ...(latest.summary === undefined
        ? existing?.summary === undefined
          ? {}
          : { summary: existing.summary }
        : { summary: latest.summary }),
      ...retainedEventFields(existing),
      transitions,
    });
  }

  const byId = new Map(
    existing?.eventCategory === "generic"
      ? existing.transitions.map((transition) => [transition.id, transition])
      : [],
  );
  const transition = cloneImmutable(update.event.transition);
  byId.set(transition.id, transition);
  const transitions = Object.freeze(
    [...byId.values()].sort(compareAgentEventTransitions),
  );
  const latest = transitions.at(-1)!;
  return cloneImmutable({
    kind: "agent-event",
    eventCategory: "generic",
    id: update.event.id,
    conversationId: update.conversationId,
    eventType: update.event.eventType,
    status: latest.status,
    createdAt: update.event.createdAt,
    updatedAt: latest.occurredAt,
    ...(update.event.sequence === undefined
      ? {}
      : { sequence: update.event.sequence }),
    ...(latest.summary === undefined
      ? existing?.summary === undefined
        ? {}
        : { summary: existing.summary }
      : { summary: latest.summary }),
    ...retainedEventFields(existing),
    transitions,
  });
};

const applyTransition = (
  state: SnapshotState,
  update: AgentEventTransitionUpdate,
): SnapshotState => {
  const existing = findEventTimelineItem(state.timeline, update.event.id);
  if (
    existing !== undefined &&
    (existing.kind !== "agent-event" ||
      !hasCompatibleAgentEventMetadata(existing, update))
  ) {
    const error = eventMetadataError(update.conversationId);
    return deepEqual(state.snapshot.error, error)
      ? state
      : updateSnapshotState(state, { error });
  }

  const event = buildAgentEvent(update, existing);
  const timeline = upsertTimelineItem(state.timeline, event);
  return timeline === state.timeline
    ? state
    : updateSnapshotState(state, { timeline });
};

export const updateConversationId = (
  update: ChatUpdate,
): string | undefined => {
  if (update.kind === "snapshot.replace") {
    return update.snapshot.conversation.id;
  }
  if (update.kind === "conversation.upsert") return update.conversation.id;
  if (update.kind === "error.reported") {
    return update.conversationId ?? update.error.conversationId;
  }
  return update.conversationId;
};

export const applySnapshotUpdate = (
  state: SnapshotState,
  update: ChatUpdate,
): SnapshotState => {
  const activeConversationId = state.snapshot.conversation.id;
  const targetConversationId = updateConversationId(update);
  if (
    targetConversationId !== undefined &&
    targetConversationId !== activeConversationId
  ) {
    return state;
  }

  switch (update.kind) {
    case "snapshot.replace": {
      const replacement = createSnapshotState(update.snapshot);
      if (
        hasConflictingInteractionMetadata(
          state.snapshot.pendingInteraction,
          replacement.snapshot.pendingInteraction,
        )
      ) {
        return updateSnapshotState(replacement, {
          pendingInteraction: state.snapshot.pendingInteraction,
          error: interactionMetadataError(activeConversationId),
        });
      }
      return deepEqual(replacement.snapshot, state.snapshot)
        ? state
        : replacement;
    }
    case "conversation.upsert": {
      const conversation = cloneImmutable(update.conversation);
      return deepEqual(conversation, state.snapshot.conversation)
        ? state
        : updateSnapshotState(state, { conversation });
    }
    case "timeline.upsert": {
      const timeline = upsertTimelineItem(state.timeline, update.item);
      return timeline === state.timeline
        ? state
        : updateSnapshotState(state, { timeline });
    }
    case "event.transition.upsert":
      return applyTransition(state, update);
    case "run.replace": {
      const run = cloneImmutable(update.run);
      return deepEqual(run, state.snapshot.run)
        ? state
        : updateSnapshotState(state, { run });
    }
    case "capabilities.replace": {
      const capabilities = cloneImmutable(update.capabilities);
      return deepEqual(capabilities, state.snapshot.capabilities)
        ? state
        : updateSnapshotState(state, { capabilities });
    }
    case "interaction.replace": {
      const pendingInteraction = cloneImmutable(
        update.interaction ?? undefined,
      );
      if (
        hasConflictingInteractionMetadata(
          state.snapshot.pendingInteraction,
          pendingInteraction,
        )
      ) {
        return applySnapshotError(
          state,
          interactionMetadataError(activeConversationId),
        );
      }
      return deepEqual(pendingInteraction, state.snapshot.pendingInteraction)
        ? state
        : updateSnapshotState(state, { pendingInteraction });
    }
    case "error.reported":
      return applySnapshotError(state, update.error);
  }
};

export const applySnapshotError = (
  state: SnapshotState,
  error: ChatError,
): SnapshotState => {
  const immutableError = cloneImmutable(error);
  return deepEqual(immutableError, state.snapshot.error)
    ? state
    : updateSnapshotState(state, { error: immutableError });
};
