// @vitest-environment jsdom

import { act, createElement, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { PlaygroundApp } from "../playground/src/app.js";
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
  type MockPlaygroundSession,
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

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
};

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

    await session.dispose();
    expect(session.disposed).toBe(true);
    expect(session.client.disposed).toBe(true);
  });

  it("renders the real page and disposes replaced and unmounted instances", async () => {
    const sessions: MockPlaygroundSession[] = [];
    const createSession = () => {
      const session = createMockPlaygroundSession();
      vi.spyOn(session, "dispose");
      sessions.push(session);
      return session;
    };
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    let mounted = true;
    const previous = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

    try {
      await act(async () => {
        root.render(
          createElement(
            StrictMode,
            null,
            createElement(PlaygroundApp, { createSession }),
          ),
        );
        await Promise.resolve();
      });
      await vi.waitFor(() => {
        expect(container.textContent).toContain("Chat Kit 调试台");
        expect(container.textContent).toContain("Mock 场景");
        expect(sessions.length).toBeGreaterThanOrEqual(2);
        expect(sessions.at(-1)?.getState().contentState).toEqual({
          kind: "ready",
        });
      });
      for (const discarded of sessions.slice(0, -1)) {
        expect(discarded.dispose).toHaveBeenCalledOnce();
        expect(discarded.client.disposed).toBe(true);
      }

      expect(container.textContent).toContain("事件详情模式");
      const splitMode = [
        ...container.querySelectorAll<HTMLElement>(".ant-segmented-item"),
      ].find((item) => item.textContent === "双栏");
      expect(splitMode).toBeDefined();
      await act(async () => {
        splitMode!.click();
        await Promise.resolve();
      });
      const eventTrigger = container.querySelector<HTMLElement>(
        '[data-chat-event-trigger="playground-agent-event"]',
      );
      expect(eventTrigger).not.toBeNull();
      await act(async () => {
        eventTrigger!.click();
        await Promise.resolve();
      });
      expect(
        container.querySelector('aside[aria-label="事件详情"]')?.textContent,
      ).toContain("执行计划已生成。");
      const modalMode = [
        ...container.querySelectorAll<HTMLElement>(".ant-segmented-item"),
      ].find((item) => item.textContent === "弹窗");
      await act(async () => {
        modalMode!.click();
        await Promise.resolve();
      });
      await vi.waitFor(() => {
        expect(
          document.body.querySelector('[role="dialog"]')?.textContent,
        ).toContain("执行计划已生成。");
      });
      const closeEventDetail =
        document.body.querySelector<HTMLButtonElement>(".ant-modal-close");
      await act(async () => {
        closeEventDetail!.click();
        await Promise.resolve();
      });

      const conversationList = container.querySelector<HTMLElement>(
        'aside[aria-label="会话列表"]',
      );
      expect(conversationList).toBeNull();
      const newConversation = container.querySelector<HTMLButtonElement>(
        'button[aria-label="新建会话"]',
      );
      const conversationHistory = container.querySelector<HTMLButtonElement>(
        'button[aria-label="历史会话"]',
      );
      expect(newConversation).not.toBeNull();
      expect(conversationHistory).not.toBeNull();
      await act(async () => {
        newConversation!.click();
        await Promise.resolve();
      });
      await vi.waitFor(() => {
        expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();
        expect(document.body.textContent).toContain("确认新建");
      });
      const closeCreate =
        document.body.querySelector<HTMLButtonElement>(".ant-modal-close");
      expect(closeCreate).not.toBeNull();
      await act(async () => {
        closeCreate!.click();
        conversationHistory!.click();
        await Promise.resolve();
      });
      await vi.waitFor(() => {
        expect(conversationHistory?.getAttribute("aria-expanded")).toBe("true");
        expect(document.body.textContent).toContain("示例会话");
        expect(conversationList).toBeNull();
      });

      const active = sessions.at(-1)!;
      const clientListener = vi.fn();
      const clientSubscription = active.client.subscribe(clientListener);
      await act(async () => active.startStreaming());

      const replace = [...container.querySelectorAll("button")].find(
        (button) => button.textContent === "重建实例",
      );
      expect(replace).toBeDefined();
      const countBeforeReplacement = sessions.length;
      await act(async () => {
        replace!.click();
        await Promise.resolve();
      });
      await vi.waitFor(() => {
        expect(sessions.length).toBeGreaterThan(countBeforeReplacement);
        expect(active.disposed).toBe(true);
        expect(active.client.disposed).toBe(true);
        expect(active.dispose).toHaveBeenCalledOnce();
      });
      const callsAfterDisposal = clientListener.mock.calls.length;
      await new Promise((resolve) => setTimeout(resolve, 450));
      expect(clientListener).toHaveBeenCalledTimes(callsAfterDisposal);
      clientSubscription.dispose();

      const disconnect = [...container.querySelectorAll("button")].find(
        (button) => button.textContent === "断开连接",
      );
      expect(disconnect).toBeDefined();
      await act(async () => disconnect!.click());
      await vi.waitFor(() => {
        expect(container.textContent).toContain("已断开");
        expect(container.textContent).toContain("内存网关已断开。");
      });

      const reconnect = [...container.querySelectorAll("button")].find(
        (button) => button.textContent === "重新连接",
      );
      expect(reconnect).toBeDefined();
      await act(async () => {
        reconnect!.click();
        await Promise.resolve();
      });
      await vi.waitFor(() => {
        expect(container.textContent).toContain("已连接");
        expect(sessions.at(-1)?.getState().contentState).toEqual({
          kind: "ready",
        });
      });

      await act(async () => {
        root.unmount();
        await Promise.resolve();
      });
      mounted = false;
      await vi.waitFor(() => {
        const current = sessions.at(-1)!;
        expect(current.disposed).toBe(true);
        expect(current.client.disposed).toBe(true);
        expect(current.dispose).toHaveBeenCalledOnce();
      });
    } finally {
      if (mounted) {
        await act(async () => root.unmount());
      }
      container.remove();
      if (previous === undefined) {
        Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
      } else {
        Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previous);
      }
    }
  }, 10_000);

  it("deduplicates creation and ignores stale completion after replacing a session", async () => {
    const pendingCreation = deferred<boolean>();
    const sessions: MockPlaygroundSession[] = [];
    const createSession = () => {
      const session = createMockPlaygroundSession();
      vi.spyOn(session, "dispose");
      vi.spyOn(session, "createConversation").mockImplementation(
        sessions.length === 0
          ? () => pendingCreation.promise
          : async () => false,
      );
      sessions.push(session);
      return session;
    };
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    let mounted = true;
    const previous = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

    try {
      await act(async () => {
        root.render(createElement(PlaygroundApp, { createSession }));
        await Promise.resolve();
      });
      await vi.waitFor(() => expect(sessions).toHaveLength(1));

      await act(async () => {
        container
          .querySelector<HTMLButtonElement>('button[aria-label="新建会话"]')!
          .click();
        await Promise.resolve();
      });
      const confirmCreate = [...document.body.querySelectorAll("button")].find(
        (button) => button.textContent === "确认新建",
      );
      expect(confirmCreate).toBeDefined();
      await act(async () => {
        confirmCreate!.click();
        confirmCreate!.click();
        await Promise.resolve();
      });
      expect(sessions[0]!.createConversation).toHaveBeenCalledOnce();

      const replace = [...container.querySelectorAll("button")].find(
        (button) => button.textContent === "重建实例",
      );
      await act(async () => {
        replace!.click();
        await Promise.resolve();
      });
      await vi.waitFor(() => {
        expect(sessions).toHaveLength(2);
        expect(sessions[0]!.dispose).toHaveBeenCalledOnce();
      });

      await act(async () => {
        container
          .querySelector<HTMLButtonElement>('button[aria-label="新建会话"]')!
          .click();
        await Promise.resolve();
      });
      await vi.waitFor(() =>
        expect(document.body.querySelector('[role="dialog"]')).not.toBeNull(),
      );
      await act(async () => {
        pendingCreation.resolve(true);
        await pendingCreation.promise;
      });
      expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();

      const currentConfirm = [...document.body.querySelectorAll("button")].find(
        (button) => button.textContent === "确认新建",
      );
      await act(async () => {
        currentConfirm!.click();
        await Promise.resolve();
      });
      expect(sessions[1]!.createConversation).toHaveBeenCalledOnce();
      expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();

      await act(async () => {
        root.unmount();
        await Promise.resolve();
      });
      mounted = false;
    } finally {
      if (mounted) {
        await act(async () => root.unmount());
      }
      container.remove();
      if (previous === undefined) {
        Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
      } else {
        Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previous);
      }
    }
  });
});
