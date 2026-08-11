import {
  compareAgentEventTransitions,
  hasCompatibleAgentEventMetadata,
  type AgentEvent,
  type AgentEventTransitionUpdate,
  type AskUserInteractionRequest,
  type ChatError,
  type ChatErrorOccurrence,
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
  readonly errorSequence: number;
  readonly snapshot: ChatSnapshot;
  readonly timeline: TimelineState;
}

const freezeSnapshot = (snapshot: ChatSnapshot): ChatSnapshot =>
  Object.freeze(snapshot);

export const createSnapshotState = (snapshot: ChatSnapshot): SnapshotState => {
  const timeline = createTimelineState(snapshot.timeline);
  const activeErrors =
    snapshot.activeErrors === undefined
      ? undefined
      : cloneImmutable(snapshot.activeErrors);
  const projectedError =
    activeErrors === undefined ? snapshot.error : activeErrors.at(-1)?.error;
  return {
    errorSequence: 0,
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
      ...(snapshot.lifecycle === undefined
        ? {}
        : { lifecycle: cloneImmutable(snapshot.lifecycle) }),
      ...(activeErrors === undefined ? {} : { activeErrors }),
      ...(projectedError === undefined
        ? {}
        : { error: cloneImmutable(projectedError) }),
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
  return { errorSequence: state.errorSequence, timeline, snapshot };
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
  const currentErrorIds = new Set(
    current.snapshot.activeErrors?.map(({ id }) => id) ?? [],
  );
  const resolvedBaselineErrorIds = new Set(
    (baseline.snapshot.activeErrors ?? [])
      .filter(({ id }) => !currentErrorIds.has(id))
      .map(({ id }) => id),
  );
  const mergedErrors = new Map<string, ChatErrorOccurrence>();
  for (const occurrence of loaded.snapshot.activeErrors ?? []) {
    if (
      occurrence.scope.kind !== "subscription" &&
      !resolvedBaselineErrorIds.has(occurrence.id)
    ) {
      mergedErrors.set(occurrence.id, occurrence);
    }
  }
  for (const occurrence of current.snapshot.activeErrors ?? []) {
    if (occurrence.scope.kind !== "subscription") {
      mergedErrors.set(occurrence.id, occurrence);
    }
  }
  const activeErrors =
    loaded.snapshot.activeErrors === undefined &&
    current.snapshot.activeErrors === undefined
      ? undefined
      : Object.freeze([...mergedErrors.values()]);
  const retainedError =
    activeErrors !== undefined ? activeErrors.at(-1)?.error : rebasedError;
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
  const rebased: SnapshotState = {
    errorSequence: Math.max(
      baseline.errorSequence,
      loaded.errorSequence,
      current.errorSequence,
    ),
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
      ...(loaded.snapshot.lifecycle === undefined
        ? {}
        : { lifecycle: loaded.snapshot.lifecycle }),
      ...(activeErrors === undefined ? {} : { activeErrors }),
      ...(pendingInteraction === undefined ? {} : { pendingInteraction }),
      ...(retainedError === undefined ? {} : { error: retainedError }),
    }),
  };
  const result = hasLoadedInteractionConflict
    ? applyRuntimeSnapshotError(
        rebased,
        interactionMetadataError(current.snapshot.conversation.id),
        `runtime:interaction:${current.snapshot.pendingInteraction?.requestId ?? "unknown"}:${current.snapshot.pendingInteraction?.revision ?? 0}`,
      )
    : rebased;

  if (
    result.errorSequence === current.errorSequence &&
    deepEqual(result.snapshot, current.snapshot)
  ) {
    return current;
  }
  if (
    result.errorSequence === loaded.errorSequence &&
    deepEqual(result.snapshot, loaded.snapshot)
  ) {
    return loaded;
  }
  return result;
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
  const createdAt =
    existing?.createdAt ??
    update.event.createdAt ??
    update.event.transition.occurredAt;
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
      createdAt,
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
    createdAt,
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
    return applyRuntimeSnapshotError(
      state,
      eventMetadataError(update.conversationId),
      `runtime:event-metadata:${update.event.id}`,
    );
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
    return (
      update.conversationId ??
      update.error.conversationId ??
      (update.scope?.kind === "conversation" ? update.scope.id : undefined)
    );
  }
  if (update.kind === "error.resolved") return update.conversationId;
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
      const loadedReplacement = createSnapshotState(update.snapshot);
      const replacement = {
        ...loadedReplacement,
        errorSequence: state.errorSequence,
      };
      if (
        hasConflictingInteractionMetadata(
          state.snapshot.pendingInteraction,
          replacement.snapshot.pendingInteraction,
        )
      ) {
        const guarded = updateSnapshotState(replacement, {
          pendingInteraction: state.snapshot.pendingInteraction,
        });
        return applyRuntimeInteractionError(
          guarded,
          interactionMetadataError(activeConversationId),
          state.snapshot.pendingInteraction,
        );
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
        return applyRuntimeInteractionError(
          state,
          interactionMetadataError(activeConversationId),
          state.snapshot.pendingInteraction,
        );
      }
      return deepEqual(pendingInteraction, state.snapshot.pendingInteraction)
        ? state
        : updateSnapshotState(state, { pendingInteraction });
    }
    case "lifecycle.changed": {
      const lifecycle = cloneImmutable(update.lifecycle);
      return deepEqual(lifecycle, state.snapshot.lifecycle)
        ? state
        : updateSnapshotState(state, { lifecycle });
    }
    case "error.reported":
      return applySnapshotReportedError(state, update);
    case "error.resolved":
      return resolveSnapshotError(state, update.errorId);
  }
};

const occurrenceOf = (
  update: Extract<ChatUpdate, { readonly kind: "error.reported" }>,
): ChatErrorOccurrence | undefined => {
  if (
    update.errorId === undefined ||
    update.source === undefined ||
    update.scope === undefined ||
    update.generation === undefined
  ) {
    return undefined;
  }
  return cloneImmutable({
    id: update.errorId,
    error: update.error,
    source: update.source,
    scope: update.scope,
    generation: update.generation,
  });
};

const existingErrorOccurrences = (
  state: SnapshotState,
): readonly ChatErrorOccurrence[] => {
  if (state.snapshot.activeErrors !== undefined) {
    return state.snapshot.activeErrors;
  }
  if (state.snapshot.error === undefined) return [];
  return [
    cloneImmutable({
      id: "runtime:legacy-snapshot",
      error: state.snapshot.error,
      source: "runtime" as const,
      scope: {
        kind: "conversation" as const,
        id: state.snapshot.conversation.id,
      },
      generation: state.snapshot.lifecycle?.generation ?? 0,
    }),
  ];
};

export const applyRuntimeSnapshotError = (
  state: SnapshotState,
  error: ChatError,
  errorId: string,
): SnapshotState => {
  const occurrence = cloneImmutable({
    id: errorId,
    error,
    source: "runtime" as const,
    scope: {
      kind: "conversation" as const,
      id: state.snapshot.conversation.id,
    },
    generation: state.snapshot.lifecycle?.generation ?? 0,
  });
  const activeErrors = Object.freeze([
    ...existingErrorOccurrences(state).filter(({ id }) => id !== occurrence.id),
    occurrence,
  ]);
  return updateSnapshotState(state, {
    activeErrors,
    error: occurrence.error,
  });
};

const applyRuntimeInteractionError = (
  state: SnapshotState,
  error: ChatError,
  interaction: AskUserInteractionRequest | undefined,
): SnapshotState =>
  applyRuntimeSnapshotError(
    state,
    error,
    `runtime:interaction:${interaction?.requestId ?? "unknown"}:${interaction?.revision ?? 0}`,
  );

const applySnapshotReportedError = (
  state: SnapshotState,
  update: Extract<ChatUpdate, { readonly kind: "error.reported" }>,
): SnapshotState => {
  const occurrence = occurrenceOf(update);
  if (occurrence === undefined) {
    const errorSequence = state.errorSequence + 1;
    const next = applyRuntimeSnapshotError(
      state,
      update.error,
      `runtime:legacy:${state.snapshot.lifecycle?.generation ?? 0}:${errorSequence}`,
    );
    return { ...next, errorSequence };
  }
  const activeErrors = Object.freeze([
    ...existingErrorOccurrences(state).filter(
      (active) => active.id !== occurrence.id,
    ),
    occurrence,
  ]);
  if (
    deepEqual(activeErrors, state.snapshot.activeErrors) &&
    deepEqual(occurrence.error, state.snapshot.error)
  ) {
    return state;
  }
  return updateSnapshotState(state, {
    activeErrors,
    error: occurrence.error,
  });
};

const resolveSnapshotError = (
  state: SnapshotState,
  errorId: string,
): SnapshotState => {
  const current = state.snapshot.activeErrors;
  if (current === undefined || !current.some((error) => error.id === errorId)) {
    return state;
  }
  const activeErrors = Object.freeze(
    current.filter((error) => error.id !== errorId),
  );
  return updateSnapshotState(state, {
    activeErrors,
    error: activeErrors.at(-1)?.error,
  });
};

export const applySnapshotError = (
  state: SnapshotState,
  error: ChatError,
): SnapshotState => {
  const errorSequence = state.errorSequence + 1;
  const next = applyRuntimeSnapshotError(
    state,
    error,
    `runtime:legacy-observer:${state.snapshot.lifecycle?.generation ?? 0}:${errorSequence}`,
  );
  return { ...next, errorSequence };
};
