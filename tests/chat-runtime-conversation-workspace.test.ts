import { describe, expect, it, vi } from "vitest";

import {
  createChatClient,
  createConversationWorkspaceController,
  orderConversationsByUpdatedAt,
} from "../packages/chat-runtime/src/index.js";
import { createMemoryChatGateway } from "../packages/chat-testing/src/index.js";

const deadlineAt = (): number => Date.now() + 60_000;

describe("ConversationWorkspaceController", () => {
  it("owns the default list, creation, selection and active metadata workflow", async () => {
    const memory = createMemoryChatGateway();
    const client = createChatClient({ gateway: memory.gateway });
    const controller = createConversationWorkspaceController({
      client,
      getDeadlineAt: deadlineAt,
      orderConversations: orderConversationsByUpdatedAt,
    });

    await controller.start();
    expect(controller.getSnapshot()).toMatchObject({
      conversations: [{ id: memory.fixtures.conversation.id }],
      listStatus: "ready",
      selectedConversationId: memory.fixtures.conversation.id,
      selectionStatus: "ready",
    });

    const created = await controller.createConversation({
      title: "Managed conversation",
    });
    expect(created).toMatchObject({
      ok: true,
      value: { title: "Managed conversation" },
    });
    if (!created.ok) return;
    expect(controller.getSnapshot()).toMatchObject({
      creating: false,
      selectedConversationId: created.value.id,
      selectionStatus: "ready",
    });
    expect(controller.getSnapshot().conversations[0]?.id).toBe(
      created.value.id,
    );
    expect(client.getSnapshot()?.conversation.id).toBe(created.value.id);

    await controller.selectConversation(memory.fixtures.conversation.id);
    memory.controller.emitUpdateToAll({
      kind: "conversation.upsert",
      conversation: {
        ...memory.fixtures.conversation,
        title: "Renamed while active",
      },
    });
    expect(
      controller
        .getSnapshot()
        .conversations.find(({ id }) => id === memory.fixtures.conversation.id)
        ?.title,
    ).toBe("Renamed while active");

    controller.dispose();
    expect(controller.disposed).toBe(true);
    expect(client.disposed).toBe(false);
    await client.dispose({ deadlineAt: deadlineAt() });
  });

  it("renames and deletes conversations while keeping selection state coherent", async () => {
    const memory = createMemoryChatGateway();
    const client = createChatClient({ gateway: memory.gateway });
    const controller = createConversationWorkspaceController({
      client,
      getDeadlineAt: deadlineAt,
    });
    await controller.start();
    const created = await controller.createConversation({
      title: "Managed target",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const renamed = await controller.renameConversation({
      conversationId: created.value.id,
      title: "Renamed target",
    });
    expect(renamed).toMatchObject({
      ok: true,
      value: { id: created.value.id, title: "Renamed target" },
    });
    expect(controller.getSnapshot()).toMatchObject({
      conversationMutationError: undefined,
      renamingConversationIds: [],
      selectedConversationId: created.value.id,
    });
    expect(client.getSnapshot()?.conversation.title).toBe("Renamed target");

    await expect(
      controller.deleteConversation(created.value.id),
    ).resolves.toEqual({
      ok: true,
      value: { deletedConversationId: created.value.id },
    });
    expect(controller.getSnapshot()).toMatchObject({
      deletingConversationIds: [],
      selectedConversationId: undefined,
      selectionStatus: "idle",
    });
    expect(
      controller
        .getSnapshot()
        .conversations.some(({ id }) => id === created.value.id),
    ).toBe(false);

    controller.dispose();
    await client.dispose({ deadlineAt: deadlineAt() });
  });

  it("exposes mutation progress, rejects overlap and preserves failures", async () => {
    const memory = createMemoryChatGateway();
    const client = createChatClient({ gateway: memory.gateway });
    const controller = createConversationWorkspaceController({
      client,
      getDeadlineAt: deadlineAt,
    });
    await controller.start();
    const conversationId = memory.fixtures.conversation.id;
    const renameHold = memory.controller.holdNext("renameConversation");
    const renaming = controller.renameConversation({
      conversationId,
      title: "Held rename",
    });
    await renameHold.started;
    expect(controller.getSnapshot().renamingConversationIds).toEqual([
      conversationId,
    ]);
    await expect(
      controller.deleteConversation(conversationId),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "conflict" },
    });
    renameHold.release();
    await renaming;

    memory.controller.failNext("deleteConversation", {
      code: "authorization",
      conversationId,
      message: "delete denied",
      retryable: false,
    });
    await expect(
      controller.deleteConversation(conversationId),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "authorization" },
    });
    expect(controller.getSnapshot()).toMatchObject({
      conversationMutationError: {
        code: "authorization",
        message: "delete denied",
      },
      deletingConversationIds: [],
    });
    expect(
      controller
        .getSnapshot()
        .conversations.some(({ id }) => id === conversationId),
    ).toBe(true);

    controller.dispose();
    await client.dispose({ deadlineAt: deadlineAt() });
  });

  it("does not let a list request started before a mutation restore stale metadata", async () => {
    const memory = createMemoryChatGateway();
    memory.controller.setConversationPage({
      conversations: [memory.fixtures.conversation],
    });
    const client = createChatClient({ gateway: memory.gateway });
    const controller = createConversationWorkspaceController({
      client,
      getDeadlineAt: deadlineAt,
    });
    await controller.start();
    const conversationId = memory.fixtures.conversation.id;

    const staleRenameList = memory.controller.holdNext("listConversations");
    const refreshingBeforeRename = controller.refresh();
    await staleRenameList.started;
    await controller.renameConversation({
      conversationId,
      title: "Mutation wins",
    });
    staleRenameList.release();
    await refreshingBeforeRename;
    expect(controller.getSnapshot()).toMatchObject({
      conversations: [{ id: conversationId, title: "Mutation wins" }],
      listStatus: "ready",
    });

    const staleDeleteList = memory.controller.holdNext("listConversations");
    const cleanupHold = memory.controller.holdNext("subscription.dispose");
    const refreshingBeforeDelete = controller.refresh();
    await staleDeleteList.started;
    const deleting = controller.deleteConversation(conversationId);
    await cleanupHold.started;
    staleDeleteList.release();
    await refreshingBeforeDelete;
    expect(controller.getSnapshot()).toMatchObject({
      conversations: [],
      listStatus: "ready",
      selectedConversationId: undefined,
    });
    cleanupHold.release();
    await deleting;

    controller.dispose();
    await client.dispose({ deadlineAt: deadlineAt() });
  });

  it("restores the selected conversation when a pending selection is deleted", async () => {
    const memory = createMemoryChatGateway();
    const client = createChatClient({ gateway: memory.gateway });
    const controller = createConversationWorkspaceController({
      client,
      getDeadlineAt: deadlineAt,
    });
    await controller.start();
    const selectedId = memory.fixtures.conversation.id;
    const created = await memory.gateway.createConversation({
      deadlineAt: deadlineAt(),
      title: "Pending deletion target",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    await controller.refresh();

    const loadHold = memory.controller.holdNext("loadConversation");
    const selecting = controller.selectConversation(created.value.id);
    await loadHold.started;
    expect(controller.getSnapshot()).toMatchObject({
      pendingConversationId: created.value.id,
      selectedConversationId: selectedId,
      selectionStatus: "loading",
    });

    await expect(
      controller.deleteConversation(created.value.id),
    ).resolves.toMatchObject({ ok: true });
    expect(client.getSnapshot()?.conversation.id).toBe(selectedId);
    expect(controller.getSnapshot()).toMatchObject({
      pendingConversationId: undefined,
      selectedConversationId: selectedId,
      selectionStatus: "ready",
    });

    loadHold.release();
    await expect(selecting).resolves.toMatchObject({
      ok: false,
      error: { code: "conflict" },
    });
    expect(controller.getSnapshot()).toMatchObject({
      selectedConversationId: selectedId,
      selectionStatus: "ready",
    });

    controller.dispose();
    await client.dispose({ deadlineAt: deadlineAt() });
  });

  it("preserves Gateway page order by default and appends deduplicated pages", async () => {
    const memory = createMemoryChatGateway();
    const created = await memory.gateway.createConversation({
      deadlineAt: deadlineAt(),
      title: "Second page",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    memory.controller.setConversationPage({
      conversations: [memory.fixtures.conversation],
      nextCursor: "page-2",
    });
    const client = createChatClient({ gateway: memory.gateway });
    const controller = createConversationWorkspaceController({
      client,
      getDeadlineAt: deadlineAt,
      initialSelection: "none",
      pageSize: 1,
    });

    await controller.start();
    expect(controller.getSnapshot()).toMatchObject({
      conversations: [{ id: memory.fixtures.conversation.id }],
      nextCursor: "page-2",
      selectionStatus: "empty",
    });

    memory.controller.setConversationPage({
      conversations: [memory.fixtures.conversation, created.value],
    });
    await controller.loadMore();
    expect(controller.getSnapshot().conversations.map(({ id }) => id)).toEqual([
      memory.fixtures.conversation.id,
      created.value.id,
    ]);
    expect(controller.getSnapshot().nextCursor).toBeUndefined();
    expect(await controller.loadMore()).toBeUndefined();

    controller.dispose();
    await client.dispose({ deadlineAt: deadlineAt() });
  });

  it("lets the latest user selection win when an older load settles later", async () => {
    const memory = createMemoryChatGateway();
    const created = await memory.gateway.createConversation({
      deadlineAt: deadlineAt(),
      title: "Latest selection",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const client = createChatClient({ gateway: memory.gateway });
    const controller = createConversationWorkspaceController({
      client,
      getDeadlineAt: deadlineAt,
      initialSelection: "none",
    });
    await controller.start();

    const firstHold = memory.controller.holdNext("loadConversation");
    const secondHold = memory.controller.holdNext("loadConversation");
    const firstSelection = controller.selectConversation(
      memory.fixtures.conversation.id,
    );
    await firstHold.started;
    const secondSelection = controller.selectConversation(created.value.id);
    await secondHold.started;
    secondHold.release();
    await secondSelection;
    expect(controller.getSnapshot().selectedConversationId).toBe(
      created.value.id,
    );

    firstHold.release();
    await firstSelection;
    expect(controller.getSnapshot()).toMatchObject({
      pendingConversationId: undefined,
      selectedConversationId: created.value.id,
      selectionStatus: "ready",
    });

    controller.dispose();
    await client.dispose({ deadlineAt: deadlineAt() });
  });

  it("does not let delayed creation override a newer explicit selection", async () => {
    const memory = createMemoryChatGateway();
    const client = createChatClient({ gateway: memory.gateway });
    const controller = createConversationWorkspaceController({
      client,
      getDeadlineAt: deadlineAt,
    });
    await controller.start();

    const createHold = memory.controller.holdNext("createConversation");
    const pendingCreation = controller.createConversation({
      title: "Created after selection",
    });
    await createHold.started;
    await controller.selectConversation(memory.fixtures.conversation.id);
    createHold.release();
    const created = await pendingCreation;
    expect(created.ok).toBe(true);
    expect(controller.getSnapshot().selectedConversationId).toBe(
      memory.fixtures.conversation.id,
    );
    expect(
      controller
        .getSnapshot()
        .conversations.some(({ title }) => title === "Created after selection"),
    ).toBe(true);

    controller.dispose();
    await client.dispose({ deadlineAt: deadlineAt() });
  });

  it("does not interrupt an in-flight selection when creation opts out of selection", async () => {
    const memory = createMemoryChatGateway();
    const client = createChatClient({ gateway: memory.gateway });
    const controller = createConversationWorkspaceController({
      client,
      getDeadlineAt: deadlineAt,
      initialSelection: "none",
    });
    await controller.start();

    const selectionHold = memory.controller.holdNext("loadConversation");
    const selection = controller.selectConversation(
      memory.fixtures.conversation.id,
    );
    await selectionHold.started;
    const created = await controller.createConversation({
      select: false,
      title: "Background creation",
    });
    expect(created.ok).toBe(true);

    selectionHold.release();
    await selection;
    expect(controller.getSnapshot()).toMatchObject({
      selectedConversationId: memory.fixtures.conversation.id,
      selectionStatus: "ready",
    });

    controller.dispose();
    await client.dispose({ deadlineAt: deadlineAt() });
  });

  it("does not strand an in-flight selection when auto-selecting creation fails", async () => {
    const memory = createMemoryChatGateway();
    const client = createChatClient({ gateway: memory.gateway });
    const controller = createConversationWorkspaceController({
      client,
      getDeadlineAt: deadlineAt,
      initialSelection: "none",
    });
    await controller.start();

    const selectionHold = memory.controller.holdNext("loadConversation");
    const selection = controller.selectConversation(
      memory.fixtures.conversation.id,
    );
    await selectionHold.started;
    memory.controller.failNext("createConversation", {
      code: "network",
      message: "create failed",
      retryable: true,
    });
    const created = await controller.createConversation({
      title: "Failed creation",
    });
    expect(created).toMatchObject({
      ok: false,
      error: { code: "network", message: "create failed" },
    });

    selectionHold.release();
    await expect(selection).resolves.toMatchObject({ ok: true });
    expect(controller.getSnapshot()).toMatchObject({
      creating: false,
      creationError: { code: "network", message: "create failed" },
      pendingConversationId: undefined,
      selectedConversationId: memory.fixtures.conversation.id,
      selectionStatus: "ready",
    });
    expect(client.getSnapshot()?.conversation.id).toBe(
      memory.fixtures.conversation.id,
    );

    controller.dispose();
    await client.dispose({ deadlineAt: deadlineAt() });
  });

  it("lets creation supersede an internal first selection during initial loading", async () => {
    const memory = createMemoryChatGateway();
    const client = createChatClient({ gateway: memory.gateway });
    const controller = createConversationWorkspaceController({
      client,
      getDeadlineAt: deadlineAt,
    });
    const listHold = memory.controller.holdNext("listConversations");
    const starting = controller.start();
    await listHold.started;
    const createHold = memory.controller.holdNext("createConversation");
    const creating = controller.createConversation({
      title: "Created during initial loading",
    });
    await createHold.started;

    listHold.release();
    await starting;
    expect(controller.getSnapshot().selectedConversationId).toBe(
      memory.fixtures.conversation.id,
    );

    createHold.release();
    const created = await creating;
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(controller.getSnapshot()).toMatchObject({
      pendingConversationId: undefined,
      selectedConversationId: created.value.id,
      selectionStatus: "ready",
    });
    expect(client.getSnapshot()?.conversation.id).toBe(created.value.id);

    controller.dispose();
    await client.dispose({ deadlineAt: deadlineAt() });
  });

  it("lets a newer refresh replace an older pending internal first selection", async () => {
    const memory = createMemoryChatGateway();
    const created = await memory.gateway.createConversation({
      deadlineAt: deadlineAt(),
      title: "Newer refresh target",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    memory.controller.setConversationPage({
      conversations: [memory.fixtures.conversation],
    });
    const client = createChatClient({ gateway: memory.gateway });
    const controller = createConversationWorkspaceController({
      client,
      getDeadlineAt: deadlineAt,
    });
    const oldSelectionHold = memory.controller.holdNext("loadConversation");
    const oldRefresh = controller.refresh();
    await oldSelectionHold.started;

    memory.controller.setConversationPage({ conversations: [created.value] });
    await controller.refresh();
    expect(controller.getSnapshot()).toMatchObject({
      conversations: [{ id: created.value.id }],
      pendingConversationId: undefined,
      selectedConversationId: created.value.id,
      selectionStatus: "ready",
    });

    oldSelectionHold.release();
    await oldRefresh;
    expect(controller.getSnapshot()).toMatchObject({
      conversations: [{ id: created.value.id }],
      selectedConversationId: created.value.id,
      selectionStatus: "ready",
    });
    expect(client.getSnapshot()?.conversation.id).toBe(created.value.id);

    controller.dispose();
    await client.dispose({ deadlineAt: deadlineAt() });
  });

  it("keeps an empty newer refresh consistent after cancelling internal selection", async () => {
    const memory = createMemoryChatGateway();
    const client = createChatClient({ gateway: memory.gateway });
    const controller = createConversationWorkspaceController({
      client,
      getDeadlineAt: deadlineAt,
    });
    const oldSelectionHold = memory.controller.holdNext("loadConversation");
    const oldRefresh = controller.refresh();
    await oldSelectionHold.started;

    memory.controller.setConversationPage({ conversations: [] });
    await controller.refresh();
    expect(controller.getSnapshot()).toMatchObject({
      conversations: [],
      pendingConversationId: undefined,
      selectionStatus: "empty",
    });
    expect(controller.getSnapshot().selectedConversationId).toBeUndefined();
    expect(client.getSnapshot()).toBeNull();

    oldSelectionHold.release();
    await oldRefresh;
    expect(controller.getSnapshot()).toMatchObject({
      conversations: [],
      pendingConversationId: undefined,
      selectionStatus: "empty",
    });
    expect(controller.getSnapshot().selectedConversationId).toBeUndefined();
    expect(client.getSnapshot()).toBeNull();

    controller.dispose();
    await client.dispose({ deadlineAt: deadlineAt() });
  });

  it("keeps Client and workspace unselected when a newer refresh fails", async () => {
    const memory = createMemoryChatGateway();
    const client = createChatClient({ gateway: memory.gateway });
    const controller = createConversationWorkspaceController({
      client,
      getDeadlineAt: deadlineAt,
    });
    const oldSelectionHold = memory.controller.holdNext("loadConversation");
    const oldRefresh = controller.refresh();
    await oldSelectionHold.started;
    memory.controller.failNext("listConversations", {
      code: "network",
      message: "newer refresh failed",
      retryable: true,
    });

    await controller.refresh();
    expect(controller.getSnapshot()).toMatchObject({
      listError: { code: "network", message: "newer refresh failed" },
      listStatus: "error",
      pendingConversationId: undefined,
      selectionStatus: "idle",
    });

    oldSelectionHold.release();
    await oldRefresh;
    expect(controller.getSnapshot()).toMatchObject({
      listStatus: "error",
      pendingConversationId: undefined,
      selectionStatus: "idle",
    });
    expect(controller.getSnapshot().selectedConversationId).toBeUndefined();
    expect(client.getSnapshot()).toBeNull();

    controller.dispose();
    await client.dispose({ deadlineAt: deadlineAt() });
  });

  it("preserves a pending explicit selection across an empty refresh", async () => {
    const memory = createMemoryChatGateway();
    const client = createChatClient({ gateway: memory.gateway });
    const controller = createConversationWorkspaceController({
      client,
      getDeadlineAt: deadlineAt,
      initialSelection: "none",
    });
    await controller.start();
    const selectionHold = memory.controller.holdNext("loadConversation");
    const selection = controller.selectConversation(
      memory.fixtures.conversation.id,
    );
    await selectionHold.started;

    memory.controller.setConversationPage({ conversations: [] });
    await controller.refresh();
    expect(controller.getSnapshot()).toMatchObject({
      conversations: [],
      pendingConversationId: memory.fixtures.conversation.id,
      selectionStatus: "loading",
    });

    selectionHold.release();
    await selection;
    expect(controller.getSnapshot()).toMatchObject({
      pendingConversationId: undefined,
      selectedConversationId: memory.fixtures.conversation.id,
      selectionStatus: "ready",
    });

    controller.dispose();
    await client.dispose({ deadlineAt: deadlineAt() });
  });

  it("retires its pending Client load and transport when disposed", async () => {
    const memory = createMemoryChatGateway();
    const client = createChatClient({ gateway: memory.gateway });
    const controller = createConversationWorkspaceController({
      client,
      getDeadlineAt: deadlineAt,
      initialSelection: "none",
    });
    await controller.start();
    const subscriptionHold = memory.controller.holdNext("subscribe");
    const selection = controller.selectConversation(
      memory.fixtures.conversation.id,
    );
    await subscriptionHold.started;

    controller.dispose();
    subscriptionHold.release();
    await expect(selection).resolves.toMatchObject({
      ok: false,
      error: { code: "conflict" },
    });
    expect(subscriptionHold.resourceDisposeCount).toBe(1);
    expect(client.getSnapshot()).toBeNull();
    expect(client.disposed).toBe(false);

    await client.dispose({ deadlineAt: deadlineAt() });
  });

  it("retires the older Client load before a newer selection deadline fails", async () => {
    const memory = createMemoryChatGateway();
    const client = createChatClient({ gateway: memory.gateway });
    let deadlineRequest = 0;
    const controller = createConversationWorkspaceController({
      client,
      getDeadlineAt: () => {
        deadlineRequest += 1;
        if (deadlineRequest === 3) throw new Error("deadline unavailable");
        return deadlineAt();
      },
      initialSelection: "none",
    });
    await controller.start();
    const oldLoadHold = memory.controller.holdNext("loadConversation");
    const oldSelection = controller.selectConversation(
      memory.fixtures.conversation.id,
    );
    await oldLoadHold.started;

    await expect(
      controller.selectConversation("newer-conversation"),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "unknown" },
    });
    oldLoadHold.release();
    await expect(oldSelection).resolves.toMatchObject({
      ok: false,
      error: { code: "conflict" },
    });
    expect(client.getSnapshot()).toBeNull();
    expect(controller.getSnapshot()).toMatchObject({
      pendingConversationId: undefined,
      selectionError: { code: "unknown" },
      selectionStatus: "error",
    });

    controller.dispose();
    await client.dispose({ deadlineAt: deadlineAt() });
  });

  it("keeps a committed selection when its cleanup overlaps a newer deadline failure", async () => {
    const memory = createMemoryChatGateway();
    const created = await memory.gateway.createConversation({
      deadlineAt: deadlineAt(),
      title: "Committed before cleanup",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    memory.controller.setConversationPage({
      conversations: [memory.fixtures.conversation, created.value],
    });
    const client = createChatClient({ gateway: memory.gateway });
    let deadlineRequest = 0;
    const controller = createConversationWorkspaceController({
      client,
      getDeadlineAt: () => {
        deadlineRequest += 1;
        if (deadlineRequest === 4) throw new Error("deadline unavailable");
        return deadlineAt();
      },
    });
    await controller.start();
    const cleanupHold = memory.controller.holdNext("subscription.dispose");
    const committedSelection = controller.selectConversation(created.value.id);
    await cleanupHold.started;
    expect(client.getSnapshot()?.conversation.id).toBe(created.value.id);
    expect(controller.getSnapshot()).toMatchObject({
      pendingConversationId: undefined,
      selectedConversationId: created.value.id,
      selectionStatus: "ready",
    });

    await expect(
      controller.selectConversation("newer-conversation"),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "unknown" },
    });
    cleanupHold.release();
    await expect(committedSelection).resolves.toMatchObject({ ok: true });
    expect(client.getSnapshot()?.conversation.id).toBe(created.value.id);
    expect(controller.getSnapshot()).toMatchObject({
      pendingConversationId: undefined,
      selectedConversationId: created.value.id,
      selectionError: { code: "unknown" },
      selectionStatus: "error",
    });

    controller.dispose();
    await client.dispose({ deadlineAt: deadlineAt() });
  });

  it("does not cancel an internal selection after the Client snapshot commits", async () => {
    const memory = createMemoryChatGateway();
    const client = createChatClient({ gateway: memory.gateway });
    const controller = createConversationWorkspaceController({
      client,
      getDeadlineAt: deadlineAt,
    });
    let newerRefresh: ReturnType<typeof controller.refresh> | undefined;
    const subscription = client.subscribe((snapshot) => {
      if (snapshot === null) return;
      if (newerRefresh !== undefined) return;
      memory.controller.setConversationPage({ conversations: [] });
      newerRefresh = controller.refresh();
      expect(snapshot.conversation.id).toBe(memory.fixtures.conversation.id);
    });

    await controller.start();
    expect(newerRefresh).toBeDefined();
    await newerRefresh;
    expect(client.getSnapshot()?.conversation.id).toBe(
      memory.fixtures.conversation.id,
    );
    expect(controller.getSnapshot()).toMatchObject({
      selectedConversationId: memory.fixtures.conversation.id,
      selectionStatus: "ready",
    });

    subscription.dispose();
    controller.dispose();
    await client.dispose({ deadlineAt: deadlineAt() });
  });

  it.each(["empty", "failed"] as const)(
    "does not auto-select an older page when a reentrant refresh is %s",
    async (newerOutcome) => {
      const memory = createMemoryChatGateway();
      const client = createChatClient({ gateway: memory.gateway });
      const controller = createConversationWorkspaceController({
        client,
        getDeadlineAt: deadlineAt,
      });
      let newerRefresh: ReturnType<typeof controller.refresh> | undefined;
      let triggered = false;
      const subscription = controller.subscribe((snapshot) => {
        if (
          triggered ||
          snapshot.listStatus !== "ready" ||
          snapshot.conversations.length === 0
        ) {
          return;
        }
        triggered = true;
        if (newerOutcome === "empty") {
          memory.controller.setConversationPage({ conversations: [] });
        } else {
          memory.controller.failNext("listConversations", {
            code: "network",
            message: "reentrant refresh failed",
            retryable: true,
          });
        }
        newerRefresh = controller.refresh();
      });

      await controller.refresh();
      expect(newerRefresh).toBeDefined();
      await newerRefresh;
      expect(client.getSnapshot()).toBeNull();
      expect(controller.getSnapshot()).toMatchObject({
        listStatus: newerOutcome === "empty" ? "ready" : "error",
        selectionStatus: newerOutcome === "empty" ? "empty" : "idle",
      });
      expect(controller.getSnapshot().pendingConversationId).toBeUndefined();
      expect(controller.getSnapshot().selectedConversationId).toBeUndefined();

      subscription.dispose();
      controller.dispose();
      await client.dispose({ deadlineAt: deadlineAt() });
    },
  );

  it("does not start a Client load after a pending subscriber disposes it", async () => {
    const memory = createMemoryChatGateway();
    const client = createChatClient({ gateway: memory.gateway });
    const controller = createConversationWorkspaceController({
      client,
      getDeadlineAt: deadlineAt,
      initialSelection: "none",
    });
    await controller.start();
    controller.subscribe((snapshot) => {
      if (snapshot.selectionStatus === "loading") controller.dispose();
    });

    await expect(
      controller.selectConversation(memory.fixtures.conversation.id),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "conflict" },
    });
    expect(client.getSnapshot()).toBeNull();
    expect(
      memory.controller.calls.filter(
        ({ operation }) =>
          operation === "subscribe" || operation === "loadConversation",
      ),
    ).toEqual([]);

    await client.dispose({ deadlineAt: deadlineAt() });
  });

  it("lets a reentrant selection start before the older pending call returns", async () => {
    const memory = createMemoryChatGateway();
    const created = await memory.gateway.createConversation({
      deadlineAt: deadlineAt(),
      title: "Reentrant selection",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const client = createChatClient({ gateway: memory.gateway });
    const controller = createConversationWorkspaceController({
      client,
      getDeadlineAt: deadlineAt,
      initialSelection: "none",
    });
    await controller.start();
    let reentrantSelection:
      ReturnType<typeof controller.selectConversation> | undefined;
    controller.subscribe((snapshot) => {
      if (
        reentrantSelection === undefined &&
        snapshot.pendingConversationId === memory.fixtures.conversation.id
      ) {
        reentrantSelection = controller.selectConversation(created.value.id);
      }
    });

    await expect(
      controller.selectConversation(memory.fixtures.conversation.id),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "conflict" },
    });
    expect(reentrantSelection).toBeDefined();
    await expect(reentrantSelection).resolves.toMatchObject({ ok: true });
    expect(client.getSnapshot()?.conversation.id).toBe(created.value.id);
    expect(controller.getSnapshot()).toMatchObject({
      pendingConversationId: undefined,
      selectedConversationId: created.value.id,
      selectionStatus: "ready",
    });
    expect(
      memory.controller.calls.filter(
        ({ operation }) => operation === "loadConversation",
      ),
    ).toHaveLength(1);

    controller.dispose();
    await client.dispose({ deadlineAt: deadlineAt() });
  });

  it.each(["refresh", "create"] as const)(
    "does not issue a %s request after its loading subscriber disposes it",
    async (command) => {
      const memory = createMemoryChatGateway();
      const client = createChatClient({ gateway: memory.gateway });
      const controller = createConversationWorkspaceController({
        client,
        getDeadlineAt: deadlineAt,
        initialSelection: "none",
      });
      controller.subscribe((snapshot) => {
        if (snapshot.listStatus === "loading" || snapshot.creating) {
          controller.dispose();
        }
      });

      const result =
        command === "refresh"
          ? await controller.refresh()
          : await controller.createConversation({ title: "Disposed create" });
      expect(result).toMatchObject({
        ok: false,
        error: { code: "conflict" },
      });
      expect(
        memory.controller.calls.filter(({ operation }) =>
          command === "refresh"
            ? operation === "listConversations"
            : operation === "createConversation",
        ),
      ).toEqual([]);

      await client.dispose({ deadlineAt: deadlineAt() });
    },
  );

  it("does not auto-select after a ready subscriber makes an explicit selection", async () => {
    const memory = createMemoryChatGateway();
    const client = createChatClient({ gateway: memory.gateway });
    let deadlineRequest = 0;
    const controller = createConversationWorkspaceController({
      client,
      getDeadlineAt: () => {
        deadlineRequest += 1;
        if (deadlineRequest === 2) throw new Error("selection deadline failed");
        return deadlineAt();
      },
    });
    let explicitSelection:
      ReturnType<typeof controller.selectConversation> | undefined;
    let selectionTriggered = false;
    controller.subscribe((snapshot) => {
      if (
        !selectionTriggered &&
        snapshot.listStatus === "ready" &&
        snapshot.conversations.length > 0
      ) {
        selectionTriggered = true;
        explicitSelection = controller.selectConversation(
          memory.fixtures.conversation.id,
        );
      }
    });

    await controller.refresh();
    expect(explicitSelection).toBeDefined();
    await expect(explicitSelection).resolves.toMatchObject({
      ok: false,
      error: { code: "unknown" },
    });
    expect(client.getSnapshot()).toBeNull();
    expect(controller.getSnapshot()).toMatchObject({
      selectionError: { code: "unknown" },
      selectionStatus: "error",
    });
    expect(controller.getSnapshot().selectedConversationId).toBeUndefined();
    expect(
      memory.controller.calls.filter(
        ({ operation }) => operation === "loadConversation",
      ),
    ).toEqual([]);

    controller.dispose();
    await client.dispose({ deadlineAt: deadlineAt() });
  });

  it("keeps active selection state when a refresh page is empty", async () => {
    const memory = createMemoryChatGateway();
    const client = createChatClient({ gateway: memory.gateway });
    const controller = createConversationWorkspaceController({
      client,
      getDeadlineAt: deadlineAt,
    });
    await controller.start();
    memory.controller.setConversationPage({ conversations: [] });

    await controller.refresh();
    expect(controller.getSnapshot()).toMatchObject({
      conversations: [],
      selectedConversationId: memory.fixtures.conversation.id,
      selectionStatus: "ready",
    });

    controller.dispose();
    await client.dispose({ deadlineAt: deadlineAt() });
  });

  it("publishes structured failures, isolates listeners and becomes silent after dispose", async () => {
    const memory = createMemoryChatGateway();
    const client = createChatClient({ gateway: memory.gateway });
    const onUnhandledError = vi.fn();
    const controller = createConversationWorkspaceController({
      client,
      getDeadlineAt: deadlineAt,
      onUnhandledError,
    });
    const healthyListener = vi.fn();
    controller.subscribe(() => {
      throw new Error("listener failure");
    });
    controller.subscribe(healthyListener);
    memory.controller.failNext("listConversations", {
      code: "network",
      message: "offline",
      retryable: true,
    });

    await controller.start();
    expect(controller.getSnapshot()).toMatchObject({
      listError: { code: "network" },
      listStatus: "error",
    });
    expect(onUnhandledError).toHaveBeenCalled();
    expect(healthyListener).toHaveBeenCalled();
    const callsBeforeDispose = healthyListener.mock.calls.length;

    controller.dispose();
    memory.controller.emitUpdateToAll(memory.fixtures.conversationUpdate);
    expect(healthyListener).toHaveBeenCalledTimes(callsBeforeDispose);
    await expect(controller.refresh()).resolves.toMatchObject({
      ok: false,
      error: { code: "conflict" },
    });
    await client.dispose({ deadlineAt: deadlineAt() });
  });

  it("provides a stable newest-first ordering helper without mutating input", () => {
    const conversations = [
      { id: "undated", title: "Undated" },
      { id: "older", title: "Older", updatedAt: 100 },
      { id: "newest", title: "Newest", updatedAt: 300 },
      { id: "same-time", title: "Same time", updatedAt: 100 },
    ] as const;

    expect(
      orderConversationsByUpdatedAt(conversations).map(({ id }) => id),
    ).toEqual(["newest", "older", "same-time", "undated"]);
    expect(conversations.map(({ id }) => id)).toEqual([
      "undated",
      "older",
      "newest",
      "same-time",
    ]);
  });
});
