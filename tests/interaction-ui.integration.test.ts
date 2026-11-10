// @vitest-environment jsdom
import { act, createElement, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ChatProvider,
  InteractionProvider,
  useInteractionClient,
  useInteractionQueue,
} from "../packages/chat-react/src/index.js";
import {
  ChatCompactWorkspace,
  ChatConversationView,
  ChatWorkspace,
  InteractionCard,
  InteractionHistoryView,
  InteractionQueue,
  compactChatZhCN,
  defaultChatRendererRegistry,
  defaultChatUiLabels,
  resolveChatUiLabels,
} from "../packages/chat-ui-antd/src/index.js";
import {
  createInteractionClient,
  type AskUserRemoteTool,
  type AskUserRemoteToolEntry,
  type InteractionClient,
} from "../packages/chat-runtime/src/index.js";
import {
  createChatContractFixtures,
  createMemoryChatGateway,
} from "../packages/chat-testing/src/index.js";
import { MemoryGatewayClock } from "../packages/chat-testing/src/memory-gateway-clock.js";
import type {
  InteractionAck,
  InteractionClosed,
  InteractionPendingSnapshot,
  InteractionRequest,
  InteractionResponse,
  InteractionServerHello,
  InteractionTransport,
  InteractionTransportAttachment,
  InteractionTransportObserver,
  TimelineItem,
} from "../packages/chat-protocol/src/index.js";
import {
  createLoadedClient,
  deadlineAt,
  flushMicrotasks,
} from "./support/chat-react.js";

const NOW = 1_800_000_000_000;

Object.defineProperty(window, "matchMedia", {
  configurable: true,
  value: () => ({
    matches: false,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
  }),
});

const request = (
  interactionId: string,
  overrides: Partial<InteractionRequest> = {},
): InteractionRequest => ({
  interactionId,
  conversationId: "42",
  conversationTitle: "Deploy",
  robotId: "robot-1",
  namespace: "/remote-tool",
  requester: { id: "user-1", name: "Alice" },
  target: { kind: "human", id: "user-2", name: "Bob" },
  question: "Deploy now?",
  options: [
    { value: "yes", label: "Yes" },
    { value: "no", label: "No" },
  ],
  multiSelect: false,
  timeoutSeconds: 30,
  expiresAt: NOW + 30_000,
  ...overrides,
});

class MemoryInteractionTransport implements InteractionTransport {
  readonly #time = new MemoryGatewayClock(NOW);
  readonly clock = {
    now: (): number => this.#time.now(),
    schedule: (callback: () => void, delayMs: number): (() => void) => {
      const signal = this.#time.signal(this.#time.now() + delayMs);
      let active = true;
      void signal.promise.then(() => {
        if (active) callback();
      });
      return () => {
        active = false;
        signal.cancel();
      };
    },
  };
  readonly namespace = "/remote-tool";
  observer: InteractionTransportObserver | undefined;
  attachment: InteractionTransportAttachment | undefined;
  readonly responses: InteractionResponse[] = [];
  readonly acks: Array<(ack: InteractionAck | undefined) => void> = [];
  respondReturn = true;
  detached = false;
  readonly retry = vi.fn();

  attachInteraction(
    observer: InteractionTransportObserver,
  ): InteractionTransportAttachment {
    this.observer = observer;
    this.attachment = {
      respond: (response, onAck) => {
        this.responses.push(response);
        this.acks.push(onAck);
        return this.respondReturn;
      },
      detach: () => {
        this.detached = true;
      },
    };
    return this.attachment;
  }

  advanceTo(timestamp: number): void {
    this.#time.advanceTo(timestamp);
  }

  hello(
    hello: InteractionServerHello = {
      versions: ["interaction_v1"],
      robotId: "robot-1",
      namespace: "/remote-tool",
    },
  ): void {
    this.observer?.hello(hello);
  }

  pending(snapshot: InteractionPendingSnapshot): void {
    this.observer?.pending(snapshot);
  }

  requested(value: InteractionRequest): void {
    this.observer?.requested(value);
  }

  closed(value: InteractionClosed): void {
    this.observer?.closed(value);
  }

  connection(state: "connected" | "disconnected"): void {
    this.observer?.connection(state);
  }

  ack(value: InteractionAck | undefined, index = this.acks.length - 1): void {
    this.acks[index]?.(value);
  }
}

const flush = async (): Promise<void> => {
  for (let index = 0; index < 20; ++index) await Promise.resolve();
};

const setup = (): {
  readonly client: InteractionClient;
  readonly transport: MemoryInteractionTransport;
} => {
  const transport = new MemoryInteractionTransport();
  const client = createInteractionClient({
    transport,
    robotId: "robot-1",
    tickIntervalMs: 1_000,
  });
  return { client, transport };
};

const synchronize = async (
  transport: MemoryInteractionTransport,
): Promise<void> => {
  transport.connection("connected");
  transport.hello();
  transport.pending({ kind: "snapshot", requests: [], knownIds: [] });
  await flush();
};

const push = async (
  transport: MemoryInteractionTransport,
  value: InteractionRequest,
): Promise<void> => {
  transport.requested(value);
  await flush();
};

interface DomRender {
  readonly container: HTMLDivElement;
  readonly root: Root;
  unmount(): Promise<void>;
}

const render = async (node: ReactNode): Promise<DomRender> => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const actKey = "IS_REACT_ACT_ENVIRONMENT";
  const previous = Reflect.get(globalThis, actKey);
  Reflect.set(globalThis, actKey, true);
  await act(async () => {
    root.render(node);
    await flush();
  });
  return {
    container,
    root,
    async unmount() {
      await act(async () => {
        root.unmount();
        await flush();
      });
      container.remove();
      if (previous === undefined) Reflect.deleteProperty(globalThis, actKey);
      else Reflect.set(globalThis, actKey, previous);
    },
  };
};

const findButton = (container: ParentNode, text: string): HTMLButtonElement => {
  const button = [...container.querySelectorAll("button")].find((candidate) =>
    candidate.textContent?.includes(text),
  );
  if (button === undefined) throw new Error(`Button not found: ${text}`);
  return button;
};

const setValue = async (
  input: HTMLInputElement | HTMLTextAreaElement,
  value: string,
): Promise<void> => {
  const prototype =
    input instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(
      input,
      value,
    );
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await flush();
  });
};

const Probe = () => {
  const client = useInteractionClient();
  const queue = useInteractionQueue();
  return createElement(
    "div",
    { "data-testid": "probe" },
    [
      client === null ? "no-client" : "client",
      queue.active?.interactionId ?? "none",
      queue.waiting.map((entry) => entry.interactionId).join(","),
      queue.connection,
      String(queue.now),
      String(queue.liveCount),
    ].join("|"),
  );
};

const ActivateLate = () => {
  const queue = useInteractionQueue();
  return createElement(
    "button",
    { onClick: () => queue.activate("late") },
    "activate-late",
  );
};

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("InteractionProvider", () => {
  it("renders without a provider, inherits an outer client and supports null disable", async () => {
    const empty = await render(createElement(Probe));
    expect(empty.container.textContent).toBe(
      "no-client|none||disconnected|0|0",
    );
    await empty.unmount();

    const { client } = setup();
    const inherited = await render(
      createElement(
        InteractionProvider,
        { client },
        createElement(InteractionProvider, undefined, createElement(Probe)),
      ),
    );
    expect(inherited.container.textContent).toContain("client|");
    await inherited.unmount();

    const disabled = await render(
      createElement(
        InteractionProvider,
        { client },
        createElement(
          InteractionProvider,
          { client: null },
          createElement(Probe),
        ),
      ),
    );
    expect(disabled.container.textContent).toContain("no-client|");
    await disabled.unmount();
    client.dispose();
  });

  it("subscribes to the runtime snapshot, shares activate and never disposes the host client", async () => {
    const { client, transport } = setup();
    await synchronize(transport);
    const dispose = vi.spyOn(client, "dispose");
    const view = await render(
      createElement(
        InteractionProvider,
        { client },
        createElement(
          "div",
          undefined,
          createElement(Probe),
          createElement(ActivateLate),
        ),
      ),
    );
    await push(transport, request("late", { expiresAt: NOW + 20_000 }));
    await push(transport, request("early", { expiresAt: NOW + 5_000 }));
    await act(async () => {
      await flush();
    });
    expect(view.container.textContent).toContain("client|early|late|connected");
    expect(view.container.textContent).toContain("|2");
    await act(async () => {
      findButton(view.container, "activate-late").click();
      await flush();
    });
    expect(view.container.textContent).toContain("client|late|early|connected");
    await view.unmount();
    expect(dispose).not.toHaveBeenCalled();
    client.dispose();
  });

  it("switches to a replacement client without disposing the old one", async () => {
    const first = setup();
    const second = setup();
    await synchronize(first.transport);
    await synchronize(second.transport);
    await push(first.transport, request("first"));
    await push(second.transport, request("second"));
    const disposeFirst = vi.spyOn(first.client, "dispose");
    const view = await render(
      createElement(
        InteractionProvider,
        { client: first.client },
        createElement(Probe),
      ),
    );
    expect(view.container.textContent).toContain("client|first|");
    await act(async () => {
      view.root.render(
        createElement(
          InteractionProvider,
          { client: second.client },
          createElement(Probe),
        ),
      );
      await flush();
    });
    expect(view.container.textContent).toContain("client|second|");
    expect(disposeFirst).not.toHaveBeenCalled();
    await view.unmount();
    first.client.dispose();
    second.client.dispose();
  });
});

describe("InteractionCard", () => {
  const renderCard = async (
    value: InteractionRequest,
    options: {
      readonly connection?: "connected" | "disconnected" | "awaiting-snapshot";
      readonly labels?: typeof defaultChatUiLabels;
      readonly respond?: () => boolean;
    } = {},
  ) => {
    const { client, transport } = setup();
    await synchronize(transport);
    await push(transport, value);
    const view = client.getSnapshot().entries[value.interactionId]!;
    const onRespond = vi.fn(options.respond ?? (() => true));
    const rendered = await render(
      createElement(InteractionCard, {
        connection: options.connection ?? client.getSnapshot().connection,
        labels: options.labels ?? defaultChatUiLabels,
        now: client.getSnapshot().now,
        onRespond,
        view,
      }),
    );
    return { client, onRespond, rendered, transport };
  };

  it("submits a single-select answer using option.value", async () => {
    const { client, onRespond, rendered } = await renderCard(request("single"));
    const radio =
      rendered.container.querySelector<HTMLInputElement>('input[value="yes"]')!;
    await act(async () => {
      radio.click();
      await flush();
    });
    await act(async () => {
      findButton(rendered.container, "Submit answers").click();
      await flush();
    });
    expect(onRespond).toHaveBeenCalledWith("single", {
      status: "answered",
      selectedOptions: ["yes"],
    });
    await rendered.unmount();
    client.dispose();
  });

  it("submits multi-select values plus custom text", async () => {
    const { client, onRespond, rendered } = await renderCard(
      request("multi", {
        multiSelect: true,
        options: [
          { value: "a", label: "A" },
          { value: "b", label: "B" },
        ],
      }),
    );
    await act(async () => {
      rendered.container
        .querySelector<HTMLInputElement>('input[value="a"]')!
        .click();
      await flush();
    });
    await act(async () => {
      rendered.container
        .querySelector<HTMLInputElement>('input[value="b"]')!
        .click();
      await flush();
    });
    const other = rendered.container.querySelector<HTMLInputElement>(
      'input[aria-label="Other"]',
    )!;
    await setValue(other, " custom ");
    await act(async () => {
      findButton(rendered.container, "Submit answers").click();
      await flush();
    });
    expect(onRespond).toHaveBeenCalledWith("multi", {
      status: "answered",
      selectedOptions: ["a", "b"],
      answer: "custom",
    });
    await rendered.unmount();
    client.dispose();
  });

  it("submits free text when no options exist and disables empty answers", async () => {
    const { client, onRespond, rendered } = await renderCard(
      request("free", { options: undefined }),
    );
    const submit = findButton(rendered.container, "Submit answers");
    expect(submit.disabled).toBe(true);
    const textarea = rendered.container.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Type your answer"]',
    )!;
    await setValue(textarea, "Looks good");
    await act(async () => {
      findButton(rendered.container, "Submit answers").click();
      await flush();
    });
    expect(onRespond).toHaveBeenCalledWith("free", {
      status: "answered",
      answer: "Looks good",
    });
    await rendered.unmount();
    client.dispose();
  });

  it("cancels and reports a rejected response without clearing the input", async () => {
    const { client, onRespond, rendered } = await renderCard(
      request("reject"),
      { respond: () => false },
    );
    await act(async () => {
      findButton(rendered.container, "Cancel").click();
      await flush();
    });
    expect(onRespond).toHaveBeenCalledWith("reject", {
      status: "cancelled",
    });
    expect(rendered.container.textContent).toContain(
      "The answer was not sent. Try again.",
    );
    await rendered.unmount();
    client.dispose();
  });

  it("shows the ack timeout hint and disables input while disconnected", async () => {
    const { client, transport } = setup();
    await synchronize(transport);
    await push(transport, request("timeout"));
    client.respond("timeout", { status: "answered", selectedOptions: ["yes"] });
    await act(async () => {
      transport.advanceTo(NOW + 10_000);
      await flush();
    });
    const timedOut = client.getSnapshot().entries["timeout"]!;
    expect(timedOut.staleReason).toBe("ack_timeout");
    expect(timedOut.attempt).toBe(1);
    const rendered = await render(
      createElement(InteractionCard, {
        connection: client.getSnapshot().connection,
        labels: defaultChatUiLabels,
        now: client.getSnapshot().now,
        onRespond: () => true,
        view: timedOut,
      }),
    );
    expect(rendered.container.textContent).toContain(
      "Server confirmation not received",
    );
    await rendered.unmount();

    const offline = await render(
      createElement(InteractionCard, {
        connection: "disconnected",
        labels: defaultChatUiLabels,
        now: NOW,
        onRespond: () => true,
        view: timedOut,
      }),
    );
    expect(offline.container.textContent).toContain(
      "Connection lost. You cannot answer right now.",
    );
    expect(findButton(offline.container, "Submit answers").disabled).toBe(true);
    expect(findButton(offline.container, "Cancel").disabled).toBe(true);
    expect(
      offline.container.querySelector<HTMLInputElement>('input[value="yes"]')
        ?.disabled,
    ).toBe(true);
    await offline.unmount();
    client.dispose();
  });

  it("uses Chinese labels and source fallbacks", async () => {
    const { client, rendered } = await renderCard(
      request("zh", { conversationTitle: undefined }),
      { labels: resolveChatUiLabels(compactChatZhCN) },
    );
    expect(rendered.container.textContent).toContain("会话 42");
    expect(rendered.container.textContent).toContain("机器人 robot-1");
    expect(() => findButton(rendered.container, "提")).not.toThrow();
    await rendered.unmount();
    client.dispose();
  });

  it("hides the ack timeout warning while submitting or accepted", async () => {
    const { client, transport } = setup();
    await synchronize(transport);
    await push(transport, request("states"));
    const view = client.getSnapshot().entries["states"]!;
    const renderView = (
      patch: Partial<typeof view>,
      connection: "connected" | "awaiting-snapshot" = "connected",
    ) =>
      render(
        createElement(InteractionCard, {
          connection,
          labels: defaultChatUiLabels,
          now: NOW,
          onRespond: () => true,
          view: { ...view, ...patch },
        }),
      );

    const submitting = await renderView({
      status: "submitting",
      staleReason: "ack_timeout",
    });
    expect(submitting.container.textContent).not.toContain(
      "Server confirmation not received",
    );
    expect(submitting.container.textContent).toContain(
      "Submitting your answer…",
    );
    await submitting.unmount();

    const accepted = await renderView({
      status: "accepted",
      staleReason: "ack_timeout",
    });
    expect(accepted.container.textContent).not.toContain(
      "Server confirmation not received",
    );
    expect(accepted.container.textContent).toContain(
      "Answer submitted. Waiting for server confirmation.",
    );
    await accepted.unmount();

    const awaiting = await renderView({}, "awaiting-snapshot");
    expect(awaiting.container.textContent).toContain(
      "Connected. Syncing pending questions…",
    );
    expect(findButton(awaiting.container, "Submit answers").disabled).toBe(
      true,
    );
    await awaiting.unmount();
    client.dispose();
  });

  it("resets local input when the view changes without an external key", async () => {
    const { client, transport } = setup();
    await synchronize(transport);
    await push(transport, request("first"));
    await push(transport, request("second"));
    const first = client.getSnapshot().entries["first"]!;
    const second = client.getSnapshot().entries["second"]!;
    const onRespond = vi.fn(() => true);
    const card = (view: typeof first) =>
      createElement(InteractionCard, {
        connection: "connected",
        labels: defaultChatUiLabels,
        now: NOW,
        onRespond,
        view,
      });
    const rendered = await render(card(first));
    await act(async () => {
      rendered.container
        .querySelector<HTMLInputElement>('input[value="yes"]')!
        .click();
      await flush();
    });
    await setValue(
      rendered.container.querySelector<HTMLInputElement>(
        'input[aria-label="Other"]',
      )!,
      "first-answer",
    );
    await act(async () => {
      rendered.root.render(card(second));
      await flush();
    });
    expect(
      rendered.container.querySelector<HTMLInputElement>('input[value="yes"]')
        ?.checked,
    ).toBe(false);
    expect(
      rendered.container.querySelector<HTMLInputElement>(
        'input[aria-label="Other"]',
      )?.value,
    ).toBe("");
    await rendered.unmount();
    client.dispose();
  });
});

describe("InteractionQueue", () => {
  it("shows the active item in a modal unless the conversation is inline", async () => {
    const { client, transport } = setup();
    await synchronize(transport);
    await push(transport, request("active"));
    const modal = await render(
      createElement(
        InteractionProvider,
        { client },
        createElement(InteractionQueue, {
          labels: defaultChatUiLabels,
        }),
      ),
    );
    expect(
      document.querySelector('[data-interaction-id="active"]'),
    ).not.toBeNull();
    await modal.unmount();

    const inline = await render(
      createElement(
        InteractionProvider,
        { client },
        createElement(InteractionQueue, {
          inlineConversationId: "42",
          labels: defaultChatUiLabels,
        }),
      ),
    );
    expect(document.querySelector('[data-interaction-id="active"]')).toBeNull();
    await inline.unmount();
    client.dispose();
  });

  it("shows a queue badge for waiting items and announces count changes", async () => {
    const { client, transport } = setup();
    await synchronize(transport);
    await push(transport, request("early", { expiresAt: NOW + 5_000 }));
    const rendered = await render(
      createElement(
        InteractionProvider,
        { client },
        createElement(InteractionQueue, {
          labels: defaultChatUiLabels,
        }),
      ),
    );
    await push(transport, request("late", { expiresAt: NOW + 20_000 }));
    await act(async () => {
      await flush();
    });
    const badge = document.querySelector<HTMLButtonElement>(
      '[data-testid="interaction-queue-badge"]',
    );
    expect(badge?.getAttribute("aria-label")).toContain("(1)");
    expect(document.querySelector('[role="status"]')?.textContent).toContain(
      "Pending questions (1)",
    );
    await rendered.unmount();
    client.dispose();
  });

  it("cancels the active item through the modal", async () => {
    const { client, transport } = setup();
    await synchronize(transport);
    await push(transport, request("cancel-me"));
    const rendered = await render(
      createElement(
        InteractionProvider,
        { client },
        createElement(InteractionQueue, {
          labels: defaultChatUiLabels,
        }),
      ),
    );
    await act(async () => {
      findButton(document.body, "Cancel").click();
      await flush();
    });
    expect(transport.responses).toContainEqual({
      interactionId: "cancel-me",
      status: "cancelled",
    });
    await rendered.unmount();
    client.dispose();
  });

  it("preserves the answer draft across an ack timeout retry", async () => {
    const { client, transport } = setup();
    await synchronize(transport);
    await push(transport, request("draft"));
    const rendered = await render(
      createElement(
        InteractionProvider,
        { client },
        createElement(InteractionQueue, {
          labels: defaultChatUiLabels,
        }),
      ),
    );
    await act(async () => {
      document.querySelector<HTMLInputElement>('input[value="yes"]')!.click();
      await flush();
    });
    const other = document.querySelector<HTMLInputElement>(
      'input[aria-label="Other"]',
    )!;
    await setValue(other, "reason");
    await act(async () => {
      findButton(document.body, "Submit answers").click();
      await flush();
    });
    await act(async () => {
      transport.advanceTo(NOW + 10_000);
      await flush();
    });
    expect(client.getSnapshot().entries["draft"]?.staleReason).toBe(
      "ack_timeout",
    );
    expect(
      document.querySelector<HTMLInputElement>('input[value="yes"]')?.checked,
    ).toBe(true);
    expect(
      document.querySelector<HTMLInputElement>('input[aria-label="Other"]')
        ?.value,
    ).toBe("reason");
    await rendered.unmount();
    client.dispose();
  });

  it("restores the draft after the queue card remounts", async () => {
    const { client, transport } = setup();
    await synchronize(transport);
    await push(transport, request("draft-remount"));
    const QueueToggle = ({ show }: { readonly show: boolean }) =>
      show
        ? createElement(InteractionQueue, { labels: defaultChatUiLabels })
        : null;
    const tree = (show: boolean) =>
      createElement(
        InteractionProvider,
        { client },
        createElement(QueueToggle, { show }),
      );
    const rendered = await render(tree(true));
    await act(async () => {
      document.querySelector<HTMLInputElement>('input[value="yes"]')!.click();
      await flush();
    });
    await setValue(
      document.querySelector<HTMLInputElement>('input[aria-label="Other"]')!,
      "reason",
    );
    await act(async () => {
      rendered.root.render(tree(false));
      await flush();
    });
    await act(async () => {
      rendered.root.render(tree(true));
      await flush();
    });
    expect(
      document.querySelector<HTMLInputElement>('input[value="yes"]')?.checked,
    ).toBe(true);
    expect(
      document.querySelector<HTMLInputElement>('input[aria-label="Other"]')
        ?.value,
    ).toBe("reason");
    await rendered.unmount();
    client.dispose();
  });

  it("dismisses the modal without cancelling the interaction", async () => {
    const { client, transport } = setup();
    await synchronize(transport);
    await push(transport, request("dismiss-me"));
    const rendered = await render(
      createElement(
        InteractionProvider,
        { client },
        createElement(InteractionQueue, {
          labels: defaultChatUiLabels,
        }),
      ),
    );
    const close = document.querySelector<HTMLButtonElement>(".ant-modal-close");
    expect(close).not.toBeNull();
    await act(async () => {
      close!.click();
      await flush();
      await new Promise<void>((resolve) => setTimeout(resolve, 300));
    });
    expect(transport.responses).toHaveLength(0);
    const badge = document.querySelector(
      '[data-testid="interaction-queue-badge"]',
    );
    expect(badge?.getAttribute("aria-label")).toContain("(1)");
    await rendered.unmount();
    client.dispose();
  });

  it("reopens a dismissed active item from the badge", async () => {
    const { client, transport } = setup();
    await synchronize(transport);
    await push(transport, request("reopen"));
    const rendered = await render(
      createElement(
        InteractionProvider,
        { client },
        createElement(InteractionQueue, {
          labels: defaultChatUiLabels,
        }),
      ),
    );
    const close = document.querySelector<HTMLButtonElement>(".ant-modal-close");
    expect(close).not.toBeNull();
    await act(async () => {
      close!.click();
      await flush();
      await new Promise<void>((resolve) => setTimeout(resolve, 300));
    });
    const badge = document.querySelector<HTMLButtonElement>(
      '[data-testid="interaction-queue-badge"]',
    );
    expect(badge).not.toBeNull();
    await act(async () => {
      badge!.click();
      await flush();
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    });
    const open = [...document.querySelectorAll("button")].find(
      (button) => button.textContent === "Open",
    );
    expect(open).toBeDefined();
    await act(async () => {
      open!.click();
      await flush();
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    });
    expect(
      document.querySelector('[data-interaction-id="reopen"]'),
    ).not.toBeNull();
    await rendered.unmount();
    client.dispose();
  });

  it("shows an error when a queued cancel is rejected", async () => {
    const { client, transport } = setup();
    await synchronize(transport);
    await push(transport, request("cancel-fail"));
    transport.respondReturn = false;
    const rendered = await render(
      createElement(
        InteractionProvider,
        { client },
        createElement(InteractionQueue, {
          labels: defaultChatUiLabels,
        }),
      ),
    );
    const close = document.querySelector<HTMLButtonElement>(".ant-modal-close");
    expect(close).not.toBeNull();
    await act(async () => {
      close!.click();
      await flush();
      await new Promise<void>((resolve) => setTimeout(resolve, 300));
    });
    const badge = document.querySelector<HTMLButtonElement>(
      '[data-testid="interaction-queue-badge"]',
    );
    expect(badge).not.toBeNull();
    await act(async () => {
      badge!.click();
      await flush();
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    });
    const cancel = [...document.querySelectorAll("button")].find(
      (button) => button.textContent === "Cancel",
    );
    expect(cancel).toBeDefined();
    await act(async () => {
      cancel!.click();
      await flush();
    });
    expect(document.body.textContent).toContain(
      "The answer was not sent. Try again.",
    );
    await rendered.unmount();
    client.dispose();
  });

  it("clears drafts when the interaction client is replaced", async () => {
    const first = setup();
    const second = setup();
    await synchronize(first.transport);
    await synchronize(second.transport);
    await push(first.transport, request("shared-id"));
    await push(second.transport, request("shared-id"));
    const DraftProbe = () => {
      const queue = useInteractionQueue();
      const [version, setVersion] = useState(0);
      return createElement(
        "div",
        undefined,
        createElement(
          "button",
          {
            onClick: () => {
              queue.setDraft("shared-id", {
                customText: "first",
                selected: ["yes"],
              });
              setVersion(version + 1);
            },
          },
          "set-draft",
        ),
        createElement(
          "span",
          { "data-testid": "draft" },
          queue.getDraft("shared-id")?.customText ?? "none",
        ),
      );
    };
    const rendered = await render(
      createElement(
        InteractionProvider,
        { client: first.client },
        createElement(DraftProbe),
      ),
    );
    await act(async () => {
      findButton(rendered.container, "set-draft").click();
      await flush();
    });
    expect(
      rendered.container.querySelector('[data-testid="draft"]')?.textContent,
    ).toBe("first");
    await act(async () => {
      rendered.root.render(
        createElement(
          InteractionProvider,
          { client: second.client },
          createElement(DraftProbe),
        ),
      );
      await flush();
    });
    expect(
      rendered.container.querySelector('[data-testid="draft"]')?.textContent,
    ).toBe("none");
    await rendered.unmount();
    first.client.dispose();
    second.client.dispose();
  });
});

describe("InteractionHistoryView", () => {
  it("renders unknown statuses as-is with question/answer/error", async () => {
    const rendered = await render(
      createElement(InteractionHistoryView, {
        history: {
          kind: "interaction-history",
          interactionId: "history-1",
          direction: "answer",
          status: "future-terminal-reason",
          question: "Deploy now?",
          answer: "Yes",
          answeredBy: "Alice",
          error: "boom",
        },
        labels: defaultChatUiLabels,
      }),
    );
    expect(rendered.container.textContent).toContain("future-terminal-reason");
    expect(rendered.container.textContent).toContain("Deploy now?");
    expect(rendered.container.textContent).toContain("Yes");
    expect(rendered.container.textContent).toContain("Alice");
    expect(rendered.container.textContent).toContain("boom");
    await rendered.unmount();
  });

  it("renders interaction history through the default tool renderer", async () => {
    const renderer = defaultChatRendererRegistry["agent-event:tool"];
    expect(renderer).toBeDefined();
    const item = {
      kind: "agent-event",
      id: "event-1",
      conversationId: "conversation-contract",
      eventType: "tool",
      eventCategory: "tool",
      status: "completed",
      createdAt: NOW,
      summary: "Tool completed",
      transitions: [
        {
          id: "transition-1",
          eventType: "tool",
          status: "completed",
          occurredAt: NOW,
          interactionHistory: {
            kind: "interaction-history",
            interactionId: "history-1",
            direction: "ask",
            status: "answered",
            question: "History question",
            answer: "History answer",
            answeredBy: "Alice",
          },
        },
      ],
    } as unknown as TimelineItem;
    const rendered = await render(
      createElement(renderer!, {
        formatTimestamp: () => "now",
        item,
        labels: defaultChatUiLabels,
      }),
    );
    expect(rendered.container.textContent).toContain("Interaction history");
    expect(rendered.container.textContent).toContain("History question");
    expect(rendered.container.textContent).toContain("History answer");
    expect(rendered.container.textContent).toContain("Alice");
    await rendered.unmount();
  });
});

const createFakeAskUser = (
  entries: readonly AskUserRemoteToolEntry[],
): AskUserRemoteTool =>
  ({
    answer: () => false,
    dispose: () => undefined,
    getSnapshot: () => entries,
    setDraft: () => false,
    subscribe: () => () => undefined,
    tool: {} as never,
  }) as unknown as AskUserRemoteTool;

const legacyEntries = (memory: ReturnType<typeof createMemoryChatGateway>) => {
  const askUserRequest = memory.fixtures.askUserRequest;
  return [
    { deadlineAt: NOW + 30_000, request: askUserRequest },
    {
      deadlineAt: NOW,
      request: askUserRequest,
      result: {
        answers: { "0": "First" },
        kind: "ask-user" as const,
        questions: askUserRequest.questions,
        requestId: askUserRequest.requestId,
        revision: askUserRequest.revision,
        status: "answered" as const,
      },
    },
  ];
};

describe("legacy coexistence", () => {
  it("hides legacy pending sources when an interaction client is injected", async () => {
    const memory = createMemoryChatGateway({
      fixtures: createChatContractFixtures({ answerInteraction: true }),
    });
    const { client: chatClient } = await createLoadedClient(memory);
    const askUser = createFakeAskUser(legacyEntries(memory));
    const { client: interaction, transport } = setup();
    await synchronize(transport);
    await push(
      transport,
      request("inline", {
        conversationId: memory.fixtures.conversation.id,
        question: "Interaction question",
      }),
    );
    const rendered = await render(
      createElement(
        ChatProvider,
        { askUser, client: chatClient },
        createElement(
          InteractionProvider,
          { client: interaction },
          createElement(ChatConversationView, {
            getDeadlineAt: deadlineAt,
            interactionInline: true,
          }),
        ),
      ),
    );
    expect(rendered.container.textContent).toContain("Interaction question");
    expect(rendered.container.textContent).not.toContain("Need your input");
    expect(rendered.container.textContent).toContain("Ask User · answered");
    await rendered.unmount();
    interaction.dispose();
    chatClient.dispose({ deadlineAt: deadlineAt() });
  });

  it("keeps the legacy pending and Gateway paths without a client", async () => {
    const memory = createMemoryChatGateway({
      fixtures: createChatContractFixtures({ answerInteraction: true }),
    });
    const { client: chatClient } = await createLoadedClient(memory);
    const askUser = createFakeAskUser(legacyEntries(memory));
    const rendered = await render(
      createElement(
        ChatProvider,
        { askUser, client: chatClient },
        createElement(ChatConversationView, { getDeadlineAt: deadlineAt }),
      ),
    );
    expect(rendered.container.textContent).toContain("Need your input");
    expect(rendered.container.textContent).toContain("Ask User · answered");
    await rendered.unmount();
    chatClient.dispose({ deadlineAt: deadlineAt() });
  });
});

describe("default workspaces", () => {
  it("renders the active interaction inline in ChatWorkspace", async () => {
    const memory = createMemoryChatGateway();
    const { client: chatClient } = await createLoadedClient(memory);
    const { client: interaction, transport } = setup();
    await synchronize(transport);
    const rendered = await render(
      createElement(
        ChatProvider,
        { client: chatClient },
        createElement(ChatWorkspace, {
          getDeadlineAt: deadlineAt,
          initialSelection: "first",
          interactionClient: interaction,
        }),
      ),
    );
    await act(async () => {
      await flushMicrotasks();
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    });
    await push(
      transport,
      request("inline", {
        conversationId: memory.fixtures.conversation.id,
        question: "Workspace interaction",
      }),
    );
    await act(async () => {
      await flushMicrotasks();
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    });
    const cards = document.querySelectorAll('[data-interaction-id="inline"]');
    expect(cards).toHaveLength(1);
    expect(cards[0]?.closest(".ant-modal")).toBeNull();
    await rendered.unmount();
    interaction.dispose();
    chatClient.dispose({ deadlineAt: deadlineAt() });
  });

  it("uses the global modal while ChatCompactWorkspace is fresh", async () => {
    const memory = createMemoryChatGateway();
    const { client: chatClient } = await createLoadedClient(memory);
    const { client: interaction, transport } = setup();
    await synchronize(transport);
    await push(
      transport,
      request("inline", {
        conversationId: memory.fixtures.conversation.id,
        question: "Compact interaction",
      }),
    );
    const rendered = await render(
      createElement(
        ChatProvider,
        { client: chatClient },
        createElement(ChatCompactWorkspace, {
          getDeadlineAt: deadlineAt,
          interactionClient: interaction,
          locale: "en-US",
        }),
      ),
    );
    const cards = document.querySelectorAll('[data-interaction-id="inline"]');
    expect(cards).toHaveLength(1);
    expect(cards[0]?.closest(".ant-modal")).not.toBeNull();
    await rendered.unmount();
    interaction.dispose();
    chatClient.dispose({ deadlineAt: deadlineAt() });
  });

  it("renders the active interaction inline after ChatCompactWorkspace restores a conversation", async () => {
    const memory = createMemoryChatGateway();
    const { client: chatClient } = await createLoadedClient(memory);
    const { client: interaction, transport } = setup();
    await synchronize(transport);
    const rendered = await render(
      createElement(
        ChatProvider,
        { client: chatClient },
        createElement(ChatCompactWorkspace, {
          getDeadlineAt: deadlineAt,
          interactionClient: interaction,
          locale: "en-US",
          restoredDraft: {
            conversationId: memory.fixtures.conversation.id,
            text: "",
          },
        }),
      ),
    );
    await act(async () => {
      await flushMicrotasks();
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    });
    await push(
      transport,
      request("inline", {
        conversationId: memory.fixtures.conversation.id,
        question: "Compact inline",
      }),
    );
    await act(async () => {
      await flushMicrotasks();
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    });
    const cards = document.querySelectorAll('[data-interaction-id="inline"]');
    expect(cards).toHaveLength(1);
    expect(cards[0]?.closest(".ant-modal")).toBeNull();
    await rendered.unmount();
    interaction.dispose();
    chatClient.dispose({ deadlineAt: deadlineAt() });
  });

  it("does not inherit an outer provider into the default workspace", async () => {
    const memory = createMemoryChatGateway();
    const { client: chatClient } = await createLoadedClient(memory);
    const { client: interaction, transport } = setup();
    await synchronize(transport);
    await push(
      transport,
      request("inline", {
        conversationId: memory.fixtures.conversation.id,
        question: "Outer provider question",
      }),
    );
    const rendered = await render(
      createElement(
        InteractionProvider,
        { client: interaction },
        createElement(
          ChatProvider,
          { client: chatClient },
          createElement(ChatWorkspace, {
            getDeadlineAt: deadlineAt,
            initialSelection: "first",
          }),
          createElement(InteractionQueue, {
            labels: defaultChatUiLabels,
          }),
        ),
      ),
    );
    await act(async () => {
      await flushMicrotasks();
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    });
    const cards = document.querySelectorAll('[data-interaction-id="inline"]');
    expect(cards).toHaveLength(1);
    expect(cards[0]?.closest(".ant-modal")).not.toBeNull();
    await rendered.unmount();
    interaction.dispose();
    chatClient.dispose({ deadlineAt: deadlineAt() });
  });

  it("follows the ChatClient snapshot when the host loads another conversation directly", async () => {
    const memory = createMemoryChatGateway();
    const { client: chatClient } = await createLoadedClient(memory);
    const { client: interaction, transport } = setup();
    await synchronize(transport);
    const source = memory.fixtures.initialSnapshot;
    const rendered = await render(
      createElement(
        ChatProvider,
        { client: chatClient },
        createElement(ChatWorkspace, {
          getDeadlineAt: deadlineAt,
          initialSelection: "first",
          interactionClient: interaction,
        }),
      ),
    );
    await act(async () => {
      await flushMicrotasks();
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    });
    memory.controller.setSnapshot({
      ...source,
      conversation: { ...source.conversation, id: "conversation-b" },
      run: null,
      timeline: [],
    });
    const loaded = await chatClient.loadConversation({
      conversationId: "conversation-b",
      deadlineAt: deadlineAt(),
    });
    expect(loaded.ok).toBe(true);
    await push(
      transport,
      request("inline", {
        conversationId: "conversation-b",
        question: "Direct load question",
      }),
    );
    await act(async () => {
      await flushMicrotasks();
      await new Promise<void>((resolve) => setTimeout(resolve, 300));
    });
    const cards = document.querySelectorAll('[data-interaction-id="inline"]');
    expect(cards).toHaveLength(1);
    expect(cards[0]?.closest(".ant-modal")).toBeNull();
    await rendered.unmount();
    interaction.dispose();
    chatClient.dispose({ deadlineAt: deadlineAt() });
  });

  it("uses the modal when the compact conversation surface is hidden", async () => {
    const memory = createMemoryChatGateway();
    const { client: chatClient } = await createLoadedClient(memory);
    const { client: interaction, transport } = setup();
    await synchronize(transport);
    const rendered = await render(
      createElement(
        ChatProvider,
        { client: chatClient },
        createElement(ChatCompactWorkspace, {
          getDeadlineAt: deadlineAt,
          interactionClient: interaction,
          interactionInlineVisible: false,
          locale: "en-US",
          restoredDraft: {
            conversationId: memory.fixtures.conversation.id,
            text: "",
          },
        }),
      ),
    );
    await push(
      transport,
      request("inline", {
        conversationId: memory.fixtures.conversation.id,
        question: "Hidden surface question",
      }),
    );
    await act(async () => {
      await flushMicrotasks();
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    });
    const cards = document.querySelectorAll('[data-interaction-id="inline"]');
    expect(cards).toHaveLength(1);
    expect(cards[0]?.closest(".ant-modal")).not.toBeNull();
    await rendered.unmount();
    interaction.dispose();
    chatClient.dispose({ deadlineAt: deadlineAt() });
  });
});

describe("custom UI composition", () => {
  it("uses the queue modal when ChatConversationView inline is not opted in", async () => {
    const memory = createMemoryChatGateway();
    const { client: chatClient } = await createLoadedClient(memory);
    const { client: interaction, transport } = setup();
    await synchronize(transport);
    const rendered = await render(
      createElement(
        ChatProvider,
        { client: chatClient },
        createElement(
          InteractionProvider,
          { client: interaction },
          createElement(ChatConversationView, { getDeadlineAt: deadlineAt }),
          createElement(InteractionQueue, {
            labels: defaultChatUiLabels,
          }),
        ),
      ),
    );
    await push(
      transport,
      request("inline", {
        conversationId: memory.fixtures.conversation.id,
        question: "Custom UI question",
      }),
    );
    await act(async () => {
      await flushMicrotasks();
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    });
    const cards = document.querySelectorAll('[data-interaction-id="inline"]');
    expect(cards).toHaveLength(1);
    expect(cards[0]?.closest(".ant-modal")).not.toBeNull();
    await rendered.unmount();
    interaction.dispose();
    chatClient.dispose({ deadlineAt: deadlineAt() });
  });
});
