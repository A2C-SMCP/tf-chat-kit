import type {
  AnswerInteractionInput,
  AnswerInteractionSuccess,
  ChatError,
  ChatGateway,
  ChatSnapshot,
  ChatUpdate,
  CreateConversationInput,
  GatewayResult,
  InterruptRunInput,
  ListConversationsInput,
  LoadConversationInput,
  MaybePromise,
  SendTextInput,
  SubscribeConversationInput,
} from "@turingfocus/chat-protocol";
import { createGatewayDeadlineExceededError } from "@turingfocus/chat-protocol";

import {
  assert,
  assertEqual,
  deadlineFrom,
  type ChatContractCase,
} from "./contract-core.js";
import {
  createChatContractFixtures,
  type ChatContractFixtures,
} from "./fixtures.js";

export type GatewayContractOperation =
  | "answerInteraction"
  | "createConversation"
  | "interrupt"
  | "listConversations"
  | "loadConversation"
  | "sendText"
  | "subscribe";

export type GatewayContractHoldPoint =
  GatewayContractOperation | "gateway.dispose" | "subscription.dispose";

export type GatewayContractCall =
  | {
      readonly operation: "answerInteraction";
      readonly input: AnswerInteractionInput;
    }
  | {
      readonly operation: "createConversation";
      readonly input: CreateConversationInput;
    }
  | { readonly operation: "interrupt"; readonly input: InterruptRunInput }
  | {
      readonly operation: "listConversations";
      readonly input: ListConversationsInput;
    }
  | {
      readonly operation: "loadConversation";
      readonly input: LoadConversationInput;
    }
  | { readonly operation: "sendText"; readonly input: SendTextInput }
  | {
      readonly operation: "subscribe";
      readonly input: SubscribeConversationInput;
    };

export interface GatewayContractHold {
  readonly completed: Promise<void>;
  readonly resourceDisposeCount: number;
  readonly started: Promise<void>;
  release(): void;
}

export interface GatewayContractController {
  readonly calls: readonly GatewayContractCall[];
  advanceTimeTo(timestamp: number): MaybePromise<void>;
  disconnect(error: ChatError): MaybePromise<number | void>;
  emitUpdate(update: ChatUpdate): MaybePromise<number | void>;
  failNext(
    operation: GatewayContractOperation,
    error: ChatError,
  ): MaybePromise<void>;
  holdNext(point: GatewayContractHoldPoint): GatewayContractHold;
  now(): number;
  reconnect(): MaybePromise<void>;
  setAnswerInteractionResult?(
    result: GatewayResult<AnswerInteractionSuccess>,
  ): MaybePromise<void>;
  setSnapshot?(snapshot: ChatSnapshot): MaybePromise<void>;
}

export interface GatewayContractHarness {
  readonly controller: GatewayContractController;
  readonly gateway: ChatGateway;
  dispose?(): MaybePromise<void>;
}

/**
 * A real Gateway adapter maps these semantic controls to its fake REST/Socket
 * transport. The contract never requires production endpoints or credentials.
 */
export type GatewayContractHarnessFactory = (
  fixtures: ChatContractFixtures,
) => MaybePromise<GatewayContractHarness>;

export interface GatewayContractOptions {
  readonly answerInteraction?: boolean | undefined;
}

const disposeGatewayHarness = async (
  harness: GatewayContractHarness,
): Promise<void> => {
  try {
    await harness.gateway.dispose({
      deadlineAt: deadlineFrom(harness.controller.now()),
    });
  } finally {
    await harness.dispose?.();
  }
};

const gatewayCase = (
  name: string,
  factory: GatewayContractHarnessFactory,
  execute: (
    harness: GatewayContractHarness,
    fixtures: ChatContractFixtures,
  ) => Promise<void>,
  options: GatewayContractOptions = {},
): ChatContractCase =>
  Object.freeze({
    name,
    async run() {
      const fixtures = createChatContractFixtures(options);
      const harness = await factory(fixtures);
      try {
        await execute(harness, fixtures);
      } finally {
        await disposeGatewayHarness(harness);
      }
    },
  });

const gatewayIsolationCase = (
  factory: GatewayContractHarnessFactory,
  options: GatewayContractOptions = {},
): ChatContractCase =>
  Object.freeze({
    name: "isolates concurrent Gateway instances",
    async run() {
      const baseTimestamp = 1_773_705_600_000;
      const firstFixtures = createChatContractFixtures({
        answerInteraction: options.answerInteraction,
        baseTimestamp,
        conversationId: "conversation-contract-first",
      });
      const secondFixtures = createChatContractFixtures({
        answerInteraction: options.answerInteraction,
        baseTimestamp: baseTimestamp + 10_000,
        conversationId: "conversation-contract-second",
      });
      const harnesses: GatewayContractHarness[] = [];
      let executionFailure: { readonly reason: unknown } | undefined;
      try {
        const first = await factory(firstFixtures);
        harnesses.push(first);
        const second = await factory(secondFixtures);
        harnesses.push(second);

        const firstUpdates: ChatUpdate[] = [];
        const secondUpdates: ChatUpdate[] = [];
        const firstSubscribed = await first.gateway.subscribe(
          {
            conversationId: firstFixtures.conversation.id,
            deadlineAt: deadlineFrom(first.controller.now()),
          },
          { next: (update) => firstUpdates.push(update) },
        );
        const secondSubscribed = await second.gateway.subscribe(
          {
            conversationId: secondFixtures.conversation.id,
            deadlineAt: deadlineFrom(second.controller.now()),
          },
          { next: (update) => secondUpdates.push(update) },
        );
        assert(firstSubscribed.ok, "the first instance must subscribe");
        assert(secondSubscribed.ok, "the second instance must subscribe");

        if (options.answerInteraction === true) {
          assert(
            first.gateway.answerInteraction !== undefined &&
              second.gateway.answerInteraction !== undefined,
            "each capable instance must expose answerInteraction",
          );
          const answered = await first.gateway.answerInteraction({
            conversationId: firstFixtures.conversation.id,
            answer: {
              requestId: firstFixtures.askUserRequest.requestId,
              revision: firstFixtures.askUserRequest.revision,
              action: "cancel",
              answers: {},
            },
            deadlineAt: deadlineFrom(first.controller.now()),
          });
          assert(
            answered.ok,
            "the first instance must answer its own pending interaction",
          );
          assert(
            second.controller.calls.every(
              ({ operation }) => operation !== "answerInteraction",
            ),
            "answering through one instance must not reach another",
          );
        }

        await first.controller.emitUpdate(firstFixtures.realtimeMessageUpdate);
        assertEqual(
          firstUpdates,
          [firstFixtures.realtimeMessageUpdate],
          "the first instance must receive its own update",
        );
        assertEqual(
          secondUpdates,
          [],
          "the second instance must not receive the first instance update",
        );

        await first.controller.disconnect(firstFixtures.disconnectError);
        const secondLoaded = await second.gateway.loadConversation({
          conversationId: secondFixtures.conversation.id,
          deadlineAt: deadlineFrom(second.controller.now()),
        });
        assertEqual(
          secondLoaded,
          { ok: true, value: secondFixtures.initialSnapshot },
          "disconnecting one instance must not disconnect another",
        );

        await first.gateway.dispose({
          deadlineAt: deadlineFrom(first.controller.now()),
        });
        await second.controller.emitUpdate(
          secondFixtures.realtimeMessageUpdate,
        );
        assertEqual(
          secondUpdates,
          [secondFixtures.realtimeMessageUpdate],
          "disposing one instance must not silence another",
        );
        assertEqual(
          first.controller.calls.filter(
            ({ operation }) => operation === "loadConversation",
          ),
          [],
          "one instance must not record another instance's operations",
        );

        await firstSubscribed.value.dispose({
          deadlineAt: deadlineFrom(first.controller.now()),
        });
        await secondSubscribed.value.dispose({
          deadlineAt: deadlineFrom(second.controller.now()),
        });
      } catch (reason) {
        executionFailure = { reason };
      }
      const cleanupResults = await Promise.allSettled(
        harnesses.reverse().map(disposeGatewayHarness),
      );
      if (executionFailure !== undefined) {
        throw executionFailure.reason;
      }
      const failedCleanup = cleanupResults.find(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected",
      );
      if (failedCleanup !== undefined) {
        throw failedCleanup.reason;
      }
    },
  });

/** Framework-neutral Gateway cases consumable from Vitest, Jest, or Node tests. */
export const createGatewayContractCases = (
  factory: GatewayContractHarnessFactory,
  options: GatewayContractOptions = {},
): readonly ChatContractCase[] =>
  Object.freeze([
    gatewayIsolationCase(factory, options),
    gatewayCase(
      "aligns the optional answerInteraction command with capabilities",
      factory,
      async ({ controller, gateway }, fixtures) => {
        const loaded = await gateway.loadConversation({
          conversationId: fixtures.conversation.id,
          deadlineAt: deadlineFrom(controller.now()),
        });
        assert(loaded.ok, "the capability probe must load a snapshot");
        const supported = loaded.value.capabilities.answerInteraction === true;
        if (supported) {
          assert(
            gateway.answerInteraction !== undefined,
            "an advertised answerInteraction capability requires the command",
          );
          return;
        }
        if (gateway.answerInteraction === undefined) return;
        const answered = await gateway.answerInteraction({
          conversationId: fixtures.conversation.id,
          answer: {
            requestId: fixtures.askUserRequest.requestId,
            revision: fixtures.askUserRequest.revision,
            action: "cancel",
            answers: {},
          },
          deadlineAt: deadlineFrom(controller.now()),
        });
        assert(
          !answered.ok && answered.error.code === "unsupported",
          "an unavailable answerInteraction command must return unsupported",
        );
      },
      options,
    ),
    ...(options.answerInteraction === true
      ? [
          gatewayCase(
            "executes answerInteraction commands",
            factory,
            async ({ controller, gateway }, fixtures) => {
              assert(
                gateway.answerInteraction !== undefined,
                "answerInteraction capability requires a Gateway command",
              );
              const input: AnswerInteractionInput = {
                conversationId: fixtures.conversation.id,
                answer: {
                  requestId: fixtures.askUserRequest.requestId,
                  revision: fixtures.askUserRequest.revision,
                  action: "submit",
                  answers: { "0": "first" },
                },
                deadlineAt: deadlineFrom(controller.now()),
              };
              const answered = await gateway.answerInteraction(input);
              assertEqual(
                answered,
                { ok: true, value: fixtures.answerInteractionSuccess },
                "answerInteraction must preserve its acknowledgement ID",
              );
              assertEqual(
                controller.calls,
                [{ operation: "answerInteraction", input }],
                "answerInteraction must dispatch the complete request payload",
              );
            },
            options,
          ),
          gatewayCase(
            "rejects invalid answerInteraction input before dispatch",
            factory,
            async ({ controller, gateway }, fixtures) => {
              assert(
                gateway.answerInteraction !== undefined,
                "answerInteraction capability requires a Gateway command",
              );
              const answered = await gateway.answerInteraction({
                conversationId: fixtures.conversation.id,
                answer: {
                  requestId: "r".repeat(1_000),
                  revision: fixtures.askUserRequest.revision,
                  action: "cancel",
                  answers: {},
                },
                deadlineAt: deadlineFrom(controller.now()),
              });
              assert(
                !answered.ok && answered.error.code === "validation",
                "invalid answerInteraction input must return validation",
              );
              assertEqual(
                controller.calls,
                [],
                "invalid answerInteraction input must not reach the transport",
              );
            },
            options,
          ),
          gatewayCase(
            "isolates replacement revisions that reuse a request ID",
            factory,
            async ({ controller, gateway }, fixtures) => {
              assert(
                gateway.answerInteraction !== undefined,
                "answerInteraction capability requires a Gateway command",
              );
              assert(
                controller.setSnapshot !== undefined &&
                  controller.setAnswerInteractionResult !== undefined,
                "answerInteraction revision contracts require mutable fake-server state",
              );
              const hold = controller.holdNext("answerInteraction");
              const originalAnswer: AnswerInteractionInput = {
                conversationId: fixtures.conversation.id,
                answer: {
                  requestId: fixtures.askUserRequest.requestId,
                  revision: fixtures.askUserRequest.revision,
                  action: "cancel",
                  answers: {},
                },
                deadlineAt: deadlineFrom(controller.now()),
              };
              const original = gateway.answerInteraction(originalAnswer);
              await hold.started;

              const replacement = {
                ...fixtures.askUserRequest,
                revision: "replacement-revision",
                title: "Replacement interaction",
              };
              await controller.setSnapshot({
                ...fixtures.initialSnapshot,
                pendingInteraction: replacement,
              });
              await controller.setAnswerInteractionResult({
                ok: true,
                value: {
                  requestId: replacement.requestId,
                  revision: replacement.revision,
                },
              });
              const replacementAnswer: AnswerInteractionInput = {
                conversationId: fixtures.conversation.id,
                answer: {
                  requestId: replacement.requestId,
                  revision: replacement.revision,
                  action: "cancel",
                  answers: {},
                },
                deadlineAt: deadlineFrom(controller.now()),
              };
              const replacementResult =
                await gateway.answerInteraction(replacementAnswer);
              assert(
                replacementResult.ok,
                "the replacement revision must be independently answerable",
              );

              hold.release();
              const stale = await original;
              assert(
                !stale.ok && stale.error.code === "conflict",
                "the old revision must not affect its replacement",
              );
              assertEqual(
                controller.calls,
                [
                  { operation: "answerInteraction", input: originalAnswer },
                  { operation: "answerInteraction", input: replacementAnswer },
                ],
                "each interaction revision must keep its complete payload",
              );
            },
            options,
          ),
          gatewayCase(
            "rejects stale answerInteraction requests",
            factory,
            async ({ controller, gateway }, fixtures) => {
              assert(
                gateway.answerInteraction !== undefined,
                "answerInteraction capability requires a Gateway command",
              );
              const answered = await gateway.answerInteraction({
                conversationId: fixtures.conversation.id,
                answer: {
                  requestId: "stale-request",
                  revision: "stale-revision",
                  action: "cancel",
                  answers: {},
                },
                deadlineAt: deadlineFrom(controller.now()),
              });
              assert(
                !answered.ok && answered.error.code === "conflict",
                "answerInteraction must reject stale request IDs",
              );
            },
            options,
          ),
          gatewayCase(
            "returns structured answerInteraction failures",
            factory,
            async ({ controller, gateway }, fixtures) => {
              assert(
                gateway.answerInteraction !== undefined,
                "answerInteraction capability requires a Gateway command",
              );
              await controller.failNext(
                "answerInteraction",
                fixtures.authenticationError,
              );
              const answered = await gateway.answerInteraction({
                conversationId: fixtures.conversation.id,
                answer: {
                  requestId: fixtures.askUserRequest.requestId,
                  revision: fixtures.askUserRequest.revision,
                  action: "cancel",
                  answers: {},
                },
                deadlineAt: deadlineFrom(controller.now()),
              });
              assertEqual(
                answered,
                { ok: false, error: fixtures.authenticationError },
                "answerInteraction failures must remain structured",
              );
            },
            options,
          ),
          gatewayCase(
            "bounds answerInteraction by its deadline",
            factory,
            async ({ controller, gateway }, fixtures) => {
              assert(
                gateway.answerInteraction !== undefined,
                "answerInteraction capability requires a Gateway command",
              );
              const hold = controller.holdNext("answerInteraction");
              const deadlineAt = controller.now() + 1_000;
              const answering = gateway.answerInteraction({
                conversationId: fixtures.conversation.id,
                answer: {
                  requestId: fixtures.askUserRequest.requestId,
                  revision: fixtures.askUserRequest.revision,
                  action: "cancel",
                  answers: {},
                },
                deadlineAt,
              });
              await hold.started;
              await controller.advanceTimeTo(deadlineAt);
              const answered = await answering;
              assert(
                !answered.ok && answered.error.code === "timeout",
                "answerInteraction must return a structured deadline failure",
              );
              hold.release();
            },
            options,
          ),
        ]
      : []),
    gatewayCase(
      "loads normalized conversations and snapshots",
      factory,
      async ({ controller, gateway }, fixtures) => {
        const listed = await gateway.listConversations({
          deadlineAt: deadlineFrom(controller.now()),
        });
        assert(listed.ok, "listConversations must succeed");
        assertEqual(
          listed.value.conversations,
          [fixtures.conversation],
          "listConversations must return the configured conversation",
        );

        const loaded = await gateway.loadConversation({
          conversationId: fixtures.conversation.id,
          deadlineAt: deadlineFrom(controller.now()),
        });
        assert(loaded.ok, "loadConversation must succeed");
        assertEqual(
          loaded.value,
          fixtures.initialSnapshot,
          "loadConversation must return the normalized snapshot",
        );
      },
    ),
    gatewayCase(
      "delivers duplicate, out-of-order, and unknown updates safely",
      factory,
      async ({ controller, gateway }, fixtures) => {
        const received: ChatUpdate[] = [];
        const subscribed = await gateway.subscribe(
          {
            conversationId: fixtures.conversation.id,
            deadlineAt: deadlineFrom(controller.now()),
          },
          { next: (update) => received.push(update) },
        );
        assert(subscribed.ok, "subscribe must succeed");

        for (const update of [
          ...fixtures.duplicateMessageUpdates,
          ...fixtures.outOfOrderEventUpdates,
          fixtures.unknownEventUpdate,
        ]) {
          await controller.emitUpdate(update);
        }
        assertEqual(
          received,
          [
            ...fixtures.duplicateMessageUpdates,
            ...fixtures.outOfOrderEventUpdates,
            fixtures.unknownEventUpdate,
          ],
          "Gateway must preserve normalized delivery semantics",
        );

        await subscribed.value.dispose({
          deadlineAt: deadlineFrom(controller.now()),
        });
        await controller.emitUpdate(fixtures.realtimeMessageUpdate);
        assert(
          received.length === 5,
          "disposed subscriptions must stay silent",
        );
      },
    ),
    gatewayCase(
      "executes send and interrupt commands",
      factory,
      async ({ controller, gateway }, fixtures) => {
        const sendInput: SendTextInput = {
          conversationId: fixtures.conversation.id,
          text: "Contract message",
          clientMessageId: "client-contract",
          deadlineAt: deadlineFrom(controller.now()),
        };
        const sent = await gateway.sendText(sendInput);
        assertEqual(
          sent,
          { ok: true, value: fixtures.sendTextSuccess },
          "sendText must return the configured command result",
        );

        const interruptInput: InterruptRunInput = {
          conversationId: fixtures.conversation.id,
          runId: fixtures.initialSnapshot.run?.id,
          deadlineAt: deadlineFrom(controller.now()),
        };
        const interrupted = await gateway.interrupt(interruptInput);
        assertEqual(
          interrupted,
          { ok: true, value: fixtures.interruptSuccess },
          "interrupt must return the configured command result",
        );
        assertEqual(
          controller.calls,
          [
            { operation: "sendText", input: sendInput },
            { operation: "interrupt", input: interruptInput },
          ],
          "Gateway commands must dispatch their complete request payloads",
        );
      },
    ),
    gatewayCase(
      "rejects stale interrupt targets",
      factory,
      async ({ controller, gateway }, fixtures) => {
        const input: InterruptRunInput = {
          conversationId: fixtures.conversation.id,
          runId: "run-stale",
          deadlineAt: deadlineFrom(controller.now()),
        };
        const interrupted = await gateway.interrupt(input);
        assert(
          !interrupted.ok && interrupted.error.code === "conflict",
          "interrupt must reject a stale runId with a structured conflict",
        );
        assertEqual(
          controller.calls,
          [{ operation: "interrupt", input }],
          "stale interrupt validation must retain the complete request record",
        );
      },
    ),
    gatewayCase(
      "returns structured authentication failures",
      factory,
      async ({ controller, gateway }, fixtures) => {
        await controller.failNext(
          "loadConversation",
          fixtures.authenticationError,
        );
        const loaded = await gateway.loadConversation({
          conversationId: fixtures.conversation.id,
          deadlineAt: deadlineFrom(controller.now()),
        });
        assertEqual(
          loaded,
          { ok: false, error: fixtures.authenticationError },
          "authentication failures must remain structured",
        );
      },
    ),
    gatewayCase(
      "reports disconnection and recovers without replacing the port",
      factory,
      async ({ controller, gateway }, fixtures) => {
        const errors: ChatError[] = [];
        const updates: ChatUpdate[] = [];
        const subscribed = await gateway.subscribe(
          {
            conversationId: fixtures.conversation.id,
            deadlineAt: deadlineFrom(controller.now()),
          },
          {
            next: (update) => updates.push(update),
            error: (error) => errors.push(error),
          },
        );
        assert(subscribed.ok, "subscribe must succeed before disconnection");

        await controller.disconnect(fixtures.disconnectError);
        assertEqual(
          errors,
          [fixtures.disconnectError],
          "active observers must receive the structured disconnect error",
        );
        const disconnectedLoad = await gateway.loadConversation({
          conversationId: fixtures.conversation.id,
          deadlineAt: deadlineFrom(controller.now()),
        });
        assert(
          !disconnectedLoad.ok && disconnectedLoad.error.code === "network",
          "operations must report a network error while disconnected",
        );
        await controller.emitUpdate(fixtures.realtimeMessageUpdate);
        assert(
          updates.length === 0,
          "live subscriptions must stay silent while disconnected",
        );

        await controller.reconnect();
        const recoveredLoad = await gateway.loadConversation({
          conversationId: fixtures.conversation.id,
          deadlineAt: deadlineFrom(controller.now()),
        });
        assert(
          recoveredLoad.ok,
          "the same Gateway must recover after reconnect",
        );
        await controller.emitUpdate(fixtures.realtimeMessageUpdate);
        const recoveredRealtimeUpdates = updates.filter(
          (update) => update.kind === "timeline.upsert",
        );
        assertEqual(
          recoveredRealtimeUpdates,
          [fixtures.realtimeMessageUpdate],
          "the original live subscription must resume after reconnect",
        );
        assert(
          updates.every(
            (update) =>
              update.kind === "timeline.upsert" ||
              (update.kind === "run.replace" &&
                update.conversationId === fixtures.conversation.id),
          ),
          "reconnect may additionally converge only the subscribed run state",
        );
        await subscribed.value.dispose({
          deadlineAt: deadlineFrom(controller.now()),
        });
      },
    ),
    gatewayCase("honors expired deadlines", factory, async ({ gateway }) => {
      const result = await gateway.listConversations({ deadlineAt: 0 });
      assert(
        !result.ok && result.error.code === "timeout",
        "expired operations must return a timeout error",
      );
    }),
    gatewayCase(
      "times out in-flight operations and discards late results",
      factory,
      async ({ controller, gateway }, fixtures) => {
        const operationHold = controller.holdNext("loadConversation");
        const operationDeadline = controller.now() + 1_000;
        const pendingLoad = gateway.loadConversation({
          conversationId: fixtures.conversation.id,
          deadlineAt: operationDeadline,
        });
        await operationHold.started;
        await controller.advanceTimeTo(operationDeadline);
        assertEqual(
          await pendingLoad,
          {
            ok: false,
            error: createGatewayDeadlineExceededError(fixtures.conversation.id),
          },
          "an in-flight operation must settle with the standard timeout",
        );
        operationHold.release();
        await operationHold.completed;
        assertEqual(
          await pendingLoad,
          {
            ok: false,
            error: createGatewayDeadlineExceededError(fixtures.conversation.id),
          },
          "a late transport result must not replace the timeout",
        );

        const timelySubscriptionHold = controller.holdNext("subscribe");
        const timelySubscription = gateway.subscribe(
          {
            conversationId: fixtures.conversation.id,
            deadlineAt: controller.now() + 1_000,
          },
          { next: () => undefined },
        );
        await timelySubscriptionHold.started;
        timelySubscriptionHold.release();
        await timelySubscriptionHold.completed;
        const timelySubscribed = await timelySubscription;
        assert(
          timelySubscribed.ok,
          "a transport subscription completed before deadline must be exposed",
        );
        assert(
          Number(timelySubscriptionHold.resourceDisposeCount) === 0,
          "a timely transport subscription must remain live until public disposal",
        );
        await timelySubscribed.value.dispose({
          deadlineAt: controller.now() + 1_000,
        });
        assert(
          timelySubscriptionHold.resourceDisposeCount === 1,
          "public subscription disposal must dispose its transport resource",
        );

        const subscriptionHold = controller.holdNext("subscribe");
        const subscriptionDeadline = controller.now() + 1_000;
        const received: ChatUpdate[] = [];
        const pendingSubscription = gateway.subscribe(
          {
            conversationId: fixtures.conversation.id,
            deadlineAt: subscriptionDeadline,
          },
          { next: (update) => received.push(update) },
        );
        await subscriptionHold.started;
        await controller.advanceTimeTo(subscriptionDeadline);
        assertEqual(
          await pendingSubscription,
          {
            ok: false,
            error: createGatewayDeadlineExceededError(fixtures.conversation.id),
          },
          "late subscription establishment must settle with the standard timeout",
        );
        assert(
          Number(subscriptionHold.resourceDisposeCount) === 0,
          "a timed-out subscription has no transport resource before completion",
        );
        subscriptionHold.release();
        assert(
          Number(subscriptionHold.resourceDisposeCount) === 0,
          "releasing the fake transport must not itself dispose its resource",
        );
        await subscriptionHold.completed;
        await Promise.resolve();
        assert(
          subscriptionHold.resourceDisposeCount === 1,
          "Gateway logic must dispose the transport subscription created after timeout",
        );
        await controller.emitUpdate(fixtures.realtimeMessageUpdate);
        assert(
          received.length === 0,
          "a late subscription must never notify its observer",
        );
      },
    ),
    gatewayCase(
      "bounds subscription and Gateway cleanup by deadline",
      factory,
      async ({ controller, gateway }, fixtures) => {
        const subscribed = await gateway.subscribe(
          {
            conversationId: fixtures.conversation.id,
            deadlineAt: controller.now() + 1_000,
          },
          { next: () => undefined },
        );
        assert(subscribed.ok, "subscribe must succeed before cleanup probes");

        const subscriptionCleanup = controller.holdNext("subscription.dispose");
        const subscriptionDeadline = controller.now() + 1_000;
        const disposingSubscription = subscribed.value.dispose({
          deadlineAt: subscriptionDeadline,
        });
        await subscriptionCleanup.started;
        await controller.advanceTimeTo(subscriptionDeadline);
        await disposingSubscription;
        subscriptionCleanup.release();

        const gatewayCleanup = controller.holdNext("gateway.dispose");
        const gatewayDeadline = controller.now() + 1_000;
        const disposingGateway = gateway.dispose({
          deadlineAt: gatewayDeadline,
        });
        await gatewayCleanup.started;
        await controller.advanceTimeTo(gatewayDeadline);
        await disposingGateway;
        gatewayCleanup.release();
      },
    ),
    gatewayCase(
      "owns transport subscription resources across rejection and disposal",
      factory,
      async ({ controller, gateway }, fixtures) => {
        const rejectedHold = controller.holdNext("subscribe");
        const rejectedSubscription = gateway.subscribe(
          {
            conversationId: "conversation-foreign",
            deadlineAt: controller.now() + 1_000,
          },
          { next: () => undefined },
        );
        await rejectedHold.started;
        rejectedHold.release();
        const rejected = await rejectedSubscription;
        assert(
          !rejected.ok && rejected.error.code === "not-found",
          "a transport subscription for an unknown conversation must be rejected",
        );
        assert(
          rejectedHold.resourceDisposeCount === 1,
          "a transport subscription rejected after establishment must be disposed",
        );

        const activeHold = controller.holdNext("subscribe");
        const activeSubscription = gateway.subscribe(
          {
            conversationId: fixtures.conversation.id,
            deadlineAt: controller.now() + 1_000,
          },
          { next: () => undefined },
        );
        await activeHold.started;
        activeHold.release();
        const active = await activeSubscription;
        assert(active.ok, "the held transport subscription must become active");
        assert(
          Number(activeHold.resourceDisposeCount) === 0,
          "an active transport subscription must remain live",
        );

        await gateway.dispose({ deadlineAt: controller.now() + 1_000 });
        assert(
          activeHold.resourceDisposeCount === 1,
          "Gateway disposal must dispose every active transport subscription",
        );
      },
    ),
    gatewayCase(
      "rejects a subscription that completes after Gateway disposal",
      factory,
      async ({ controller, gateway }, fixtures) => {
        const establishingHold = controller.holdNext("subscribe");
        const establishing = gateway.subscribe(
          {
            conversationId: fixtures.conversation.id,
            deadlineAt: controller.now() + 1_000,
          },
          { next: () => undefined },
        );
        await establishingHold.started;
        await gateway.dispose({ deadlineAt: controller.now() + 1_000 });
        establishingHold.release();

        const result = await establishing;
        assert(
          !result.ok && result.error.code === "conflict",
          "subscription establishment must not outlive Gateway disposal",
        );
        assert(
          establishingHold.resourceDisposeCount === 1,
          "a transport subscription completing after Gateway disposal must be disposed",
        );
      },
    ),
    gatewayCase(
      "becomes silent and remains idempotently disposable",
      factory,
      async ({ controller, gateway }, fixtures) => {
        const received: ChatUpdate[] = [];
        const subscribed = await gateway.subscribe(
          {
            conversationId: fixtures.conversation.id,
            deadlineAt: deadlineFrom(controller.now()),
          },
          { next: (update) => received.push(update) },
        );
        assert(subscribed.ok, "subscribe must succeed before Gateway disposal");

        await gateway.dispose({ deadlineAt: deadlineFrom(controller.now()) });
        await gateway.dispose({ deadlineAt: deadlineFrom(controller.now()) });
        await controller.emitUpdate(fixtures.realtimeMessageUpdate);
        assert(received.length === 0, "disposed Gateways must stay silent");
      },
    ),
  ]);
