import { describe, expect, it, vi } from "vitest";

import {
  createTFRobotAttachmentUploader,
  type TFRobotSession,
} from "../packages/chat-gateway-tfrobot/src/index.js";
import { buildTFRobotOutboundMessage } from "../packages/chat-gateway-tfrobot/src/outbound-message.js";
import {
  sendMessageInputSchema,
  type ChatGateway,
  type GatewayResult,
  type SendMessageSuccess,
  type SessionProvider,
} from "../packages/chat-protocol/src/index.js";
import {
  createChatClient,
  rebaseComposerLongTexts,
  resolveComposerDraftText,
} from "../packages/chat-runtime/src/index.js";
import {
  createChatContractFixtures,
  createMemoryChatGateway,
} from "../packages/chat-testing/src/index.js";

const deadlineAt = (): number => Date.now() + 60_000;
const creator = { uid: "user-1", name: "User" };

describe("attachment message protocol and runtime", () => {
  it("validates uploaded resources and rejects an empty turn", () => {
    expect(
      sendMessageInputSchema.parse({
        attachments: [
          { mimeType: "image/png", name: "image.png", uri: "s3://image" },
        ],
        conversationId: "conversation-contract",
        deadlineAt: deadlineAt(),
      }),
    ).toMatchObject({ attachments: [{ uri: "s3://image" }] });
    expect(() =>
      sendMessageInputSchema.parse({
        conversationId: "conversation-contract",
        deadlineAt: deadlineAt(),
      }),
    ).toThrow();
  });

  it("keeps drafts isolated, expands long text, and coalesces duplicate sends", async () => {
    const memory = createMemoryChatGateway();
    const client = createChatClient({ gateway: memory.gateway });
    await client.loadConversation({
      conversationId: memory.fixtures.conversation.id,
      deadlineAt: deadlineAt(),
    });
    client.setComposerDraft({
      conversationId: memory.fixtures.conversation.id,
      text: "Before [Pasted text 1] after",
      longTexts: [
        {
          id: "long-1",
          label: "[Pasted text 1]",
          content: "complete text",
          start: 7,
          end: 22,
        },
      ],
      attachments: [
        { uri: "s3://file", mimeType: "application/pdf", name: "file.pdf" },
      ],
    });
    client.setComposerDraft({ conversationId: "other", text: "other draft" });
    expect(client.getComposerDraft("other").text).toBe("other draft");

    const hold = memory.controller.holdNext("sendMessage");
    const first = client.sendComposerDraft({
      clientMessageId: "message-1",
      conversationId: memory.fixtures.conversation.id,
      deadlineAt: deadlineAt(),
    });
    await hold.started;
    const second = client.sendComposerDraft({
      clientMessageId: "message-1",
      conversationId: memory.fixtures.conversation.id,
      deadlineAt: deadlineAt(),
    });
    hold.release();
    await expect(Promise.all([first, second])).resolves.toEqual([
      memory.fixtures.sendTextSuccess && {
        ok: true,
        value: memory.fixtures.sendTextSuccess,
      },
      memory.fixtures.sendTextSuccess && {
        ok: true,
        value: memory.fixtures.sendTextSuccess,
      },
    ]);
    const calls = memory.controller.calls.filter(
      (call) => call.operation === "sendMessage",
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      input: { text: "Before complete text after" },
    });
    expect(client.getComposerDraft(memory.fixtures.conversation.id).text).toBe(
      "",
    );
    await client.dispose({ deadlineAt: deadlineAt() });
  });

  it("resolves anchored long text without replacing literals or nested labels", () => {
    const firstLabel = "[Pasted text 1]";
    const secondLabel = "[Pasted text 2]";
    const text = `literal ${firstLabel}|${firstLabel}|${secondLabel}`;
    const firstStart = text.indexOf(firstLabel, firstLabel.length);
    const secondStart = text.lastIndexOf(secondLabel);
    expect(
      resolveComposerDraftText({
        attachments: [],
        conversationId: "anchored",
        revision: 1,
        text,
        longTexts: [
          {
            content: `nested ${secondLabel}`,
            end: firstStart + firstLabel.length,
            id: "first",
            label: firstLabel,
            start: firstStart,
          },
          {
            content: "second content",
            end: secondStart + secondLabel.length,
            id: "second",
            label: secondLabel,
            start: secondStart,
          },
        ],
      }),
    ).toBe(`literal ${firstLabel}|nested ${secondLabel}|second content`);
  });

  it("preserves an anchor when an ambiguous matching character is inserted beside it", () => {
    const label = "[Pasted text 1]";
    const nextText = `[${label}`;
    const longTexts = rebaseComposerLongTexts(
      label,
      nextText,
      [
        {
          content: "complete",
          end: label.length,
          id: "anchored",
          label,
          start: 0,
        },
      ],
      { nextEnd: 1, previousEnd: 0, previousStart: 0 },
    );
    expect(longTexts).toMatchObject([
      { id: "anchored", start: 1, end: label.length + 1 },
    ]);
    expect(
      resolveComposerDraftText({
        attachments: [],
        conversationId: "ambiguous-edit",
        longTexts,
        revision: 1,
        text: nextText,
      }),
    ).toBe("[complete");
  });

  it("retains edits made during a slow send, including a duplicate command id", async () => {
    const memory = createMemoryChatGateway();
    const conversationId = memory.fixtures.conversation.id;
    const client = createChatClient({ gateway: memory.gateway });
    await client.loadConversation({ conversationId, deadlineAt: deadlineAt() });
    client.setComposerDraft({ conversationId, text: "original" });
    const hold = memory.controller.holdNext("sendText");
    const first = client.sendComposerDraft({
      clientMessageId: "stable-message",
      conversationId,
      deadlineAt: deadlineAt(),
    });
    await hold.started;
    client.setComposerDraft({ conversationId, text: "new unsent edit" });
    const duplicate = client.sendComposerDraft({
      clientMessageId: "stable-message",
      conversationId,
      deadlineAt: deadlineAt(),
    });
    hold.release();
    await expect(Promise.all([first, duplicate])).resolves.toMatchObject([
      { ok: true },
      { ok: true },
    ]);
    expect(client.getComposerDraft(conversationId).text).toBe(
      "new unsent edit",
    );
    expect(
      memory.controller.calls.filter((call) => call.operation === "sendText"),
    ).toHaveLength(1);
    await client.dispose({ deadlineAt: deadlineAt() });
  });

  it("scopes duplicate ids by conversation and settles success after a view switch", async () => {
    const memory = createMemoryChatGateway();
    const firstId = memory.fixtures.conversation.id;
    const secondFixtures = createChatContractFixtures({
      conversationId: "conversation-second",
    });
    memory.controller.setSnapshot(secondFixtures.initialSnapshot);
    const client = createChatClient({ gateway: memory.gateway });
    await client.loadConversation({
      conversationId: firstId,
      deadlineAt: deadlineAt(),
    });
    client.setComposerDraft({ conversationId: firstId, text: "first" });
    const hold = memory.controller.holdNext("sendText");
    const first = client.sendComposerDraft({
      clientMessageId: "shared-id",
      conversationId: firstId,
      deadlineAt: deadlineAt(),
    });
    await hold.started;
    await client.loadConversation({
      conversationId: secondFixtures.conversation.id,
      deadlineAt: deadlineAt(),
    });
    client.setComposerDraft({
      conversationId: secondFixtures.conversation.id,
      text: "second",
    });
    const second = client.sendComposerDraft({
      clientMessageId: "shared-id",
      conversationId: secondFixtures.conversation.id,
      deadlineAt: deadlineAt(),
    });
    hold.release();
    await expect(Promise.all([first, second])).resolves.toMatchObject([
      { ok: true },
      { ok: true },
    ]);
    expect(
      memory.controller.calls.filter((call) => call.operation === "sendText"),
    ).toHaveLength(2);
    await client.dispose({ deadlineAt: deadlineAt() });
  });

  it("does not rewrite an accepted send as a conflict when disposal races", async () => {
    const memory = createMemoryChatGateway();
    let resolveSend:
      ((result: GatewayResult<SendMessageSuccess>) => void) | undefined;
    const accepted = new Promise<GatewayResult<SendMessageSuccess>>(
      (resolve) => {
        resolveSend = resolve;
      },
    );
    const gateway: ChatGateway = {
      dispose: () => undefined,
      interrupt: (input) => memory.gateway.interrupt(input),
      listConversations: (input) => memory.gateway.listConversations(input),
      loadConversation: (input) => memory.gateway.loadConversation(input),
      sendMessage: () => accepted,
      sendText: (input) => memory.gateway.sendText(input),
      subscribe: (input, observer) => memory.gateway.subscribe(input, observer),
    };
    const client = createChatClient({ gateway });
    const conversationId = memory.fixtures.conversation.id;
    await client.loadConversation({ conversationId, deadlineAt: deadlineAt() });
    const sending = client.sendMessage({
      attachments: [{ mimeType: "text/plain", uri: "s3://accepted" }],
      conversationId,
      deadlineAt: deadlineAt(),
    });
    await client.dispose({ deadlineAt: deadlineAt() });
    resolveSend?.({ ok: true, value: memory.fixtures.sendTextSuccess });
    await expect(sending).resolves.toEqual({
      ok: true,
      value: memory.fixtures.sendTextSuccess,
    });
  });

  it("retires an old send owner when the same conversation id is deleted and rebuilt", async () => {
    const memory = createMemoryChatGateway();
    const sendResolvers: Array<
      (result: GatewayResult<SendMessageSuccess>) => void
    > = [];
    const gateway: ChatGateway = {
      deleteConversation: async (input) => ({
        ok: true,
        value: { deletedConversationId: input.conversationId },
      }),
      dispose: () => undefined,
      interrupt: (input) => memory.gateway.interrupt(input),
      listConversations: (input) => memory.gateway.listConversations(input),
      loadConversation: (input) => memory.gateway.loadConversation(input),
      sendText: () =>
        new Promise((resolve) => {
          sendResolvers.push(resolve);
        }),
      subscribe: (input, observer) => memory.gateway.subscribe(input, observer),
    };
    const client = createChatClient({ gateway });
    const conversationId = memory.fixtures.conversation.id;
    await client.loadConversation({ conversationId, deadlineAt: deadlineAt() });
    client.setComposerDraft({ conversationId, text: "old incarnation" });
    const oldSend = client.sendComposerDraft({
      clientMessageId: "reused-id",
      conversationId,
      deadlineAt: deadlineAt(),
    });
    expect(sendResolvers).toHaveLength(1);
    await client.deleteConversation({
      conversationId,
      deadlineAt: deadlineAt(),
    });
    await client.loadConversation({ conversationId, deadlineAt: deadlineAt() });
    const rebuiltDraft = client.setComposerDraft({
      conversationId,
      text: "new incarnation",
    });
    const rebuiltSend = client.sendComposerDraft({
      clientMessageId: "reused-id",
      conversationId,
      deadlineAt: deadlineAt(),
    });
    expect(sendResolvers).toHaveLength(2);

    sendResolvers[0]!({ ok: true, value: memory.fixtures.sendTextSuccess });
    await expect(oldSend).resolves.toMatchObject({ ok: true });
    expect(client.getComposerDraft(conversationId)).toBe(rebuiltDraft);
    sendResolvers[1]!({ ok: true, value: memory.fixtures.sendTextSuccess });
    await expect(rebuiltSend).resolves.toMatchObject({ ok: true });
    expect(client.getComposerDraft(conversationId).text).toBe("");
    await client.dispose({ deadlineAt: deadlineAt() });
  });
});

describe("TFRobot attachment adapter", () => {
  it("maps mixed resources into one current-server history turn", () => {
    expect(
      buildTFRobotOutboundMessage(
        {
          conversationId: "42",
          deadlineAt: deadlineAt(),
          text: "Inspect",
          attachments: [
            { uri: "s3://image", mimeType: "image/png", name: "image.png" },
            {
              uri: "s3://sheet",
              mimeType: "application/vnd.ms-excel",
              name: "sheet.xls",
            },
          ],
        },
        creator,
        42,
      ),
    ).toMatchObject({
      msgType: "history",
      content: [
        {
          msgType: "multipart",
          content: [{ partType: "text" }, { partType: "image_url" }],
        },
        { msgType: "file", content: "s3://sheet" },
      ],
    });
  });

  it("uploads through the existing server endpoint with no upload-specific config", async () => {
    const fetch = vi.fn(
      async (_input: URL | RequestInfo, init?: RequestInit) => {
        expect(String(_input)).toBe(
          "https://robot.example/v1/dashboard/remote/source/cos/upload",
        );
        expect(init?.body).toBeInstanceOf(FormData);
        expect((init?.headers as Headers).get("Authorization")).toBe(
          "Bearer session-token",
        );
        return new Response(
          JSON.stringify({
            code: 200,
            message: "Success",
            data: { uri: "s3://uploaded" },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      },
    );
    const sessionProvider: SessionProvider<TFRobotSession> = {
      getSession: () => ({ kind: "bearer", token: "session-token" }),
    };
    const uploader = createTFRobotAttachmentUploader({
      baseUrl: "https://robot.example/",
      fetch: fetch as typeof globalThis.fetch,
      messageCreatorProvider: () => creator,
      sessionProvider,
    });
    const file = new Blob(["payload"], { type: "text/plain" });
    await expect(
      uploader.upload({
        deadlineAt: deadlineAt(),
        blob: file,
        fileName: "notes.txt",
      }),
    ).resolves.toEqual({
      ok: true,
      value: {
        uri: "s3://uploaded",
        mimeType: "text/plain",
        name: "notes.txt",
        size: 7,
      },
    });
    await expect(
      uploader.upload({
        deadlineAt: deadlineAt(),
        blob: new Uint8Array([1, 2, 3]),
        fileName: "not-a-browser-blob.bin",
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "validation" },
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    uploader.dispose();
  });
});
