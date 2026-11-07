// @vitest-environment jsdom
import { beforeAll, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_PLAYGROUND_EVENT_DETAIL_SPLIT_RATIO,
  PLAYGROUND_EVENT_DETAIL_SPLIT_RATIO_STORAGE_KEY,
  readPlaygroundEventDetailSplitRatio,
  writePlaygroundEventDetailSplitRatio,
  type PlaygroundLayoutPreferenceStorage,
} from "../playground/src/playground-layout-preferences.js";
import {
  createMockPlaygroundSession,
  orderConversationsByUpdatedAt,
} from "../playground/src/playground-session.js";

beforeAll(() => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (query: string): MediaQueryList =>
      ({
        addEventListener: () => undefined,
        addListener: () => undefined,
        dispatchEvent: () => false,
        matches: false,
        media: query,
        onchange: null,
        removeEventListener: () => undefined,
        removeListener: () => undefined,
      }) as MediaQueryList,
  });
});

describe("private Chat Kit playground", () => {
  it("reads and writes a bounded host-wide split ratio without trusting damaged storage", () => {
    const values = new Map<string, string>();
    const storage: PlaygroundLayoutPreferenceStorage = {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => {
        values.set(key, value);
      },
    };

    expect(readPlaygroundEventDetailSplitRatio(storage)).toBe(
      DEFAULT_PLAYGROUND_EVENT_DETAIL_SPLIT_RATIO,
    );
    expect(writePlaygroundEventDetailSplitRatio(0.68, storage)).toBe(true);
    expect(values.get(PLAYGROUND_EVENT_DETAIL_SPLIT_RATIO_STORAGE_KEY)).toBe(
      "0.68",
    );
    expect(readPlaygroundEventDetailSplitRatio(storage)).toBe(0.68);

    for (const invalid of ["", "not-a-number", "0.19", "0.81"]) {
      values.set(PLAYGROUND_EVENT_DETAIL_SPLIT_RATIO_STORAGE_KEY, invalid);
      expect(readPlaygroundEventDetailSplitRatio(storage)).toBe(
        DEFAULT_PLAYGROUND_EVENT_DETAIL_SPLIT_RATIO,
      );
    }
    expect(writePlaygroundEventDetailSplitRatio(Number.NaN, storage)).toBe(
      false,
    );

    const unavailableStorage: PlaygroundLayoutPreferenceStorage = {
      getItem: () => {
        throw new DOMException("Storage is unavailable", "SecurityError");
      },
      setItem: () => {
        throw new DOMException("Storage is unavailable", "SecurityError");
      },
    };
    expect(readPlaygroundEventDetailSplitRatio(unavailableStorage)).toBe(
      DEFAULT_PLAYGROUND_EVENT_DETAIL_SPLIT_RATIO,
    );
    expect(writePlaygroundEventDetailSplitRatio(0.68, unavailableStorage)).toBe(
      false,
    );
  });

  it("orders conversation history newest first without mutating gateway data", () => {
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

  it("drives conversation, history, stream, interrupt, error and reconnect scenarios", async () => {
    const session = createMockPlaygroundSession();
    await session.start();
    expect(session.getState()).toMatchObject({
      connected: true,
      contentState: { kind: "ready" },
      conversations: [{ id: "conversation-contract" }],
      selectedConversationId: "conversation-contract",
    });
    const uploaded = await session.attachmentUploader.upload({
      blob: new Blob(["mock image bytes"], { type: "image/png" }),
      deadlineAt: Date.now() + 1_000,
      fileName: "acceptance.png",
      mimeType: "image/png",
    });
    expect(uploaded).toEqual({
      ok: true,
      value: {
        mimeType: "image/png",
        name: "acceptance.png",
        size: 16,
        uri: expect.stringMatching(/^(?:blob:|mock-upload:\/\/attachment\/)/u),
      },
    });
    if (!uploaded.ok) throw new Error("Mock upload unexpectedly failed");
    await expect(
      session.attachmentUploader.upload({
        blob: new Blob(["cancelled"]),
        deadlineAt: Date.now() + 1_000,
        fileName: "cancelled.txt",
        cancellation: { aborted: true, subscribe: () => () => undefined },
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "timeout" } });

    const beforeHistory = session.client.getSnapshot()!.timeline;
    await session.loadHistory();
    const afterHistory = session.client.getSnapshot()!.timeline;
    expect(afterHistory).toHaveLength(beforeHistory.length + 2);
    expect(
      afterHistory.map((item) =>
        item.kind === "message" && item.content.kind === "text"
          ? item.content.text
          : item.id,
      ),
    ).toEqual([
      "之前发生了什么变化？",
      "已在不轮询的情况下加载更早的一页记录。",
      "欢迎使用本地 Chat Kit 调试台。",
      "playground-agent-event",
    ]);
    const canonicalTimelineIds = afterHistory.map(({ id }) => id);

    await session.createConversation("Scenario conversation");
    expect(session.getState().selectedConversationId).toBe(
      "memory-conversation-1",
    );
    expect(
      session
        .getState()
        .conversations.some(
          (conversation) => conversation.title === "Scenario conversation",
        ),
    ).toBe(true);
    await session.selectConversation("conversation-contract");
    expect(session.client.getSnapshot()!.timeline.map(({ id }) => id)).toEqual(
      canonicalTimelineIds,
    );

    vi.useFakeTimers();
    try {
      session.startStreaming();
      expect(session.client.getSnapshot()?.run).toMatchObject({
        status: "running",
        canInterrupt: true,
      });
      await session.interrupt();
      expect(session.client.getSnapshot()?.run).toMatchObject({
        status: "aborted",
        canInterrupt: false,
      });

      session.startStreaming();
      await vi.advanceTimersByTimeAsync(360);
      expect(session.client.getSnapshot()?.run).toMatchObject({
        status: "succeeded",
        canInterrupt: false,
      });
      expect(
        session.client
          .getSnapshot()
          ?.timeline.some(
            (item) =>
              item.kind === "message" &&
              item.content.kind === "text" &&
              item.content.text.includes("流式输出完成"),
          ),
      ).toBe(true);
    } finally {
      vi.useRealTimers();
    }

    session.emitServerError();
    expect(session.client.getSnapshot()?.error).toMatchObject({
      code: "server",
    });
    session.disconnect();
    expect(session.getState()).toMatchObject({
      connected: false,
      contentState: { kind: "disconnected" },
    });
    await session.reconnect();
    expect(session.getState()).toMatchObject({
      connected: true,
      contentState: { kind: "ready" },
    });
    await expect(
      session.client.sendMessage({
        attachments: [uploaded.value],
        conversationId: "conversation-contract",
        deadlineAt: Date.now() + 1_000,
      }),
    ).resolves.toMatchObject({ ok: true });
    expect(session.client.getSnapshot()?.timeline).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          content: {
            kind: "media",
            mediaType: "image",
            resource: uploaded.value,
            summary: "acceptance.png",
          },
          role: "user",
        }),
      ]),
    );

    await session.dispose();
    expect(session.disposed).toBe(true);
    expect(session.client.disposed).toBe(true);
    await expect(
      session.attachmentUploader.upload({
        blob: new Blob(["late"]),
        deadlineAt: Date.now() + 1_000,
        fileName: "late.txt",
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "conflict" } });
  });
});
