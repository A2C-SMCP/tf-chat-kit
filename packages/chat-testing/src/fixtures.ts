import {
  chatErrorSchema,
  chatSnapshotSchema,
  chatUpdateSchema,
  conversationSchema,
  type ChatError,
  type ChatSnapshot,
  type ChatUpdate,
  type Conversation,
  type InterruptRunSuccess,
  type SendTextSuccess,
} from "@turingfocus/chat-protocol";

export interface ChatContractFixtureOptions {
  readonly baseTimestamp?: number | undefined;
  readonly conversationId?: string | undefined;
}

/** A coherent, normalized scenario shared by Gateway and Runtime contracts. */
export interface ChatContractFixtures {
  readonly authenticationError: ChatError;
  readonly capabilitiesUpdate: ChatUpdate;
  readonly conversation: Conversation;
  readonly conversationUpdate: ChatUpdate;
  readonly disconnectError: ChatError;
  readonly duplicateEventTransitionUpdate: ChatUpdate;
  readonly duplicateMessageUpdates: readonly [ChatUpdate, ChatUpdate];
  readonly foreignConversationUpdates: readonly ChatUpdate[];
  readonly globalErrorUpdate: ChatUpdate;
  readonly initialSnapshot: ChatSnapshot;
  readonly interruptSuccess: InterruptRunSuccess;
  readonly outOfOrderEventUpdates: readonly [ChatUpdate, ChatUpdate];
  readonly realtimeMessageUpdate: ChatUpdate;
  readonly replacementMessageUpdate: ChatUpdate;
  readonly reportedErrorUpdate: ChatUpdate;
  readonly runUpdate: ChatUpdate;
  readonly sendTextSuccess: SendTextSuccess;
  readonly snapshotReplacementUpdate: ChatUpdate;
  readonly tieBreakMessageUpdates: readonly [ChatUpdate, ChatUpdate];
  readonly unknownEventUpdate: ChatUpdate;
}

const DEFAULT_BASE_TIMESTAMP = 1_773_705_600_000;

/**
 * Creates fresh, deeply frozen Protocol fixtures without server DTOs, host
 * state, credentials, or transport-specific fields.
 */
export const createChatContractFixtures = (
  options: ChatContractFixtureOptions = {},
): ChatContractFixtures => {
  const baseTimestamp = options.baseTimestamp ?? DEFAULT_BASE_TIMESTAMP;
  const conversationId = options.conversationId ?? "conversation-contract";
  const conversation = conversationSchema.parse({
    id: conversationId,
    title: "Contract conversation",
    updatedAt: baseTimestamp,
  });

  const initialSnapshot = chatSnapshotSchema.parse({
    conversation,
    timeline: [
      {
        kind: "message",
        id: "message-history",
        conversationId,
        role: "user",
        content: { kind: "text", text: "Initial message" },
        createdAt: baseTimestamp,
        sequence: 0,
      },
    ],
    run: {
      id: "run-contract",
      conversationId,
      status: "running",
      canInterrupt: true,
      startedAt: baseTimestamp,
    },
    capabilities: {
      interrupt: true,
      listConversations: true,
      liveUpdates: true,
      loadHistory: true,
      sendText: true,
    },
    pageInfo: { hasPreviousPage: false },
  });

  const realtimeMessageUpdate = chatUpdateSchema.parse({
    kind: "timeline.upsert",
    conversationId,
    item: {
      kind: "message",
      id: "message-realtime",
      conversationId,
      role: "assistant",
      content: { kind: "text", text: "Realtime response" },
      createdAt: baseTimestamp + 300,
      sequence: 3,
    },
  });

  const duplicateMessageUpdates = Object.freeze([
    realtimeMessageUpdate,
    chatUpdateSchema.parse(realtimeMessageUpdate),
  ]) as readonly [ChatUpdate, ChatUpdate];

  const replacementMessageUpdate = chatUpdateSchema.parse({
    kind: "timeline.upsert",
    conversationId,
    item: {
      kind: "message",
      id: "message-realtime",
      conversationId,
      role: "assistant",
      content: { kind: "text", text: "Realtime replacement" },
      createdAt: baseTimestamp + 300,
      updatedAt: baseTimestamp + 350,
      sequence: 3,
    },
  });

  const outOfOrderEventUpdates = Object.freeze([
    chatUpdateSchema.parse({
      kind: "event.transition.upsert",
      conversationId,
      event: {
        eventCategory: "generic",
        id: "event-out-of-order",
        eventType: "contract-step",
        createdAt: baseTimestamp + 100,
        sequence: 1,
        transition: {
          id: "transition-success",
          status: "success",
          occurredAt: baseTimestamp + 250,
          sequence: 2,
          summary: "Completed",
        },
      },
    }),
    chatUpdateSchema.parse({
      kind: "event.transition.upsert",
      conversationId,
      event: {
        eventCategory: "generic",
        id: "event-out-of-order",
        eventType: "contract-step",
        createdAt: baseTimestamp + 100,
        sequence: 1,
        transition: {
          id: "transition-running",
          status: "running",
          occurredAt: baseTimestamp + 150,
          sequence: 1,
          summary: "Started",
        },
      },
    }),
  ]) as readonly [ChatUpdate, ChatUpdate];
  const duplicateEventTransitionUpdate = chatUpdateSchema.parse(
    outOfOrderEventUpdates[1],
  );

  const unknownEventUpdate = chatUpdateSchema.parse({
    kind: "timeline.upsert",
    conversationId,
    item: {
      kind: "unknown-event",
      id: "event-unknown",
      conversationId,
      originalType: "future.contract.event",
      createdAt: baseTimestamp + 400,
      sequence: 4,
      summary: "Unsupported event",
      raw: Object.defineProperty({ safeField: "safe-value" }, "__proto__", {
        enumerable: true,
        value: { preserved: true },
      }),
    },
  });

  const tieBreakMessageUpdates = Object.freeze([
    chatUpdateSchema.parse({
      kind: "timeline.upsert",
      conversationId,
      item: {
        kind: "message",
        id: "message-tie-b",
        conversationId,
        role: "assistant",
        content: { kind: "text", text: "Tie B" },
        createdAt: baseTimestamp + 200,
        sequence: 2,
      },
    }),
    chatUpdateSchema.parse({
      kind: "timeline.upsert",
      conversationId,
      item: {
        kind: "message",
        id: "message-tie-a",
        conversationId,
        role: "assistant",
        content: { kind: "text", text: "Tie A" },
        createdAt: baseTimestamp + 200,
        sequence: 2,
      },
    }),
  ]) as readonly [ChatUpdate, ChatUpdate];

  const replacementSnapshot = chatSnapshotSchema.parse({
    ...initialSnapshot,
    conversation: { ...conversation, title: "Replacement conversation" },
    timeline: [],
    run: null,
  });
  const snapshotReplacementUpdate = chatUpdateSchema.parse({
    kind: "snapshot.replace",
    snapshot: replacementSnapshot,
  });
  const conversationUpdate = chatUpdateSchema.parse({
    kind: "conversation.upsert",
    conversation: {
      ...replacementSnapshot.conversation,
      title: "Renamed conversation",
      updatedAt: baseTimestamp + 500,
    },
  });
  const runUpdate = chatUpdateSchema.parse({
    kind: "run.replace",
    conversationId,
    run: {
      id: "run-replaced",
      conversationId,
      status: "succeeded",
      canInterrupt: false,
      startedAt: baseTimestamp + 100,
      finishedAt: baseTimestamp + 600,
    },
  });
  const capabilitiesUpdate = chatUpdateSchema.parse({
    kind: "capabilities.replace",
    conversationId,
    capabilities: {
      ...initialSnapshot.capabilities,
      interrupt: false,
      sendText: false,
    },
  });

  const authenticationError = chatErrorSchema.parse({
    code: "authentication",
    message: "Session expired",
    retryable: true,
    conversationId,
    details: { reason: "expired" },
  });
  const disconnectError = chatErrorSchema.parse({
    code: "network",
    message: "Connection unavailable",
    retryable: true,
    conversationId,
  });
  const reportedErrorUpdate = chatUpdateSchema.parse({
    kind: "error.reported",
    conversationId,
    error: {
      code: "server",
      message: "Contract error",
      retryable: true,
      conversationId,
      details: { safeField: "safe-value" },
    },
  });
  const foreignConversationId = "conversation-foreign";
  const foreignConversation = conversationSchema.parse({
    id: foreignConversationId,
    title: "Foreign conversation",
    updatedAt: baseTimestamp + 700,
  });
  const foreignMessage = {
    kind: "message" as const,
    id: "message-foreign",
    conversationId: foreignConversationId,
    role: "assistant" as const,
    content: { kind: "text" as const, text: "Foreign message" },
    createdAt: baseTimestamp + 700,
  };
  const foreignConversationUpdates = Object.freeze([
    chatUpdateSchema.parse({
      kind: "snapshot.replace",
      snapshot: {
        conversation: foreignConversation,
        timeline: [foreignMessage],
        run: null,
        capabilities: initialSnapshot.capabilities,
        pageInfo: { hasPreviousPage: false },
      },
    }),
    chatUpdateSchema.parse({
      kind: "conversation.upsert",
      conversation: foreignConversation,
    }),
    chatUpdateSchema.parse({
      kind: "timeline.upsert",
      conversationId: foreignConversationId,
      item: foreignMessage,
    }),
    chatUpdateSchema.parse({
      kind: "event.transition.upsert",
      conversationId: foreignConversationId,
      event: {
        eventCategory: "generic",
        id: "event-foreign",
        eventType: "foreign-step",
        createdAt: baseTimestamp + 700,
        transition: {
          id: "transition-foreign",
          status: "running",
          occurredAt: baseTimestamp + 710,
        },
      },
    }),
    chatUpdateSchema.parse({
      kind: "run.replace",
      conversationId: foreignConversationId,
      run: {
        id: "run-foreign",
        conversationId: foreignConversationId,
        status: "running",
        canInterrupt: true,
        startedAt: baseTimestamp + 700,
      },
    }),
    chatUpdateSchema.parse({
      kind: "capabilities.replace",
      conversationId: foreignConversationId,
      capabilities: {
        ...initialSnapshot.capabilities,
        sendText: false,
      },
    }),
    chatUpdateSchema.parse({
      kind: "error.reported",
      conversationId: foreignConversationId,
      error: {
        code: "server",
        message: "Foreign error",
        retryable: false,
        conversationId: foreignConversationId,
      },
    }),
  ]);
  const globalErrorUpdate = chatUpdateSchema.parse({
    kind: "error.reported",
    error: {
      code: "network",
      message: "Global connection error",
      retryable: true,
    },
  });

  return Object.freeze({
    authenticationError,
    capabilitiesUpdate,
    conversation,
    conversationUpdate,
    disconnectError,
    duplicateEventTransitionUpdate,
    duplicateMessageUpdates,
    foreignConversationUpdates,
    globalErrorUpdate,
    initialSnapshot,
    interruptSuccess: Object.freeze({
      cancellationId: "cancellation-contract",
      interruptedRunId: "run-contract",
    }),
    outOfOrderEventUpdates,
    realtimeMessageUpdate,
    replacementMessageUpdate,
    reportedErrorUpdate,
    runUpdate,
    sendTextSuccess: Object.freeze({ runId: "run-contract" }),
    snapshotReplacementUpdate,
    tieBreakMessageUpdates,
    unknownEventUpdate,
  });
};
