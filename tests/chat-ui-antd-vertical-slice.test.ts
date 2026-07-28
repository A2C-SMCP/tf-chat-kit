// @vitest-environment jsdom

import {
  Suspense,
  act,
  createElement,
  startTransition,
  type ReactNode,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

import type { ChatSnapshot } from "../packages/chat-protocol/src/index.js";
import { ChatProvider } from "../packages/chat-react/src/index.js";
import {
  ChatConversationView,
  type ChatRenderer,
  type ChatUiCommandFailure,
} from "../packages/chat-ui-antd/src/index.js";
import {
  createLoadedClient,
  deadlineAt,
  flushMicrotasks,
} from "./support/chat-react.js";

interface DomRender {
  readonly container: HTMLDivElement;
  readonly root: Root;
  unmount(): Promise<void>;
}

const renderInDom = async (node: ReactNode): Promise<DomRender> => {
  const container = document.createElement("div");
  container.style.height = "640px";
  document.body.append(container);
  const root = createRoot(container);
  const previous = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  await act(async () => {
    root.render(node);
    await flushMicrotasks();
  });

  return {
    container,
    root,
    async unmount() {
      await act(async () => {
        root.unmount();
        await flushMicrotasks();
      });
      container.remove();
      if (previous === undefined) {
        Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
      } else {
        Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previous);
      }
    },
  };
};

const clickButton = async (
  container: HTMLElement,
  text: string,
): Promise<void> => {
  const button = [...container.querySelectorAll("button")].find((candidate) =>
    candidate.textContent?.includes(text),
  );
  if (button === undefined) throw new Error(`Button not found: ${text}`);
  await act(async () => {
    button.click();
    await flushMicrotasks();
  });
};

const setComposerText = async (
  container: HTMLElement,
  text: string,
): Promise<void> => {
  const input = container.querySelector<HTMLTextAreaElement>(
    'textarea[aria-label="Message"]',
  );
  if (input === null) throw new Error("Composer input not found");
  await act(async () => {
    const valueSetter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )?.set;
    valueSetter?.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await flushMicrotasks();
  });
};

const moveSnapshotToConversation = (
  snapshot: ChatSnapshot,
  conversationId: string,
): ChatSnapshot => ({
  ...snapshot,
  conversation: {
    ...snapshot.conversation,
    id: conversationId,
    title: "Replacement conversation",
  },
  timeline: snapshot.timeline.map((item) => ({
    ...item,
    conversationId,
  })),
  run:
    snapshot.run === null
      ? null
      : {
          ...snapshot.run,
          conversationId,
          id: "replacement-run",
        },
});

describe("@turingfocus/chat-ui-antd vertical slice", () => {
  it("renders history and realtime updates and routes send/interrupt through ChatClient", async () => {
    const { client, memory } = await createLoadedClient();
    const failures: ChatUiCommandFailure[] = [];
    const rendered = await renderInDom(
      createElement(
        ChatProvider,
        { client },
        createElement(ChatConversationView, {
          getDeadlineAt: deadlineAt,
          onCommandError: (failure) => {
            failures.push(failure);
          },
        }),
      ),
    );

    try {
      expect(rendered.container.textContent).toContain("Initial message");
      expect(rendered.container.textContent).toContain("running");

      await act(async () => {
        memory.controller.emitUpdateToAll(
          memory.fixtures.realtimeMessageUpdate,
        );
        await flushMicrotasks();
      });
      expect(
        client
          .getSnapshot()
          ?.timeline.some(
            (item) =>
              item.kind === "message" &&
              item.content.kind === "text" &&
              item.content.text === "Realtime response",
          ),
      ).toBe(true);
      await act(async () => {
        rendered.root.render(
          createElement(
            ChatProvider,
            { client },
            createElement(ChatConversationView, {
              getDeadlineAt: deadlineAt,
              key: "after-realtime-update",
              onCommandError: (failure) => {
                failures.push(failure);
              },
            }),
          ),
        );
        await flushMicrotasks();
      });
      expect(rendered.container.textContent).toContain("Realtime response");

      await setComposerText(rendered.container, "Hello from UI");
      await clickButton(rendered.container, "Send");
      await clickButton(rendered.container, "Stop");

      expect(
        memory.controller.calls.some(
          (call) =>
            call.operation === "sendText" &&
            call.input.text === "Hello from UI",
        ),
      ).toBe(true);
      expect(
        memory.controller.calls.some(
          (call) =>
            call.operation === "interrupt" &&
            call.input.runId === memory.fixtures.initialSnapshot.run?.id,
        ),
      ).toBe(true);
      expect(failures).toEqual([]);
    } finally {
      await rendered.unmount();
      await client.dispose({ deadlineAt: deadlineAt() });
    }
  });

  it("keeps send and interrupt outcomes isolated when they complete out of order", async () => {
    const { client, memory } = await createLoadedClient();
    const sendHold = memory.controller.holdNext("sendText");
    const interruptHold = memory.controller.holdNext("interrupt");
    const failures: ChatUiCommandFailure[] = [];
    memory.controller.setSendTextResult({
      ok: false,
      error: {
        code: "server",
        conversationId: memory.fixtures.conversation.id,
        message: "Send failed safely",
        retryable: true,
      },
    });
    const rendered = await renderInDom(
      createElement(
        ChatProvider,
        { client },
        createElement(ChatConversationView, {
          getDeadlineAt: deadlineAt,
          onCommandError: (failure) => {
            failures.push(failure);
          },
        }),
      ),
    );

    try {
      await setComposerText(rendered.container, "Held message");
      await clickButton(rendered.container, "Send");
      await clickButton(rendered.container, "Stop");
      await Promise.all([sendHold.started, interruptHold.started]);

      sendHold.release();
      await act(async () => {
        await sendHold.completed;
        await flushMicrotasks();
      });
      expect(rendered.container.textContent).toContain("Send failed safely");
      expect(rendered.container.querySelectorAll(".ant-alert")).toHaveLength(1);
      expect(
        rendered.container.querySelector<HTMLTextAreaElement>(
          'textarea[aria-label="Message"]',
        )?.value,
      ).toBe("Held message");

      interruptHold.release();
      await act(async () => {
        await interruptHold.completed;
        await flushMicrotasks();
      });
      expect(rendered.container.textContent).toContain("Send failed safely");
      expect(failures.map(({ command }) => command)).toEqual(["sendText"]);
    } finally {
      sendHold.release();
      interruptHold.release();
      await rendered.unmount();
      await client.dispose({ deadlineAt: deadlineAt() });
    }
  });

  it("ignores a held send failure after switching A to B and back to A", async () => {
    const { client, memory } = await createLoadedClient();
    const sendHold = memory.controller.holdNext("sendText");
    const failures: ChatUiCommandFailure[] = [];
    memory.controller.setSendTextResult({
      ok: false,
      error: {
        code: "server",
        conversationId: memory.fixtures.conversation.id,
        message: "Stale A send failure",
        retryable: true,
      },
    });
    const rendered = await renderInDom(
      createElement(
        ChatProvider,
        { client },
        createElement(ChatConversationView, {
          getDeadlineAt: deadlineAt,
          onCommandError: (failure) => {
            failures.push(failure);
          },
        }),
      ),
    );

    try {
      await setComposerText(rendered.container, "Old conversation draft");
      await clickButton(rendered.container, "Send");
      await sendHold.started;

      const replacement = moveSnapshotToConversation(
        memory.fixtures.initialSnapshot,
        "replacement-conversation",
      );
      memory.controller.setSnapshot(replacement);
      await act(async () => {
        const loaded = await client.loadConversation({
          conversationId: replacement.conversation.id,
          deadlineAt: deadlineAt(),
        });
        expect(loaded.ok).toBe(true);
        await flushMicrotasks();
      });
      expect(
        rendered.container.querySelector<HTMLTextAreaElement>(
          'textarea[aria-label="Message"]',
        )?.value,
      ).toBe("");

      memory.controller.setSnapshot(memory.fixtures.initialSnapshot);
      await act(async () => {
        const loaded = await client.loadConversation({
          conversationId: memory.fixtures.conversation.id,
          deadlineAt: deadlineAt(),
        });
        expect(loaded.ok).toBe(true);
        await flushMicrotasks();
      });

      sendHold.release();
      await act(async () => {
        await sendHold.completed;
        await flushMicrotasks();
      });
      expect(failures).toEqual([]);
      expect(rendered.container.textContent).not.toContain(
        "Stale A send failure",
      );
    } finally {
      sendHold.release();
      await rendered.unmount();
      await client.dispose({ deadlineAt: deadlineAt() });
    }
  });

  it("isolates drafts, pending commands, and scroll state when ChatClient changes", async () => {
    const first = await createLoadedClient();
    const second = await createLoadedClient();
    const sendHold = first.memory.controller.holdNext("sendText");
    const failures: ChatUiCommandFailure[] = [];
    first.memory.controller.setSendTextResult({
      ok: false,
      error: {
        code: "server",
        conversationId: first.memory.fixtures.conversation.id,
        message: "Failure from the replaced client",
        retryable: true,
      },
    });
    expect(first.memory.fixtures.conversation.id).toBe(
      second.memory.fixtures.conversation.id,
    );
    const renderClient = (client: typeof first.client): ReactNode =>
      createElement(
        ChatProvider,
        { client },
        createElement(ChatConversationView, {
          getDeadlineAt: deadlineAt,
          onCommandError: (failure) => {
            failures.push(failure);
          },
        }),
      );
    const rendered = await renderInDom(renderClient(first.client));

    try {
      const scroller = rendered.container.querySelector<HTMLElement>(
        "[data-virtuoso-scroller]",
      );
      if (scroller === null) throw new Error("Timeline scroller not found");
      Object.defineProperties(scroller, {
        clientHeight: { configurable: true, value: 200 },
        scrollHeight: { configurable: true, value: 1_000 },
        scrollTop: { configurable: true, value: 100, writable: true },
      });
      await act(async () => {
        scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
        await flushMicrotasks();
      });

      await setComposerText(rendered.container, "Draft from the first client");
      await clickButton(rendered.container, "Send");
      await sendHold.started;

      await act(async () => {
        rendered.root.render(renderClient(second.client));
        await flushMicrotasks();
      });
      expect(
        rendered.container.querySelector<HTMLTextAreaElement>(
          'textarea[aria-label="Message"]',
        )?.value,
      ).toBe("");
      const replacementScroller = rendered.container.querySelector<HTMLElement>(
        "[data-virtuoso-scroller]",
      );
      expect(replacementScroller).not.toBe(scroller);
      expect(replacementScroller?.scrollTop).not.toBe(100);

      sendHold.release();
      await act(async () => {
        await sendHold.completed;
        await flushMicrotasks();
      });
      expect(failures).toEqual([]);
      expect(rendered.container.textContent).not.toContain(
        "Failure from the replaced client",
      );

      await setComposerText(rendered.container, "Draft for the second client");
      await clickButton(rendered.container, "Send");
      expect(
        second.memory.controller.calls.some(
          (call) =>
            call.operation === "sendText" &&
            call.input.text === "Draft for the second client",
        ),
      ).toBe(true);
      expect(
        second.memory.controller.calls.some(
          (call) =>
            call.operation === "sendText" &&
            call.input.text === "Draft from the first client",
        ),
      ).toBe(false);
    } finally {
      sendHold.release();
      await rendered.unmount();
      await first.client.dispose({ deadlineAt: deadlineAt() });
      await second.client.dispose({ deadlineAt: deadlineAt() });
    }
  });

  it("does not publish a speculative client scope before a suspended transition commits", async () => {
    const first = await createLoadedClient();
    const second = await createLoadedClient();
    const sendHold = first.memory.controller.holdNext("sendText");
    const failures: ChatUiCommandFailure[] = [];
    let transitionResolved = false;
    let resolveTransition!: () => void;
    const transitionReady = new Promise<void>((resolve) => {
      resolveTransition = resolve;
    });
    first.memory.controller.setSendTextResult({
      ok: false,
      error: {
        code: "server",
        conversationId: first.memory.fixtures.conversation.id,
        message: "Failure from the concurrently replaced client",
        retryable: true,
      },
    });

    const TransitionGate = ({
      client,
    }: {
      readonly client: typeof first.client;
    }) => {
      if (client === second.client && !transitionResolved) {
        throw transitionReady;
      }
      return null;
    };
    const renderClient = (client: typeof first.client): ReactNode =>
      createElement(
        ChatProvider,
        { client },
        createElement(
          Suspense,
          { fallback: createElement("div", null, "Transition pending") },
          createElement(ChatConversationView, {
            getDeadlineAt: deadlineAt,
            onCommandError: (failure) => {
              failures.push(failure);
            },
          }),
          createElement(TransitionGate, { client }),
        ),
      );
    const rendered = await renderInDom(renderClient(first.client));

    try {
      await act(async () => {
        startTransition(() => {
          rendered.root.render(renderClient(second.client));
        });
        await flushMicrotasks();
      });
      expect(rendered.container.textContent).not.toContain(
        "Transition pending",
      );

      await setComposerText(rendered.container, "Send during transition");
      await clickButton(rendered.container, "Send");
      await sendHold.started;

      await act(async () => {
        transitionResolved = true;
        resolveTransition();
        await transitionReady;
        await flushMicrotasks();
      });
      expect(
        rendered.container.querySelector<HTMLTextAreaElement>(
          'textarea[aria-label="Message"]',
        )?.value,
      ).toBe("");

      sendHold.release();
      await act(async () => {
        await sendHold.completed;
        await flushMicrotasks();
      });
      expect(failures).toEqual([]);
      expect(rendered.container.textContent).not.toContain(
        "Failure from the concurrently replaced client",
      );
      expect(
        second.memory.controller.calls.some(
          (call) =>
            call.operation === "sendText" &&
            call.input.text === "Send during transition",
        ),
      ).toBe(false);
    } finally {
      sendHold.release();
      transitionResolved = true;
      resolveTransition();
      await rendered.unmount();
      await first.client.dispose({ deadlineAt: deadlineAt() });
      await second.client.dispose({ deadlineAt: deadlineAt() });
    }
  });

  it("ignores a held interrupt failure after the active Run is replaced", async () => {
    const { client, memory } = await createLoadedClient();
    const interruptHold = memory.controller.holdNext("interrupt");
    const failures: ChatUiCommandFailure[] = [];
    memory.controller.setInterruptResult({
      ok: false,
      error: {
        code: "conflict",
        conversationId: memory.fixtures.conversation.id,
        message: "Old Run could not be stopped",
        retryable: false,
      },
    });
    const rendered = await renderInDom(
      createElement(
        ChatProvider,
        { client },
        createElement(ChatConversationView, {
          getDeadlineAt: deadlineAt,
          onCommandError: (failure) => {
            failures.push(failure);
          },
        }),
      ),
    );

    try {
      await clickButton(rendered.container, "Stop");
      await interruptHold.started;
      const initialRun = memory.fixtures.initialSnapshot.run;
      if (initialRun === null) throw new Error("Initial Run is required");
      await act(async () => {
        memory.controller.emitUpdateToAll({
          kind: "run.replace",
          conversationId: memory.fixtures.conversation.id,
          run: { ...initialRun, startedAt: (initialRun.startedAt ?? 0) + 1 },
        });
        await flushMicrotasks();
      });

      interruptHold.release();
      await act(async () => {
        await interruptHold.completed;
        await flushMicrotasks();
      });
      expect(failures).toEqual([]);
      expect(rendered.container.textContent).not.toContain(
        "Old Run could not be stopped",
      );
      expect(rendered.container.textContent).toContain("Stop");
    } finally {
      interruptHold.release();
      await rendered.unmount();
      await client.dispose({ deadlineAt: deadlineAt() });
    }
  });

  it("hides an interrupt failure when a replacement Run becomes active", async () => {
    const { client, memory } = await createLoadedClient();
    memory.controller.setInterruptResult({
      ok: false,
      error: {
        code: "conflict",
        conversationId: memory.fixtures.conversation.id,
        message: "Run-specific interrupt failure",
        retryable: false,
      },
    });
    const rendered = await renderInDom(
      createElement(
        ChatProvider,
        { client },
        createElement(ChatConversationView, { getDeadlineAt: deadlineAt }),
      ),
    );

    try {
      await clickButton(rendered.container, "Stop");
      expect(rendered.container.textContent).toContain(
        "Run-specific interrupt failure",
      );
      expect(rendered.container.querySelectorAll(".ant-alert")).toHaveLength(1);

      const initialRun = memory.fixtures.initialSnapshot.run;
      if (initialRun === null) throw new Error("Initial Run is required");
      await act(async () => {
        memory.controller.emitUpdateToAll({
          kind: "run.replace",
          conversationId: memory.fixtures.conversation.id,
          run: { ...initialRun, id: "new-active-run" },
        });
        await flushMicrotasks();
      });
      expect(rendered.container.textContent).not.toContain(
        "Run-specific interrupt failure",
      );
    } finally {
      await rendered.unmount();
      await client.dispose({ deadlineAt: deadlineAt() });
    }
  });

  it("does not re-render timeline items for unrelated conversation metadata updates", async () => {
    const { client, memory } = await createLoadedClient();
    const renderMessage = vi.fn();
    const CountingRenderer: ChatRenderer = ({ item }) => {
      renderMessage(item.id);
      return createElement("span", null, item.id);
    };
    const renderers = { "message:text": CountingRenderer } as const;
    const rendered = await renderInDom(
      createElement(
        ChatProvider,
        { client },
        createElement(ChatConversationView, {
          getDeadlineAt: deadlineAt,
          renderers,
        }),
      ),
    );

    try {
      const initialRenderCount = renderMessage.mock.calls.length;
      expect(initialRenderCount).toBeGreaterThan(0);
      await act(async () => {
        memory.controller.emitUpdateToAll({
          kind: "conversation.upsert",
          conversation: {
            ...memory.fixtures.conversation,
            title: "Metadata-only title update",
          },
        });
        await flushMicrotasks();
      });
      expect(renderMessage).toHaveBeenCalledTimes(initialRenderCount);
    } finally {
      await rendered.unmount();
      await client.dispose({ deadlineAt: deadlineAt() });
    }
  });

  it("keeps the composer visible while a run is active and explains unavailable capabilities", async () => {
    const { client, memory } = await createLoadedClient();
    memory.controller.emitUpdateToAll({
      kind: "capabilities.replace",
      conversationId: memory.fixtures.conversation.id,
      capabilities: {
        ...memory.fixtures.initialSnapshot.capabilities,
        interrupt: false,
        sendText: false,
      },
    });
    const rendered = await renderInDom(
      createElement(
        ChatProvider,
        { client },
        createElement(ChatConversationView, { getDeadlineAt: deadlineAt }),
      ),
    );

    try {
      const input = rendered.container.querySelector<HTMLTextAreaElement>(
        'textarea[aria-label="Message"]',
      );
      expect(input?.disabled).toBe(true);
      expect(rendered.container.textContent).toContain(
        "Text sending is unavailable.",
      );
      expect(rendered.container.textContent).toContain("Stop unavailable");
    } finally {
      await rendered.unmount();
      await client.dispose({ deadlineAt: deadlineAt() });
    }
  });
});
