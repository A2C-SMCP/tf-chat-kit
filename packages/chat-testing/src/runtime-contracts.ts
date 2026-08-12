import type {
  ChatGateway,
  ChatSnapshot,
  ChatUpdate,
  GatewayRequestOptions,
  GatewayResult,
  InterruptRunInput,
  InterruptRunSuccess,
  LoadConversationInput,
  MaybePromise,
  SendTextInput,
  SendTextSuccess,
} from "@turingfocus/chat-protocol";

import {
  assert,
  assertEqual,
  deadlineFrom,
  display,
  type ChatContractCase,
} from "./contract-core.js";
import {
  createChatContractFixtures,
  type ChatContractFixtures,
} from "./fixtures.js";
import type { GatewayContractCall } from "./gateway-contracts.js";
import { createMemoryChatGateway } from "./memory-gateway.js";

export interface RuntimeContractSubscription {
  dispose(): MaybePromise<void>;
}

/**
 * Test-only shape that keeps the suite independent of a concrete ChatClient
 * signature. A Runtime implementation maps its public API to this adapter.
 */
export interface RuntimeContractAdapter {
  dispose(options: GatewayRequestOptions): MaybePromise<void>;
  getSnapshot(): MaybePromise<ChatSnapshot | null>;
  interrupt(
    input: InterruptRunInput,
  ): MaybePromise<GatewayResult<InterruptRunSuccess>>;
  loadConversation(input: LoadConversationInput): MaybePromise<void>;
  sendText(input: SendTextInput): MaybePromise<GatewayResult<SendTextSuccess>>;
  settle(): MaybePromise<void>;
  subscribe(
    listener: (snapshot: ChatSnapshot) => void,
  ): MaybePromise<RuntimeContractSubscription>;
}

export type RuntimeContractAdapterFactory = (
  gateway: ChatGateway,
  fixtures: ChatContractFixtures,
) => MaybePromise<RuntimeContractAdapter>;

interface RuntimeEnvironment {
  readonly adapter: RuntimeContractAdapter;
  readonly deadlineAt: () => number;
  readonly fixtures: ChatContractFixtures;
  readonly gatewayDisposed: () => boolean;
  readonly gateway: ChatGateway;
  readonly emitUpdate: (update: ChatUpdate) => number;
  readonly calls: () => readonly GatewayContractCall[];
}

const runtimeCase = (
  name: string,
  factory: RuntimeContractAdapterFactory,
  execute: (environment: RuntimeEnvironment) => Promise<void>,
): ChatContractCase =>
  Object.freeze({
    name,
    async run() {
      const fixtures = createChatContractFixtures();
      const memory = createMemoryChatGateway({ fixtures });
      let adapter: RuntimeContractAdapter | undefined;
      try {
        adapter = await factory(memory.gateway, fixtures);
        const environment: RuntimeEnvironment = {
          adapter,
          deadlineAt: () => deadlineFrom(memory.controller.now()),
          fixtures,
          gatewayDisposed: () => memory.controller.disposed,
          gateway: memory.gateway,
          emitUpdate: (update) => memory.controller.emitUpdateToAll(update),
          calls: () => memory.controller.calls,
        };
        await execute(environment);
      } finally {
        try {
          await adapter?.dispose({
            deadlineAt: deadlineFrom(memory.controller.now()),
          });
        } finally {
          await memory.gateway.dispose({
            deadlineAt: deadlineFrom(memory.controller.now()),
          });
        }
      }
    },
  });

const runtimeIsolationCase = (
  factory: RuntimeContractAdapterFactory,
): ChatContractCase =>
  Object.freeze({
    name: "isolates concurrent Runtime instances",
    async run() {
      const baseTimestamp = 1_773_705_600_000;
      const firstFixtures = createChatContractFixtures({
        baseTimestamp,
        conversationId: "conversation-runtime-first",
      });
      const secondFixtures = createChatContractFixtures({
        baseTimestamp: baseTimestamp + 10_000,
        conversationId: "conversation-runtime-second",
      });
      const firstMemory = createMemoryChatGateway({ fixtures: firstFixtures });
      const secondMemory = createMemoryChatGateway({
        fixtures: secondFixtures,
      });
      let firstAdapter: RuntimeContractAdapter | undefined;
      let secondAdapter: RuntimeContractAdapter | undefined;
      try {
        firstAdapter = await factory(firstMemory.gateway, firstFixtures);
        secondAdapter = await factory(secondMemory.gateway, secondFixtures);
        await firstAdapter.loadConversation({
          conversationId: firstFixtures.conversation.id,
          deadlineAt: deadlineFrom(firstMemory.controller.now()),
        });
        await secondAdapter.loadConversation({
          conversationId: secondFixtures.conversation.id,
          deadlineAt: deadlineFrom(secondMemory.controller.now()),
        });
        let firstNotifications = 0;
        let secondNotifications = 0;
        const firstSubscription = await firstAdapter.subscribe(() => {
          firstNotifications += 1;
        });
        const secondSubscription = await secondAdapter.subscribe(() => {
          secondNotifications += 1;
        });
        const firstNotificationsBeforeUpdate = firstNotifications;
        const secondNotificationsBeforeUpdate = secondNotifications;

        firstMemory.controller.emitUpdateToAll(
          firstFixtures.realtimeMessageUpdate,
        );
        firstMemory.controller.emitUpdateToAll(firstFixtures.runUpdate);
        firstMemory.controller.emitError(firstFixtures.authenticationError);
        await firstAdapter.settle();
        await secondAdapter.settle();
        const firstSnapshot = await firstAdapter.getSnapshot();
        const secondSnapshot = await secondAdapter.getSnapshot();
        assert(
          firstSnapshot?.timeline.some(
            ({ id }) => id === "message-realtime",
          ) === true,
          "the first Runtime must receive its own update",
        );
        assert(
          firstSnapshot?.run?.id === "run-replaced" &&
            firstSnapshot.run.status === "succeeded",
          "the first Runtime must receive only its own Run update",
        );
        assert(
          firstSnapshot?.error?.code === "authentication",
          "the first Runtime must receive only its own authentication error",
        );
        assertEqual(
          secondSnapshot,
          secondFixtures.initialSnapshot,
          "the second Runtime must not receive the first Runtime state, Run, or authentication updates",
        );
        assert(
          firstNotifications > firstNotificationsBeforeUpdate,
          "the first Runtime must notify only its own listeners",
        );
        assert(
          secondNotifications === secondNotificationsBeforeUpdate,
          "the second Runtime listener must ignore the first Runtime update",
        );

        await firstAdapter.dispose({
          deadlineAt: deadlineFrom(firstMemory.controller.now()),
        });
        assert(
          firstMemory.controller.disposed,
          "disposing the first Runtime must dispose its Gateway",
        );
        assert(
          !secondMemory.controller.disposed,
          "disposing the first Runtime must not dispose another Gateway",
        );

        const firstNotificationsAfterDispose = firstNotifications;
        secondMemory.controller.emitUpdateToAll(
          secondFixtures.realtimeMessageUpdate,
        );
        await secondAdapter.settle();
        const secondUpdatedSnapshot = await secondAdapter.getSnapshot();
        assert(
          secondUpdatedSnapshot?.timeline.some(
            ({ id }) => id === "message-realtime",
          ) === true,
          "disposing one Runtime must not silence another",
        );
        assert(
          firstNotifications === firstNotificationsAfterDispose,
          "a disposed Runtime must not receive another Runtime update",
        );
        assert(
          secondNotifications > secondNotificationsBeforeUpdate,
          "the active Runtime must keep notifying its own listeners",
        );
        await firstSubscription.dispose();
        await secondSubscription.dispose();
      } finally {
        try {
          await firstAdapter?.dispose({
            deadlineAt: deadlineFrom(firstMemory.controller.now()),
          });
        } finally {
          try {
            await secondAdapter?.dispose({
              deadlineAt: deadlineFrom(secondMemory.controller.now()),
            });
          } finally {
            await firstMemory.gateway.dispose({
              deadlineAt: deadlineFrom(firstMemory.controller.now()),
            });
            await secondMemory.gateway.dispose({
              deadlineAt: deadlineFrom(secondMemory.controller.now()),
            });
          }
        }
      }
    },
  });

const probeSnapshotIsolation = async (
  adapter: RuntimeContractAdapter,
  exposed: ChatSnapshot,
  label: string,
): Promise<void> => {
  const expected = display(exposed);
  Reflect.set(exposed, "run", null);
  Reflect.set(exposed.conversation, "title", "Externally mutated");
  if (exposed.timeline.length > 0) {
    const first = exposed.timeline[0]!;
    Reflect.set(exposed.timeline, 0, { ...first, id: "externally-mutated" });
    if (first.kind === "message") {
      Reflect.set(first.content, "text", "Externally mutated");
    }
  }
  assert(
    display(exposed) === expected,
    `${label} must itself resist external mutation`,
  );
  assert(
    display(await adapter.getSnapshot()) === expected,
    `${label} must not expose mutable Runtime state`,
  );
};

const runtimeSnapshotBoundaryCase = (
  factory: RuntimeContractAdapterFactory,
): ChatContractCase =>
  Object.freeze({
    name: "preserves updates across initial-load and conversation-switch snapshot boundaries",
    async run() {
      const firstFixtures = createChatContractFixtures({
        conversationId: "conversation-boundary-first",
      });
      const secondFixtures = createChatContractFixtures({
        baseTimestamp: 1_773_705_700_000,
        conversationId: "conversation-boundary-second",
      });
      const firstMemory = createMemoryChatGateway({ fixtures: firstFixtures });
      const secondMemory = createMemoryChatGateway({
        fixtures: secondFixtures,
      });
      const emitted = new Set<string>();
      const selectMemory = (conversationId: string) =>
        conversationId === firstFixtures.conversation.id
          ? firstMemory
          : secondMemory;
      const emitSnapshotBoundary = (
        conversationId: string,
        fixtures: ChatContractFixtures,
      ): void => {
        if (emitted.has(conversationId)) return;
        emitted.add(conversationId);
        const memory = selectMemory(conversationId);
        memory.controller.emitUpdateToAll(fixtures.realtimeMessageUpdate);
        memory.controller.emitUpdateToAll(fixtures.runUpdate);
        memory.controller.emitError(fixtures.authenticationError);
      };
      const gateway: ChatGateway = {
        dispose: async (options) => {
          const results = await Promise.allSettled([
            firstMemory.gateway.dispose(options),
            secondMemory.gateway.dispose(options),
          ]);
          const failures = results
            .filter(
              (result): result is PromiseRejectedResult =>
                result.status === "rejected",
            )
            .map(({ reason }) => reason);
          if (failures.length === 1) throw failures[0];
          if (failures.length > 1) {
            throw new AggregateError(failures, "Gateway cleanup failed");
          }
        },
        interrupt: (input) =>
          selectMemory(input.conversationId).gateway.interrupt(input),
        listConversations: (input) =>
          firstMemory.gateway.listConversations(input),
        loadConversation: (input) => {
          const fixtures =
            input.conversationId === firstFixtures.conversation.id
              ? firstFixtures
              : secondFixtures;
          emitSnapshotBoundary(input.conversationId, fixtures);
          return selectMemory(input.conversationId).gateway.loadConversation(
            input,
          );
        },
        sendText: (input) =>
          selectMemory(input.conversationId).gateway.sendText(input),
        subscribe: (input, observer) =>
          selectMemory(input.conversationId).gateway.subscribe(input, observer),
      };
      let adapter: RuntimeContractAdapter | undefined;
      const assertBoundaryState = (
        snapshot: ChatSnapshot | null,
        fixtures: ChatContractFixtures,
        label: string,
      ): void => {
        assert(
          snapshot?.timeline.some(({ id }) => id === "message-realtime") ===
            true,
          `${label} must retain the message emitted at the snapshot boundary`,
        );
        assert(
          snapshot?.run?.id === "run-replaced" &&
            snapshot.run.status === "succeeded",
          `${label} must retain the Run emitted at the snapshot boundary`,
        );
        assert(
          snapshot?.error?.code === "authentication" &&
            snapshot.error.conversationId === fixtures.conversation.id,
          `${label} must retain the error emitted at the snapshot boundary`,
        );
      };

      try {
        adapter = await factory(gateway, firstFixtures);
        await adapter.loadConversation({
          conversationId: firstFixtures.conversation.id,
          deadlineAt: deadlineFrom(firstMemory.controller.now()),
        });
        await adapter.settle();
        assertBoundaryState(
          await adapter.getSnapshot(),
          firstFixtures,
          "initial load",
        );

        await adapter.loadConversation({
          conversationId: secondFixtures.conversation.id,
          deadlineAt: deadlineFrom(secondMemory.controller.now()),
        });
        await adapter.settle();
        assertBoundaryState(
          await adapter.getSnapshot(),
          secondFixtures,
          "conversation switch",
        );
      } finally {
        try {
          await adapter?.dispose({
            deadlineAt: deadlineFrom(firstMemory.controller.now()),
          });
        } finally {
          await gateway.dispose({
            deadlineAt: deadlineFrom(firstMemory.controller.now()),
          });
        }
      }
    },
  });

/**
 * Runtime behavior cases. The adapter is intentionally test-only so TFCK-5
 * does not freeze the concrete ChatClient signatures introduced later.
 */
export const createRuntimeContractCases = (
  factory: RuntimeContractAdapterFactory,
): readonly ChatContractCase[] =>
  Object.freeze([
    runtimeIsolationCase(factory),
    runtimeSnapshotBoundaryCase(factory),
    runtimeCase(
      "loads the initial immutable snapshot",
      factory,
      async ({ adapter, deadlineAt, fixtures }) => {
        await adapter.loadConversation({
          conversationId: fixtures.conversation.id,
          deadlineAt: deadlineAt(),
        });
        await adapter.settle();
        const snapshot = await adapter.getSnapshot();
        assertEqual(
          snapshot,
          fixtures.initialSnapshot,
          "Runtime must expose the loaded snapshot",
        );
        assert(snapshot !== null, "Runtime must expose an initial snapshot");
        await probeSnapshotIsolation(adapter, snapshot, "initial snapshot");
      },
    ),
    runtimeCase(
      "does not publish an unchanged conversation reload",
      factory,
      async ({ adapter, deadlineAt, fixtures }) => {
        const input: LoadConversationInput = {
          conversationId: fixtures.conversation.id,
          deadlineAt: deadlineAt(),
        };
        await adapter.loadConversation(input);
        const before = await adapter.getSnapshot();
        let notifications = 0;
        const subscription = await adapter.subscribe(() => {
          notifications += 1;
        });

        await adapter.loadConversation({
          ...input,
          deadlineAt: deadlineAt(),
        });
        await adapter.settle();

        assert(
          (await adapter.getSnapshot()) === before,
          "an unchanged reload must retain the current immutable snapshot",
        );
        assert(
          notifications === 1,
          "an unchanged reload must not notify subscribers",
        );
        await subscription.dispose();
      },
    ),
    runtimeCase(
      "deduplicates and stably orders normalized updates",
      factory,
      async ({ adapter, deadlineAt, emitUpdate, fixtures }) => {
        await adapter.loadConversation({
          conversationId: fixtures.conversation.id,
          deadlineAt: deadlineAt(),
        });
        for (const update of [
          ...fixtures.duplicateMessageUpdates,
          fixtures.replacementMessageUpdate,
          ...fixtures.outOfOrderEventUpdates,
          fixtures.duplicateEventTransitionUpdate,
          ...fixtures.tieBreakMessageUpdates,
          fixtures.unknownEventUpdate,
        ]) {
          emitUpdate(update);
        }
        await adapter.settle();

        const snapshot = await adapter.getSnapshot();
        assert(
          snapshot !== null,
          "Runtime must retain a snapshot after updates",
        );
        assert(
          snapshot.timeline.filter(({ id }) => id === "message-realtime")
            .length === 1,
          "duplicate timeline items must be upserted by stable identity",
        );
        const replacementMessage = snapshot.timeline.find(
          ({ id }) => id === "message-realtime",
        );
        const expectedReplacement = fixtures.replacementMessageUpdate;
        assert(
          expectedReplacement.kind === "timeline.upsert",
          "replacement fixture must be a timeline upsert",
        );
        assert(
          replacementMessage?.kind === "message" &&
            replacementMessage.content.kind === "text" &&
            replacementMessage.content.text === "Realtime replacement" &&
            replacementMessage.updatedAt === expectedReplacement.item.updatedAt,
          "a later full item replacement must win for the same stable identity",
        );
        const event = snapshot.timeline.find(
          ({ id }) => id === "event-out-of-order",
        );
        assert(
          event?.kind === "agent-event",
          "transition updates must create one normalized event",
        );
        assertEqual(
          event.transitions.map(({ id }) => id),
          ["transition-running", "transition-success"],
          "event transitions must be ordered independently of arrival",
        );
        assert(
          event.status === "success",
          "the latest ordered transition must determine event status",
        );
        assert(
          snapshot.timeline.some(
            (item) =>
              item.kind === "unknown-event" && item.id === "event-unknown",
          ),
          "unknown events must remain visible as fallback items",
        );
        assertEqual(
          snapshot.timeline.map(({ id }) => id),
          [
            "message-history",
            "event-out-of-order",
            "message-tie-a",
            "message-tie-b",
            "message-realtime",
            "event-unknown",
          ],
          "timeline items must use timestamp, sequence, and stable-key ordering",
        );
        await probeSnapshotIsolation(adapter, snapshot, "updated snapshot");
      },
    ),
    runtimeCase(
      "applies every standard update and ignores other conversations",
      factory,
      async ({ adapter, deadlineAt, emitUpdate, fixtures }) => {
        await adapter.loadConversation({
          conversationId: fixtures.conversation.id,
          deadlineAt: deadlineAt(),
        });
        let notifications = 0;
        let notifiedSnapshot: ChatSnapshot | undefined;
        const subscription = await adapter.subscribe((snapshot) => {
          notifications += 1;
          notifiedSnapshot = snapshot;
        });
        for (const update of [
          fixtures.snapshotReplacementUpdate,
          fixtures.conversationUpdate,
          fixtures.runUpdate,
          fixtures.capabilitiesUpdate,
          fixtures.reportedErrorUpdate,
        ]) {
          const beforeUpdate = notifications;
          emitUpdate(update);
          await adapter.settle();
          assert(
            notifications > beforeUpdate,
            `${update.kind} must notify subscribers after settling`,
          );
        }

        const beforeForeignSnapshot = await adapter.getSnapshot();
        assert(
          beforeForeignSnapshot?.error?.code === "server",
          "conversation-scoped error.reported must expose the structured error",
        );
        const beforeForeignDisplay = display(beforeForeignSnapshot);
        for (const foreignUpdate of fixtures.foreignConversationUpdates) {
          const beforeForeignUpdate = notifications;
          emitUpdate(foreignUpdate);
          await adapter.settle();
          assert(
            notifications === beforeForeignUpdate,
            `${foreignUpdate.kind} for another conversation must not notify`,
          );
          assert(
            display(await adapter.getSnapshot()) === beforeForeignDisplay,
            `${foreignUpdate.kind} for another conversation must not change state`,
          );
        }

        const beforeGlobalError = notifications;
        emitUpdate(fixtures.globalErrorUpdate);
        await adapter.settle();
        assert(
          notifications > beforeGlobalError,
          "a global error.reported update must notify the active conversation",
        );

        const snapshot = await adapter.getSnapshot();
        assert(snapshot !== null, "Runtime must retain the replaced snapshot");
        assert(
          snapshot.conversation.title === "Renamed conversation",
          "conversation.upsert must replace conversation metadata",
        );
        assert(
          snapshot.run?.id === "run-replaced" &&
            snapshot.run.status === "succeeded",
          "run.replace must replace Run state",
        );
        assert(
          !snapshot.capabilities.interrupt && !snapshot.capabilities.sendText,
          "capabilities.replace must replace capabilities",
        );
        assert(
          snapshot.error?.code === "network" &&
            snapshot.error.conversationId === undefined,
          "global error.reported must expose the unscoped structured error",
        );
        assert(
          snapshot.timeline.length === 0,
          "snapshot.replace must replace the previous timeline",
        );
        assert(
          !snapshot.timeline.some(({ id }) => id === "message-foreign"),
          "foreign updates must not contaminate the active conversation",
        );
        assertEqual(
          notifiedSnapshot,
          snapshot,
          "subscriber notifications must expose the current snapshot",
        );
        assert(
          notifiedSnapshot !== undefined,
          "standard updates must produce a subscriber snapshot",
        );
        await probeSnapshotIsolation(
          adapter,
          notifiedSnapshot,
          "subscriber snapshot",
        );
        await subscription.dispose();
      },
    ),
    runtimeCase(
      "blocks commands while recovering and permits valid degraded recovery",
      factory,
      async ({ adapter, calls, deadlineAt, emitUpdate, fixtures }) => {
        await adapter.loadConversation({
          conversationId: fixtures.conversation.id,
          deadlineAt: deadlineAt(),
        });
        emitUpdate(fixtures.recoveringLifecycleUpdate);
        await adapter.settle();
        const blocked = await adapter.sendText({
          conversationId: fixtures.conversation.id,
          text: "Blocked while recovering",
          deadlineAt: deadlineAt(),
        });
        assert(
          !blocked.ok && blocked.error.code === "conflict",
          "Runtime must block commands while reconnect recovery is pending",
        );

        emitUpdate(fixtures.degradedLifecycleUpdate);
        await adapter.settle();
        const sent = await adapter.sendText({
          conversationId: fixtures.conversation.id,
          text: "Allowed with best-effort recovery",
          deadlineAt: deadlineAt(),
        });
        assert(
          sent.ok && sent.value.runId === fixtures.sendTextSuccess.runId,
          "Runtime must permit commands in a valid degraded lifecycle",
        );
        assert(
          calls().filter(({ operation }) => operation === "sendText").length ===
            1,
          "only the degraded command may reach the Gateway",
        );
      },
    ),
    runtimeCase(
      "routes text and interrupt commands through its Gateway",
      factory,
      async ({ adapter, calls, deadlineAt, fixtures }) => {
        const loadInput: LoadConversationInput = {
          conversationId: fixtures.conversation.id,
          deadlineAt: deadlineAt(),
        };
        await adapter.loadConversation(loadInput);
        const sendInput: SendTextInput = {
          conversationId: fixtures.conversation.id,
          text: "Contract message",
          clientMessageId: "client-contract",
          deadlineAt: deadlineAt(),
        };
        const sent = await adapter.sendText(sendInput);
        const interruptInput: InterruptRunInput = {
          conversationId: fixtures.conversation.id,
          runId: fixtures.initialSnapshot.run?.id,
          deadlineAt: deadlineAt(),
        };
        const interrupted = await adapter.interrupt(interruptInput);
        const implicitInterruptInput: InterruptRunInput = {
          conversationId: fixtures.conversation.id,
          deadlineAt: deadlineAt(),
        };
        const implicitlyInterrupted = await adapter.interrupt(
          implicitInterruptInput,
        );
        assertEqual(
          sent,
          { ok: true, value: fixtures.sendTextSuccess },
          "Runtime must return the Gateway send result",
        );
        assertEqual(
          interrupted,
          { ok: true, value: fixtures.interruptSuccess },
          "Runtime must return the Gateway interrupt result",
        );
        assertEqual(
          implicitlyInterrupted,
          { ok: true, value: fixtures.interruptSuccess },
          "Runtime must return the implicit interrupt result",
        );
        assertEqual(
          calls().filter(
            ({ operation }) =>
              operation === "sendText" || operation === "interrupt",
          ),
          [
            { operation: "sendText", input: sendInput },
            { operation: "interrupt", input: interruptInput },
            {
              operation: "interrupt",
              input: {
                ...implicitInterruptInput,
                runId: fixtures.initialSnapshot.run?.id,
              },
            },
          ],
          "Runtime commands must reach the injected Gateway and implicit interrupts must be pinned to the active Run",
        );
      },
    ),
    runtimeCase(
      "stops notifying after disposal",
      factory,
      async ({
        adapter,
        deadlineAt,
        emitUpdate,
        fixtures,
        gatewayDisposed,
      }) => {
        await adapter.loadConversation({
          conversationId: fixtures.conversation.id,
          deadlineAt: deadlineAt(),
        });
        let notifications = 0;
        const subscription = await adapter.subscribe(() => {
          notifications += 1;
        });
        const beforeDispose = notifications;
        await adapter.dispose({ deadlineAt: deadlineAt() });
        assert(
          gatewayDisposed(),
          "disposed Runtime adapters must dispose their injected Gateway",
        );
        assertEqual(
          await adapter.getSnapshot(),
          null,
          "disposed Runtime adapters must release their retained snapshot state",
        );
        emitUpdate(fixtures.realtimeMessageUpdate);
        await adapter.settle();
        assert(
          notifications === beforeDispose,
          "disposed Runtime adapters must not notify subscribers",
        );
        await subscription.dispose();
      },
    ),
  ]);
