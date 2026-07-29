// @vitest-environment jsdom

import {
  Suspense,
  act,
  createElement,
  startTransition,
  type ReactNode,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeAll, describe, expect, it, vi } from "vitest";

import type { ChatSnapshot } from "../packages/chat-protocol/src/index.js";
import { ChatProvider } from "../packages/chat-react/src/index.js";
import {
  ChatConversationView,
  type AskUserChatAboutThisRequest,
  type ChatRenderer,
  type ChatUiCommandFailure,
} from "../packages/chat-ui-antd/src/index.js";
import {
  createLoadedClient,
  deadlineAt,
  flushMicrotasks,
} from "./support/chat-react.js";

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
  it("renders and submits a conversation-scoped Ask User request", async () => {
    const { client, memory } = await createLoadedClient();
    const pendingInteraction = {
      ...memory.fixtures.askUserRequest,
      questions: [
        {
          ...memory.fixtures.askUserRequest.questions[0]!,
          multiple: true,
          defaultValue: ["first, canary"],
          options: [
            { label: "First", value: "first, canary" },
            { label: "Second", value: "second" },
          ],
        },
      ],
    };
    const pendingSnapshot = {
      ...memory.fixtures.initialSnapshot,
      capabilities: {
        ...memory.fixtures.initialSnapshot.capabilities,
        answerInteraction: true,
      },
      pendingInteraction,
    };
    memory.controller.setSnapshot(pendingSnapshot);
    memory.controller.emitUpdateToAll({
      kind: "capabilities.replace",
      conversationId: memory.fixtures.conversation.id,
      capabilities: pendingSnapshot.capabilities,
    });
    memory.controller.emitUpdateToAll({
      kind: "interaction.replace",
      conversationId: memory.fixtures.conversation.id,
      interaction: pendingInteraction,
    });
    const rendered = await renderInDom(
      createElement(
        ChatProvider,
        { client },
        createElement(ChatConversationView, {
          getDeadlineAt: deadlineAt,
        }),
      ),
    );

    try {
      expect(rendered.container.textContent).toContain("Need your input");
      const option = rendered.container.querySelector<HTMLInputElement>(
        'input[value="first, canary"]',
      );
      if (option === null) throw new Error("Ask User option not found");
      expect(option.checked).toBe(true);
      const second = rendered.container.querySelector<HTMLInputElement>(
        'input[value="second"]',
      );
      if (second === null) throw new Error("Second Ask User option not found");
      await act(async () => {
        second.click();
        await flushMicrotasks();
      });
      await clickButton(rendered.container, "Submit answers");

      expect(
        memory.controller.calls.find(
          ({ operation }) => operation === "answerInteraction",
        ),
      ).toMatchObject({
        operation: "answerInteraction",
        input: {
          answer: {
            requestId: memory.fixtures.askUserRequest.requestId,
            revision: memory.fixtures.askUserRequest.revision,
            action: "submit",
            answers: { "0": ["first, canary", "second"] },
          },
        },
      });
      expect(client.getSnapshot()?.pendingInteraction).toBeUndefined();
    } finally {
      await rendered.unmount();
      await client.dispose({ deadlineAt: deadlineAt() });
    }
  });

  it("routes per-question chat-about-this through the host without answering the interaction", async () => {
    const { client, memory } = await createLoadedClient();
    const pendingInteraction = {
      ...memory.fixtures.askUserRequest,
      questions: [
        {
          ...memory.fixtures.askUserRequest.questions[0]!,
          id: "first-question",
          defaultValue: "first",
        },
        {
          ...memory.fixtures.askUserRequest.questions[0]!,
          id: "second-question",
          prompt: "Which fallback should be discussed?",
          defaultValue: "second",
        },
      ],
    };
    const pendingSnapshot = {
      ...memory.fixtures.initialSnapshot,
      capabilities: {
        ...memory.fixtures.initialSnapshot.capabilities,
        answerInteraction: true,
      },
      pendingInteraction,
    };
    memory.controller.setSnapshot(pendingSnapshot);
    memory.controller.emitUpdateToAll({
      kind: "snapshot.replace",
      snapshot: pendingSnapshot,
    });
    const discussions: AskUserChatAboutThisRequest[] = [];
    const rendered = await renderInDom(
      createElement(
        ChatProvider,
        { client },
        createElement(ChatConversationView, {
          getDeadlineAt: deadlineAt,
          onChatAboutThis: (request) => discussions.push(request),
        }),
      ),
    );

    try {
      const discussionButtons = [
        ...rendered.container.querySelectorAll("button"),
      ].filter((button) => button.textContent?.includes("Chat about this"));
      expect(discussionButtons).toHaveLength(2);
      await act(async () => {
        discussionButtons[1]!.click();
        await flushMicrotasks();
      });

      expect(discussions).toMatchObject([
        {
          answers: {
            "first-question": "first",
            "second-question": "second",
          },
          conversationId: memory.fixtures.conversation.id,
          question: {
            id: "second-question",
            prompt: "Which fallback should be discussed?",
          },
          questionId: "second-question",
          requestId: memory.fixtures.askUserRequest.requestId,
          revision: memory.fixtures.askUserRequest.revision,
        },
      ]);
      expect(
        memory.controller.calls.filter(
          ({ operation }) => operation === "answerInteraction",
        ),
      ).toHaveLength(0);
      expect(client.getSnapshot()?.pendingInteraction?.requestId).toBe(
        memory.fixtures.askUserRequest.requestId,
      );
    } finally {
      await rendered.unmount();
      await client.dispose({ deadlineAt: deadlineAt() });
    }
  });

  it("explains when pending interaction answers are unavailable", async () => {
    const { client, memory } = await createLoadedClient();
    const pendingSnapshot = {
      ...memory.fixtures.initialSnapshot,
      capabilities: {
        ...memory.fixtures.initialSnapshot.capabilities,
        answerInteraction: false,
      },
      pendingInteraction: memory.fixtures.askUserRequest,
    };
    memory.controller.setSnapshot(pendingSnapshot);
    memory.controller.emitUpdateToAll({
      kind: "snapshot.replace",
      snapshot: pendingSnapshot,
    });
    const rendered = await renderInDom(
      createElement(
        ChatProvider,
        { client },
        createElement(ChatConversationView, {
          getDeadlineAt: deadlineAt,
        }),
      ),
    );

    try {
      expect(rendered.container.textContent).toContain(
        "Interaction answers are unavailable in the current session.",
      );
      const answerButtons = [
        ...rendered.container.querySelectorAll("button"),
      ].filter(
        (button) =>
          button.textContent?.includes("Submit answers") ||
          button.textContent?.includes("Cancel"),
      );
      expect(answerButtons).toHaveLength(2);
      expect(answerButtons.every((button) => button.disabled)).toBe(true);
    } finally {
      await rendered.unmount();
      await client.dispose({ deadlineAt: deadlineAt() });
    }
  });

  it("resets request-scoped form state and renders title, prompt, and description", async () => {
    const { client, memory } = await createLoadedClient();
    const firstRequest = {
      kind: "ask-user" as const,
      conversationId: memory.fixtures.conversation.id,
      requestId: "request:shared",
      revision: "revision",
      title: "Need exact input",
      questions: [
        {
          id: "value",
          title: "Short header",
          prompt: "What exact value should be deployed?",
          description: "Critical context",
          required: true,
          multiple: false,
          defaultValue: "old-secret",
          options: [],
        },
      ],
    };
    const initial = {
      ...memory.fixtures.initialSnapshot,
      capabilities: {
        ...memory.fixtures.initialSnapshot.capabilities,
        answerInteraction: true,
      },
      pendingInteraction: firstRequest,
    };
    memory.controller.setSnapshot(initial);
    memory.controller.emitUpdateToAll({
      kind: "snapshot.replace",
      snapshot: initial,
    });
    const rendered = await renderInDom(
      createElement(
        ChatProvider,
        { client },
        createElement(ChatConversationView, {
          getDeadlineAt: deadlineAt,
        }),
      ),
    );

    try {
      expect(rendered.container.textContent).toContain("Short header");
      expect(rendered.container.textContent).toContain(
        "What exact value should be deployed?",
      );
      expect(rendered.container.textContent).toContain("Critical context");
      const selector = '[aria-label="User input requested"] textarea';
      const oldInput =
        rendered.container.querySelector<HTMLTextAreaElement>(selector);
      if (oldInput === null) throw new Error("Ask User textarea not found");
      expect(oldInput.maxLength).toBe(2_000);
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(
          HTMLTextAreaElement.prototype,
          "value",
        )?.set;
        setter?.call(oldInput, "edited-old-value");
        oldInput.dispatchEvent(new Event("input", { bubbles: true }));
        await flushMicrotasks();
      });

      const replacement = {
        ...firstRequest,
        requestId: "request",
        revision: "shared:revision",
        questions: [
          {
            ...firstRequest.questions[0]!,
            defaultValue: "new-default",
          },
        ],
      };
      memory.controller.setSnapshot({
        ...initial,
        pendingInteraction: replacement,
      });
      await act(async () => {
        memory.controller.emitUpdateToAll({
          kind: "interaction.replace",
          conversationId: memory.fixtures.conversation.id,
          interaction: replacement,
        });
        await flushMicrotasks();
      });

      const replacementInput =
        rendered.container.querySelector<HTMLTextAreaElement>(selector);
      expect(replacementInput?.value).toBe("new-default");
    } finally {
      await rendered.unmount();
      await client.dispose({ deadlineAt: deadlineAt() });
    }
  });

  it("maps indexed form state back to an external question ID", async () => {
    const { client, memory } = await createLoadedClient();
    const request = {
      ...memory.fixtures.askUserRequest,
      questions: [
        {
          id: "release.channel",
          prompt: "Which channel?",
          required: true,
          multiple: false,
          options: [],
        },
      ],
    };
    const initial = {
      ...memory.fixtures.initialSnapshot,
      capabilities: {
        ...memory.fixtures.initialSnapshot.capabilities,
        answerInteraction: true,
      },
      pendingInteraction: request,
    };
    memory.controller.setSnapshot(initial);
    memory.controller.emitUpdateToAll({
      kind: "snapshot.replace",
      snapshot: initial,
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
        '[aria-label="User input requested"] textarea',
      );
      if (input === null) throw new Error("Ask User textarea not found");
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(
          HTMLTextAreaElement.prototype,
          "value",
        )?.set;
        setter?.call(input, "stable");
        input.dispatchEvent(new Event("input", { bubbles: true }));
        await flushMicrotasks();
      });
      await clickButton(rendered.container, "Submit answers");

      expect(
        memory.controller.calls.find(
          ({ operation }) => operation === "answerInteraction",
        ),
      ).toMatchObject({
        input: {
          answer: { answers: { "release.channel": "stable" } },
        },
      });
    } finally {
      await rendered.unmount();
      await client.dispose({ deadlineAt: deadlineAt() });
    }
  });

  it("keeps an Ask User request visible when its controlled answer fails", async () => {
    const { client, memory } = await createLoadedClient();
    const pendingSnapshot = {
      ...memory.fixtures.initialSnapshot,
      capabilities: {
        ...memory.fixtures.initialSnapshot.capabilities,
        answerInteraction: true,
      },
      pendingInteraction: memory.fixtures.askUserRequest,
    };
    memory.controller.setSnapshot(pendingSnapshot);
    memory.controller.emitUpdateToAll({
      kind: "snapshot.replace",
      snapshot: pendingSnapshot,
    });
    memory.controller.setAnswerInteractionResult({
      ok: false,
      error: {
        code: "server",
        conversationId: memory.fixtures.conversation.id,
        message: "Answer failed safely",
        retryable: true,
      },
    });
    const failures: ChatUiCommandFailure[] = [];
    const rendered = await renderInDom(
      createElement(
        ChatProvider,
        { client },
        createElement(ChatConversationView, {
          getDeadlineAt: deadlineAt,
          onCommandError: (failure) => failures.push(failure),
        }),
      ),
    );

    try {
      await clickButton(rendered.container, "Cancel");
      expect(rendered.container.textContent).toContain("Need your input");
      expect(rendered.container.textContent).toContain("Answer failed safely");
      expect(failures).toMatchObject([
        {
          command: "answerInteraction",
          error: { code: "server" },
        },
      ]);
    } finally {
      await rendered.unmount();
      await client.dispose({ deadlineAt: deadlineAt() });
    }
  });

  it("hides an Ask User command failure after the pending request is replaced", async () => {
    const { client, memory } = await createLoadedClient();
    const pendingSnapshot = {
      ...memory.fixtures.initialSnapshot,
      capabilities: {
        ...memory.fixtures.initialSnapshot.capabilities,
        answerInteraction: true,
      },
      pendingInteraction: memory.fixtures.askUserRequest,
    };
    memory.controller.setSnapshot(pendingSnapshot);
    memory.controller.emitUpdateToAll({
      kind: "snapshot.replace",
      snapshot: pendingSnapshot,
    });
    memory.controller.setAnswerInteractionResult({
      ok: false,
      error: {
        code: "server",
        conversationId: memory.fixtures.conversation.id,
        message: "Old request failed",
        retryable: true,
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
      await clickButton(rendered.container, "Cancel");
      expect(rendered.container.textContent).toContain("Old request failed");

      const replacement = {
        ...memory.fixtures.askUserRequest,
        revision: "replacement-revision",
        title: "Replacement input",
      };
      memory.controller.setSnapshot({
        ...pendingSnapshot,
        pendingInteraction: replacement,
      });
      await act(async () => {
        memory.controller.emitUpdateToAll({
          kind: "interaction.replace",
          conversationId: memory.fixtures.conversation.id,
          interaction: replacement,
        });
        await flushMicrotasks();
      });

      expect(rendered.container.textContent).toContain("Replacement input");
      expect(rendered.container.textContent).not.toContain(
        "Old request failed",
      );

      await clickButton(rendered.container, "Cancel");
      expect(rendered.container.textContent).toContain("Old request failed");
      memory.controller.setSnapshot({
        ...pendingSnapshot,
        pendingInteraction: undefined,
      });
      await act(async () => {
        memory.controller.emitUpdateToAll({
          kind: "interaction.replace",
          conversationId: memory.fixtures.conversation.id,
          interaction: null,
        });
        await flushMicrotasks();
      });
      expect(rendered.container.textContent).not.toContain(
        "Old request failed",
      );

      const capabilityProbe = {
        ...replacement,
        revision: "capability-revision",
        title: "Capability input",
      };
      memory.controller.setSnapshot({
        ...pendingSnapshot,
        pendingInteraction: capabilityProbe,
      });
      await act(async () => {
        memory.controller.emitUpdateToAll({
          kind: "interaction.replace",
          conversationId: memory.fixtures.conversation.id,
          interaction: capabilityProbe,
        });
        await flushMicrotasks();
      });
      await clickButton(rendered.container, "Cancel");
      expect(rendered.container.textContent).toContain("Old request failed");
      memory.controller.setSnapshot({
        ...pendingSnapshot,
        capabilities: {
          ...pendingSnapshot.capabilities,
          answerInteraction: false,
        },
        pendingInteraction: capabilityProbe,
      });
      await act(async () => {
        memory.controller.emitUpdateToAll({
          kind: "capabilities.replace",
          conversationId: memory.fixtures.conversation.id,
          capabilities: {
            ...pendingSnapshot.capabilities,
            answerInteraction: false,
          },
        });
        await flushMicrotasks();
      });
      expect(rendered.container.textContent).not.toContain(
        "Old request failed",
      );
    } finally {
      await rendered.unmount();
      await client.dispose({ deadlineAt: deadlineAt() });
    }
  });

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
