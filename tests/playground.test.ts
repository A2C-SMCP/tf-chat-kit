// @vitest-environment jsdom

import { act, createElement, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { PlaygroundApp } from "../playground/src/app.js";
import {
  createMockPlaygroundSession,
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

describe("private Chat Kit playground", () => {
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
      "What changed earlier?",
      "An older page was loaded without polling.",
      "Welcome to the local Chat Kit playground.",
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
              item.content.text.includes("Streaming complete"),
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
        expect(container.textContent).toContain("Chat Kit Playground");
        expect(container.textContent).toContain("Mock scenarios");
        expect(sessions.length).toBeGreaterThanOrEqual(2);
        expect(sessions.at(-1)?.getState().contentState).toEqual({
          kind: "ready",
        });
      });
      for (const discarded of sessions.slice(0, -1)) {
        expect(discarded.dispose).toHaveBeenCalledOnce();
        expect(discarded.client.disposed).toBe(true);
      }

      const active = sessions.at(-1)!;
      const clientListener = vi.fn();
      const clientSubscription = active.client.subscribe(clientListener);
      await act(async () => active.startStreaming());

      const replace = [...container.querySelectorAll("button")].find(
        (button) => button.textContent === "Replace instance",
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
        (button) => button.textContent === "Disconnect",
      );
      expect(disconnect).toBeDefined();
      await act(async () => disconnect!.click());
      await vi.waitFor(() => {
        expect(container.textContent).toContain("Disconnected");
        expect(container.textContent).toContain("Memory Gateway disconnected.");
      });

      const reconnect = [...container.querySelectorAll("button")].find(
        (button) => button.textContent === "Reconnect",
      );
      expect(reconnect).toBeDefined();
      await act(async () => {
        reconnect!.click();
        await Promise.resolve();
      });
      await vi.waitFor(() => {
        expect(container.textContent).toContain("Connected");
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
  });
});
