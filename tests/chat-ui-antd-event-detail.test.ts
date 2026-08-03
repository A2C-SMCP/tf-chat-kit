// @vitest-environment jsdom

import { ConfigProvider } from "antd";
import {
  act,
  createElement,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  AgentEvent,
  ChatSnapshot,
  UnknownEvent,
} from "../packages/chat-protocol/src/index.js";
import { ChatProvider } from "../packages/chat-react/src/index.js";
import {
  ChatConversationView,
  type ChatRenderer,
} from "../packages/chat-ui-antd/src/index.js";
import { createMemoryChatGateway } from "../packages/chat-testing/src/index.js";
import {
  createLoadedClient,
  deadlineAt,
  flushMicrotasks,
} from "./support/chat-react.js";

class TestResizeObserver implements ResizeObserver {
  static readonly instances: TestResizeObserver[] = [];

  #target: Element | null = null;

  constructor(private readonly callback: ResizeObserverCallback) {
    TestResizeObserver.instances.push(this);
  }

  disconnect(): void {
    this.#target = null;
  }

  observe(target: Element): void {
    this.#target = target;
  }

  unobserve(target: Element): void {
    if (this.#target === target) this.#target = null;
  }

  emit(width: number): void {
    if (this.#target === null) throw new Error("ResizeObserver has no target");
    const entry: ResizeObserverEntry = {
      borderBoxSize: [],
      contentBoxSize: [],
      contentRect: new DOMRect(0, 0, width, 640),
      devicePixelContentBoxSize: [],
      target: this.#target,
    };
    this.callback([entry], this);
  }
}

interface DomRender {
  readonly container: HTMLDivElement;
  readonly root: Root;
  unmount(): Promise<void>;
}

const renderInDom = async (node: ReactNode): Promise<DomRender> => {
  const container = document.createElement("div");
  container.style.height = "720px";
  document.body.append(container);
  const root = createRoot(container);
  const previous = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  await act(async () => {
    root.render(
      createElement(
        ConfigProvider,
        {
          theme: { token: { motion: false } },
          virtual: false,
          wave: { disabled: true },
        },
        node,
      ),
    );
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

const createEventSnapshot = (): {
  readonly event: AgentEvent;
  readonly snapshot: ChatSnapshot;
  readonly unknown: UnknownEvent;
  readonly memory: ReturnType<typeof createMemoryChatGateway>;
} => {
  const memory = createMemoryChatGateway();
  const { conversationId } = memory.fixtures.initialSnapshot.timeline[0]!;
  const event: AgentEvent = {
    kind: "agent-event",
    id: "event-detail",
    conversationId,
    eventCategory: "generic",
    eventType: "agent.thinking",
    status: "running",
    summary: "Initial safe detail",
    createdAt: Date.UTC(2026, 7, 1, 10),
    transitions: [
      {
        id: "event-running",
        status: "running",
        occurredAt: Date.UTC(2026, 7, 1, 10),
        summary: "Initial safe detail",
      },
    ],
  };
  const unknown: UnknownEvent = {
    kind: "unknown-event",
    id: "event-unknown-detail",
    conversationId,
    originalType: "future.event",
    createdAt: Date.UTC(2026, 7, 1, 10, 1),
    summary: "Safe unknown summary",
    raw: { token: "MUST_NOT_RENDER" },
  };
  const snapshot: ChatSnapshot = {
    ...memory.fixtures.initialSnapshot,
    timeline: [...memory.fixtures.initialSnapshot.timeline, event, unknown],
  };
  memory.controller.setSnapshot(snapshot);
  return { event, memory, snapshot, unknown };
};

const findSegment = (label: string): HTMLElement => {
  const segment = [
    ...document.querySelectorAll<HTMLElement>(".ant-segmented-item"),
  ].find((candidate) => candidate.textContent === label);
  if (segment === undefined) throw new Error(`Segment not found: ${label}`);
  return segment;
};

const findTrigger = (container: HTMLElement, id: string): HTMLElement => {
  const trigger = container.querySelector<HTMLElement>(
    `[data-chat-event-trigger="${id}"]`,
  );
  if (trigger === null) throw new Error(`Event trigger not found: ${id}`);
  return trigger;
};

beforeEach(() => {
  TestResizeObserver.instances.length = 0;
  Reflect.set(globalThis, "ResizeObserver", TestResizeObserver);
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

afterEach(() => {
  Reflect.deleteProperty(globalThis, "ResizeObserver");
  document.body.replaceChildren();
});

describe("@turingfocus/chat-ui-antd event details", () => {
  it("keeps click selection stable across updates and switches responsive containers", async () => {
    const { event, memory, snapshot } = createEventSnapshot();
    const { client } = await createLoadedClient(memory);
    const rendered = await renderInDom(
      createElement(
        ChatProvider,
        { client },
        createElement(ChatConversationView, { getDeadlineAt: deadlineAt }),
      ),
    );

    try {
      const observer = TestResizeObserver.instances.at(-1);
      if (observer === undefined) throw new Error("ResizeObserver not created");
      await act(async () => {
        observer.emit(1_000);
        await flushMicrotasks();
      });
      expect(
        rendered.container
          .querySelector("[data-chat-event-layout]")
          ?.getAttribute("data-chat-event-layout"),
      ).toBe("split");
      expect(rendered.container.querySelector("aside")?.textContent).toContain(
        "Select an event",
      );

      const trigger = findTrigger(rendered.container, event.id);
      await act(async () => {
        trigger.click();
        await flushMicrotasks();
      });
      expect(trigger.getAttribute("aria-pressed")).toBe("true");
      expect(rendered.container.querySelector("aside")?.textContent).toContain(
        "Initial safe detail",
      );

      await act(async () => {
        memory.controller.emitUpdateToAll({
          kind: "timeline.upsert",
          conversationId: snapshot.conversation.id,
          item: {
            kind: "unknown-event",
            id: "new-event",
            conversationId: snapshot.conversation.id,
            originalType: "future.new-event",
            createdAt: event.createdAt + 2_000,
            summary: "New event must not take selection",
          },
        });
        await flushMicrotasks();
      });
      expect(trigger.getAttribute("aria-pressed")).toBe("true");
      expect(
        rendered.container.querySelector("aside")?.textContent,
      ).not.toContain("New event must not take selection");

      await act(async () => {
        memory.controller.emitUpdateToAll({
          kind: "event.transition.upsert",
          conversationId: snapshot.conversation.id,
          event: {
            eventCategory: "generic",
            id: event.id,
            eventType: event.eventType,
            createdAt: event.createdAt,
            transition: {
              id: "event-success",
              status: "success",
              occurredAt: event.createdAt + 1_000,
              summary: "Finished safely",
            },
          },
        });
        await flushMicrotasks();
      });
      expect(rendered.container.querySelector("aside")?.textContent).toContain(
        "Finished safely",
      );

      await act(async () => {
        observer.emit(480);
        await flushMicrotasks();
      });
      expect(
        rendered.container
          .querySelector("[data-chat-event-layout]")
          ?.getAttribute("data-chat-event-layout"),
      ).toBe("modal");
      await vi.waitFor(() => {
        expect(
          document.body.querySelector('[role="dialog"]')?.textContent,
        ).toContain("Finished safely");
      });

      const closeButton =
        document.body.querySelector<HTMLButtonElement>(".ant-modal-close");
      if (closeButton === null) throw new Error("Modal close button not found");
      await act(async () => {
        closeButton.click();
        await flushMicrotasks();
      });
      await vi.waitFor(() => expect(document.activeElement).toBe(trigger));
      await vi.waitFor(() =>
        expect(document.body.querySelector('[role="dialog"]')).toBeNull(),
      );

      await act(async () => {
        memory.controller.emitUpdateToAll({
          kind: "event.transition.upsert",
          conversationId: snapshot.conversation.id,
          event: {
            eventCategory: "generic",
            id: event.id,
            eventType: event.eventType,
            createdAt: event.createdAt,
            transition: {
              id: "event-after-close",
              status: "success",
              occurredAt: event.createdAt + 1_500,
              summary: "Updated while closed",
            },
          },
        });
        await flushMicrotasks();
      });
      expect(document.body.querySelector('[role="dialog"]')).toBeNull();

      await act(async () => {
        trigger.dispatchEvent(
          new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }),
        );
        await flushMicrotasks();
      });
      await vi.waitFor(() =>
        expect(document.body.querySelector('[role="dialog"]')).not.toBeNull(),
      );
      expect(
        document.body.querySelector('[role="dialog"]')?.textContent,
      ).toContain("Updated while closed");

      const reopenedClose =
        document.body.querySelector<HTMLButtonElement>(".ant-modal-close");
      if (reopenedClose === null) throw new Error("Reopened modal not found");
      await act(async () => {
        reopenedClose.click();
        await flushMicrotasks();
      });
      await act(async () => {
        trigger.dispatchEvent(
          new KeyboardEvent("keydown", { bubbles: true, key: " " }),
        );
        await flushMicrotasks();
      });
      await vi.waitFor(() =>
        expect(document.body.querySelector('[role="dialog"]')).not.toBeNull(),
      );
      await act(async () => {
        document.dispatchEvent(
          new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }),
        );
        await flushMicrotasks();
      });
      await vi.waitFor(() => expect(document.activeElement).toBe(trigger));

      await act(async () => {
        findSegment("Split").click();
        await flushMicrotasks();
      });
      expect(
        rendered.container
          .querySelector("[data-chat-event-layout]")
          ?.getAttribute("data-chat-event-layout"),
      ).toBe("split");
      await act(async () => {
        observer.emit(360);
        await flushMicrotasks();
      });
      expect(
        rendered.container
          .querySelector("[data-chat-event-layout]")
          ?.getAttribute("data-chat-event-layout"),
      ).toBe("split");

      await act(async () => {
        memory.controller.emitUpdateToAll({
          kind: "snapshot.replace",
          snapshot: {
            ...snapshot,
            timeline: snapshot.timeline.filter(
              (item) => item.kind === "message",
            ),
          },
        });
        await flushMicrotasks();
      });
      expect(rendered.container.querySelector("aside")?.textContent).toContain(
        "Select an event",
      );
    } finally {
      await rendered.unmount();
      await client.dispose({ deadlineAt: deadlineAt() });
    }
  });

  it("keeps custom renderer controls independent from event selection", async () => {
    const { event, memory } = createEventSnapshot();
    const { client } = await createLoadedClient(memory);
    const onAriaAction = vi.fn();
    const onInnerAction = vi.fn();
    const onSelectedEventChange = vi.fn();
    const InteractiveRenderer: ChatRenderer = ({ displayMode }) =>
      displayMode === "timeline"
        ? createElement(
            "div",
            null,
            createElement(
              "button",
              { onClick: onInnerAction, type: "button" },
              "Inner action",
            ),
            createElement(
              "a",
              {
                href: "#renderer-action",
                onClick: (clickEvent: ReactMouseEvent<HTMLAnchorElement>) =>
                  clickEvent.preventDefault(),
              },
              "Inner link",
            ),
            createElement("input", { "aria-label": "Inner input" }),
            createElement(
              "label",
              null,
              createElement("input", { type: "checkbox" }),
              "Labeled toggle",
            ),
            createElement(
              "div",
              {
                "aria-checked": "false",
                onClick: onAriaAction,
                role: "checkbox",
                tabIndex: 0,
              },
              "ARIA checkbox",
            ),
            createElement(
              "div",
              {
                "aria-checked": "false",
                onClick: onAriaAction,
                role: "switch",
                tabIndex: 0,
              },
              "ARIA switch",
            ),
            createElement(
              "div",
              { "data-chat-event-interactive": "" },
              createElement("span", null, "Custom interaction boundary"),
            ),
          )
        : createElement("p", null, "Custom event detail");
    const rendered = await renderInDom(
      createElement(
        ChatProvider,
        { client },
        createElement(ChatConversationView, {
          defaultEventDetailMode: "split",
          getDeadlineAt: deadlineAt,
          onSelectedEventChange,
          renderers: { "agent-event:generic": InteractiveRenderer },
        }),
      ),
    );

    try {
      const innerButton = [
        ...rendered.container.querySelectorAll("button"),
      ].find((candidate) => candidate.textContent === "Inner action");
      const innerLink = [...rendered.container.querySelectorAll("a")].find(
        (candidate) => candidate.textContent === "Inner link",
      );
      const innerInput = rendered.container.querySelector<HTMLInputElement>(
        'input[aria-label="Inner input"]',
      );
      const labeledToggle = [
        ...rendered.container.querySelectorAll("label"),
      ].find((candidate) => candidate.textContent === "Labeled toggle");
      const ariaCheckbox =
        rendered.container.querySelector<HTMLElement>('[role="checkbox"]');
      const ariaSwitch =
        rendered.container.querySelector<HTMLElement>('[role="switch"]');
      const customInteractionBoundary =
        rendered.container.querySelector<HTMLElement>(
          "[data-chat-event-interactive] span",
        );
      if (
        innerButton === undefined ||
        innerLink === undefined ||
        innerInput === null ||
        labeledToggle === undefined ||
        ariaCheckbox === null ||
        ariaSwitch === null ||
        customInteractionBoundary === null
      ) {
        throw new Error("Interactive custom renderer controls not found");
      }

      await act(async () => {
        innerButton.click();
        await flushMicrotasks();
      });
      expect(onInnerAction).toHaveBeenCalledOnce();
      expect(onSelectedEventChange).not.toHaveBeenCalled();

      await act(async () => {
        labeledToggle.click();
        ariaCheckbox.click();
        ariaSwitch.click();
        customInteractionBoundary.click();
        await flushMicrotasks();
      });
      expect(onAriaAction).toHaveBeenCalledTimes(2);
      expect(onSelectedEventChange).not.toHaveBeenCalled();

      for (const [control, key] of [
        [innerButton, "Enter"],
        [innerLink, " "],
        [innerInput, "Enter"],
      ] as const) {
        const keyEvent = new KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          key,
        });
        await act(async () => {
          control.dispatchEvent(keyEvent);
          await flushMicrotasks();
        });
        expect(keyEvent.defaultPrevented).toBe(false);
      }
      expect(onSelectedEventChange).not.toHaveBeenCalled();

      const selectionTrigger = findTrigger(rendered.container, event.id);
      await act(async () => {
        selectionTrigger.dispatchEvent(
          new KeyboardEvent("keydown", {
            bubbles: true,
            cancelable: true,
            key: "Enter",
          }),
        );
        await flushMicrotasks();
      });
      expect(onSelectedEventChange).toHaveBeenCalledOnce();
      expect(onSelectedEventChange.mock.calls[0]?.[0]).toBe(event.id);
      expect(rendered.container.querySelector("aside")?.textContent).toContain(
        "Custom event detail",
      );
    } finally {
      await rendered.unmount();
      await client.dispose({ deadlineAt: deadlineAt() });
    }
  });

  it("honors controlled mode and selection while reporting requested changes", async () => {
    const { event, memory, unknown } = createEventSnapshot();
    const { client } = await createLoadedClient(memory);
    const onEventDetailModeChange = vi.fn();
    const onSelectedEventChange = vi.fn();
    const rendered = await renderInDom(
      createElement(
        ChatProvider,
        { client },
        createElement(ChatConversationView, {
          eventDetailMode: "split",
          getDeadlineAt: deadlineAt,
          onEventDetailModeChange,
          onSelectedEventChange,
          selectedEventId: event.id,
        }),
      ),
    );

    try {
      expect(rendered.container.querySelector("aside")?.textContent).toContain(
        "Initial safe detail",
      );
      await act(async () => {
        findTrigger(rendered.container, unknown.id).click();
        await flushMicrotasks();
      });
      const selection = onSelectedEventChange.mock.calls.at(-1);
      expect(selection?.[0]).toBe(unknown.id);
      expect(selection?.[1]).toMatchObject({
        id: unknown.id,
        raw: { token: "[REDACTED]" },
        summary: unknown.summary,
      });
      expect(rendered.container.querySelector("aside")?.textContent).toContain(
        "Initial safe detail",
      );
      expect(rendered.container.textContent).not.toContain("MUST_NOT_RENDER");

      await act(async () => {
        findSegment("Modal").click();
        await flushMicrotasks();
      });
      expect(onEventDetailModeChange).toHaveBeenLastCalledWith("modal");
      expect(
        rendered.container
          .querySelector("[data-chat-event-layout]")
          ?.getAttribute("data-chat-event-layout"),
      ).toBe("split");
    } finally {
      await rendered.unmount();
      await client.dispose({ deadlineAt: deadlineAt() });
    }
  });
});
