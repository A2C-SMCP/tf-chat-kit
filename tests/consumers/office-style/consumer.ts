import { createElement, useEffect, type ReactElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import type { SessionProvider } from "@turingfocus/chat-protocol";
import {
  OwnedChatProvider,
  useChatClient,
  useChatSnapshot,
  type ChatClientFactory,
} from "@turingfocus/chat-react";
import { createChatClient, type ChatClient } from "@turingfocus/chat-runtime";
import {
  createChatContractFixtures,
  createMemoryChatGateway,
  type ChatContractFixtures,
  type MemoryGatewayHarness,
} from "@turingfocus/chat-testing";

const check = (condition: unknown, message: string): void => {
  if (!condition) throw new Error(message);
};

const deadlineAt = (): number => Date.now() + 60_000;

const flushMicrotasks = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

interface OfficeSession {
  readonly accessToken: string;
  readonly tenantId: string;
}

interface OfficeGatewayFactory {
  create(input: {
    readonly sessionProvider: SessionProvider<OfficeSession>;
  }): MemoryGatewayHarness;
}

interface OfficeRuntimeInstance {
  readonly client: ChatClient;
  readonly gateway: MemoryGatewayHarness;
}

interface OfficeRuntimeFactory extends ChatClientFactory {
  readonly instances: OfficeRuntimeInstance[];
}

interface OfficeHostFixture {
  readonly disposeErrors: unknown[];
  readonly factory: OfficeRuntimeFactory;
  readonly fixtures: ChatContractFixtures;
  readonly receivedSessionProviders: SessionProvider<OfficeSession>[];
  readonly renderedConversationIds: string[];
  readonly sessionProvider: SessionProvider<OfficeSession>;
  readonly sessionReads: string[];
}

const createOfficeHostFixture = (
  id: string,
  baseTimestamp: number,
): OfficeHostFixture => {
  const fixtures = createChatContractFixtures({
    baseTimestamp,
    conversationId: `office-conversation-${id}`,
  });
  const receivedSessionProviders: SessionProvider<OfficeSession>[] = [];
  const renderedConversationIds: string[] = [];
  const sessionReads: string[] = [];
  const disposeErrors: unknown[] = [];
  const sessionProvider: SessionProvider<OfficeSession> = {
    getSession(request) {
      sessionReads.push(
        `${request.purpose}:${request.operation}:${request.conversationId ?? "global"}`,
      );
      return {
        accessToken: `ephemeral-${id}`,
        tenantId: `tenant-${id}`,
      };
    },
  };
  const gatewayFactory: OfficeGatewayFactory = {
    create({ sessionProvider: received }) {
      receivedSessionProviders.push(received);
      return createMemoryChatGateway({ fixtures });
    },
  };
  const instances: OfficeRuntimeInstance[] = [];
  const factory: OfficeRuntimeFactory = {
    instances,
    create() {
      const gateway = gatewayFactory.create({ sessionProvider });
      const client = createChatClient({ gateway: gateway.gateway });
      instances.push({ client, gateway });
      return client;
    },
    getDisposeOptions: () => ({ deadlineAt: deadlineAt() }),
  };

  return {
    disposeErrors,
    factory,
    fixtures,
    receivedSessionProviders,
    renderedConversationIds,
    sessionProvider,
    sessionReads,
  };
};

const OfficeConversationProbe = ({
  fixture,
}: {
  readonly fixture: OfficeHostFixture;
}) => {
  const client = useChatClient();
  const snapshot = useChatSnapshot();
  const conversationId = snapshot?.conversation.id ?? "empty";
  fixture.renderedConversationIds.push(conversationId);

  useEffect(() => {
    void client;
  }, [client]);

  return createElement(
    "output",
    { "data-conversation-id": conversationId },
    snapshot?.conversation.title ?? "No conversation",
  );
};

const OfficeStyleConsumer = ({
  fixture,
}: {
  readonly fixture: OfficeHostFixture;
}) =>
  createElement(
    OwnedChatProvider,
    {
      factory: fixture.factory,
      fallback: createElement("output", null, "Starting Office chat"),
      onDisposeError: (error: unknown) => {
        fixture.disposeErrors.push(error);
      },
    },
    createElement(OfficeConversationProbe, { fixture }),
  );

const renderHosts = (
  first: OfficeHostFixture,
  second: OfficeHostFixture,
): ReactElement =>
  createElement(
    "section",
    null,
    createElement(OfficeStyleConsumer, { fixture: first, key: "first" }),
    createElement(OfficeStyleConsumer, { fixture: second, key: "second" }),
  );

export const runOfficeConsumerVerification = async (): Promise<void> => {
  const first = createOfficeHostFixture("first", 1_773_705_600_000);
  const second = createOfficeHostFixture("second", 1_773_705_610_000);
  const initialTree = renderHosts(first, second);

  check(
    first.factory.instances.length === 0 &&
      second.factory.instances.length === 0 &&
      first.sessionReads.length === 0 &&
      second.sessionReads.length === 0,
    "render composition must not create clients or read session material",
  );

  let renderer: ReactTestRenderer | undefined;
  await act(async () => {
    renderer = create(initialTree);
    await flushMicrotasks();
  });
  if (renderer === undefined) throw new Error("Office consumer did not mount");
  const mountedRenderer = renderer;

  check(
    first.factory.instances.length === 1 &&
      second.factory.instances.length === 1,
    "each Office-style host must own exactly one client",
  );
  check(
    first.receivedSessionProviders[0] === first.sessionProvider &&
      second.receivedSessionProviders[0] === second.sessionProvider &&
      first.receivedSessionProviders[0] !== second.receivedSessionProviders[0],
    "SessionProvider injection must remain instance-scoped",
  );
  check(
    first.sessionReads.length === 0 && second.sessionReads.length === 0,
    "client construction must not eagerly read session material",
  );

  const firstSession = await first.receivedSessionProviders[0]!.getSession({
    purpose: "request",
    operation: "read",
    conversationId: first.fixtures.conversation.id,
  });
  const secondSession = await second.receivedSessionProviders[0]!.getSession({
    purpose: "request",
    operation: "read",
    conversationId: second.fixtures.conversation.id,
  });
  check(
    firstSession.tenantId === "tenant-first" &&
      secondSession.tenantId === "tenant-second" &&
      firstSession.accessToken !== secondSession.accessToken,
    "injected SessionProviders must expose only their own ephemeral sessions",
  );

  const firstInstance = first.factory.instances[0]!;
  const secondInstance = second.factory.instances[0]!;
  const createdByMemory =
    await firstInstance.gateway.gateway.createConversation({
      title: "Office-created conversation",
      deadlineAt: deadlineAt(),
    });
  check(
    createdByMemory.ok,
    "the packed Memory Gateway must create conversations",
  );
  if (!createdByMemory.ok) throw new Error(createdByMemory.error.message);
  const listedByMemory = await firstInstance.gateway.gateway.listConversations({
    deadlineAt: deadlineAt(),
  });
  check(
    listedByMemory.ok &&
      listedByMemory.value.conversations.some(
        ({ id }) => id === createdByMemory.value.id,
      ),
    "the packed Memory Gateway must list newly created conversations",
  );
  const loadedByMemory = await firstInstance.gateway.gateway.loadConversation({
    conversationId: createdByMemory.value.id,
    deadlineAt: deadlineAt(),
  });
  check(
    loadedByMemory.ok &&
      loadedByMemory.value.conversation.id === createdByMemory.value.id,
    "the packed Memory Gateway must load newly created conversations",
  );
  let firstNotifications = 0;
  let secondNotifications = 0;
  const firstSubscription = firstInstance.client.subscribe(() => {
    firstNotifications += 1;
  });
  const secondSubscription = secondInstance.client.subscribe(() => {
    secondNotifications += 1;
  });
  const [firstLoaded, secondLoaded] = await Promise.all([
    firstInstance.client.loadConversation({
      conversationId: first.fixtures.conversation.id,
      deadlineAt: deadlineAt(),
    }),
    secondInstance.client.loadConversation({
      conversationId: second.fixtures.conversation.id,
      deadlineAt: deadlineAt(),
    }),
  ]);
  await act(flushMicrotasks);
  check(firstLoaded.ok && secondLoaded.ok, "both Office clients must load");
  check(
    first.renderedConversationIds.includes(first.fixtures.conversation.id) &&
      second.renderedConversationIds.includes(second.fixtures.conversation.id),
    "unstyled React consumers must observe their own loaded conversations",
  );

  const secondNotificationsBeforeUpdate = secondNotifications;
  firstInstance.gateway.controller.emitUpdateToAll(
    first.fixtures.realtimeMessageUpdate,
  );
  await act(flushMicrotasks);
  check(
    firstInstance.client
      .getSnapshot()
      ?.timeline.some(({ id }) => id === "message-realtime") === true &&
      secondNotifications === secondNotificationsBeforeUpdate,
    "a realtime update must remain isolated to its owning Office client",
  );

  const [firstSent, secondSent, firstInterrupted, secondInterrupted] =
    await Promise.all([
      firstInstance.client.sendText({
        conversationId: first.fixtures.conversation.id,
        deadlineAt: deadlineAt(),
        text: "first Office message",
      }),
      secondInstance.client.sendText({
        conversationId: second.fixtures.conversation.id,
        deadlineAt: deadlineAt(),
        text: "second Office message",
      }),
      firstInstance.client.interrupt({
        conversationId: first.fixtures.conversation.id,
        deadlineAt: deadlineAt(),
      }),
      secondInstance.client.interrupt({
        conversationId: second.fixtures.conversation.id,
        deadlineAt: deadlineAt(),
      }),
    ]);
  check(
    firstSent.ok &&
      secondSent.ok &&
      firstInterrupted.ok &&
      secondInterrupted.ok,
    "load, send, and interrupt must complete through public Runtime commands",
  );

  const replacement = createOfficeHostFixture("replacement", 1_773_705_620_000);
  await act(async () => {
    mountedRenderer.update(renderHosts(replacement, second));
    await flushMicrotasks();
  });
  check(
    firstInstance.client.disposed,
    "replacing an Office provider must initiate disposal of its previous client",
  );
  await firstInstance.client.dispose({ deadlineAt: deadlineAt() });
  check(
    firstInstance.gateway.controller.disposed &&
      replacement.factory.instances.length === 1 &&
      !secondInstance.client.disposed &&
      !secondInstance.gateway.controller.disposed,
    "replacing one Office provider must dispose only its previous client",
  );

  const firstNotificationsAfterReplacement = firstNotifications;
  const replacedDeliveryCount =
    firstInstance.gateway.controller.emitUpdateToAll(
      first.fixtures.unknownEventUpdate,
    );
  const secondNotificationsAfterReplacement = secondNotifications;
  const unaffectedDeliveryCount =
    secondInstance.gateway.controller.emitUpdateToAll(
      second.fixtures.realtimeMessageUpdate,
    );
  await act(flushMicrotasks);
  check(
    replacedDeliveryCount === 0 &&
      firstNotifications === firstNotificationsAfterReplacement &&
      unaffectedDeliveryCount === 1 &&
      secondNotifications > secondNotificationsAfterReplacement,
    "replacement must remove stale observers without disturbing the unaffected provider",
  );

  const replacementInstance = replacement.factory.instances[0]!;
  const secondNotificationsBeforeUnmount = secondNotifications;
  await act(async () => {
    mountedRenderer.unmount();
    await flushMicrotasks();
  });
  check(
    replacementInstance.client.disposed && secondInstance.client.disposed,
    "unmount must initiate disposal of every remaining provider-owned client",
  );
  await Promise.all([
    replacementInstance.client.dispose({ deadlineAt: deadlineAt() }),
    secondInstance.client.dispose({ deadlineAt: deadlineAt() }),
  ]);
  check(
    replacementInstance.gateway.controller.disposed &&
      secondInstance.gateway.controller.disposed,
    "unmount must fully dispose every remaining provider-owned client and gateway",
  );
  const replacementLateDeliveryCount =
    replacementInstance.gateway.controller.emitUpdateToAll(
      replacement.fixtures.unknownEventUpdate,
    );
  const secondLateDeliveryCount =
    secondInstance.gateway.controller.emitUpdateToAll(
      second.fixtures.unknownEventUpdate,
    );
  check(
    replacementLateDeliveryCount === 0 &&
      secondLateDeliveryCount === 0 &&
      secondNotifications === secondNotificationsBeforeUnmount,
    "unmounted Office gateways must have no live observers or late notifications",
  );
  check(
    first.disposeErrors.length === 0 &&
      replacement.disposeErrors.length === 0 &&
      second.disposeErrors.length === 0,
    "Office provider disposal must complete without hidden cleanup errors",
  );

  firstSubscription.dispose();
  secondSubscription.dispose();
};
