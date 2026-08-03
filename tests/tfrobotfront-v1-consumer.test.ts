// @vitest-environment jsdom

import { ConfigProvider, theme as antdTheme, type ThemeConfig } from "antd";
import {
  act,
  createContext,
  createElement,
  useContext,
  useEffect,
  type ReactNode,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeAll, describe, expect, it, vi } from "vitest";

import type {
  ChatError,
  ChatGateway,
  ChatUpdate,
  MaybePromise,
} from "../packages/chat-protocol/src/index.js";
import { getTimelineItemKey } from "../packages/chat-protocol/src/index.js";
import {
  OwnedChatProvider,
  useChatClient,
  useChatSnapshot,
  type ChatClientFactory,
} from "../packages/chat-react/src/index.js";
import {
  createChatClient,
  type ChatClient,
} from "../packages/chat-runtime/src/index.js";
import {
  createChatContractFixtures,
  createMemoryChatGateway,
  type ChatContractFixtures,
} from "../packages/chat-testing/src/index.js";
import {
  ChatConversationView,
  ChatStateView,
  ChatTimelineItem,
  createChatRendererRegistry,
  type ChatUiCommandFailure,
} from "../packages/chat-ui-antd/src/index.js";
import { flushMicrotasks } from "./support/chat-react.js";
import { createTFRobotGatewayContractHarness } from "./support/tfrobot-gateway-contract-harness.js";

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

const deadlineAt = (): number => Date.now() + 60_000;
const rendererRegistry = createChatRendererRegistry();

interface FrontSession {
  readonly id: string;
  readonly title: string;
}

interface FrontPlatform {
  readonly id: string;
  readonly label: string;
}

interface FrontHostInputs {
  readonly labels: {
    readonly composerPlaceholder: string;
    readonly send: string;
  };
  readonly onCommandError: (failure: ChatUiCommandFailure) => void;
  readonly onDisposeError: (error: unknown) => void;
  readonly onLoaded: (conversationId: string) => void;
  readonly platform: FrontPlatform;
  readonly selectedSessionId: string;
  readonly sessions: readonly FrontSession[];
  readonly theme: ThemeConfig;
}

interface ControlledGateway {
  readonly gateway: ChatGateway;
  readonly calls: readonly { readonly operation: string }[];
  disconnect(error: ChatError): MaybePromise<number | void>;
  emitUpdate(update: ChatUpdate): MaybePromise<number | void>;
  failNextSend(error: ChatError): MaybePromise<void>;
}

type ControlledGatewayFactory = (
  fixtures: ChatContractFixtures,
) => ControlledGateway;

interface RuntimeInstance {
  readonly client: ChatClient;
  readonly gateway: ControlledGateway;
  readonly notifications: string[];
}

interface RuntimeFactory extends ChatClientFactory {
  readonly instances: RuntimeInstance[];
}

const createMemoryControlledGateway: ControlledGatewayFactory = (fixtures) => {
  const memory = createMemoryChatGateway({ fixtures });
  return {
    gateway: memory.gateway,
    get calls() {
      return memory.controller.calls;
    },
    disconnect: (error) => memory.controller.disconnect(error),
    emitUpdate: (update) => memory.controller.emitUpdateToAll(update),
    failNextSend: (error) => memory.controller.failNext("sendText", error),
  };
};

const createTFRobotControlledGateway: ControlledGatewayFactory = (fixtures) => {
  const harness = createTFRobotGatewayContractHarness(fixtures);
  return {
    gateway: harness.gateway,
    get calls() {
      return harness.controller.calls;
    },
    disconnect: (error) => harness.controller.disconnect(error),
    emitUpdate: (update) => harness.controller.emitUpdate(update),
    failNextSend: (error) => harness.controller.failNext("sendText", error),
  };
};

const createRuntimeFactory = (
  fixtures: ChatContractFixtures,
  createGateway: ControlledGatewayFactory,
): RuntimeFactory => {
  const instances: RuntimeInstance[] = [];
  return {
    instances,
    create() {
      const gateway = createGateway(fixtures);
      const client = createChatClient({ gateway: gateway.gateway });
      const notifications: string[] = [];
      client.subscribe((snapshot) => {
        notifications.push(snapshot?.conversation.id ?? "empty");
      });
      instances.push({ client, gateway, notifications });
      return client;
    },
    getDisposeOptions: () => ({ deadlineAt: deadlineAt() }),
  };
};

const PlatformContext = createContext<FrontPlatform | null>(null);

const HostContextProbe = () => {
  const platform = useContext(PlatformContext);
  const { token } = antdTheme.useToken();
  return createElement(
    "output",
    {
      "data-color-primary": token.colorPrimary,
      "data-platform-id": platform?.id,
    },
    platform?.label,
  );
};

const RuntimeView = ({ host }: { readonly host: FrontHostInputs }) => {
  const client = useChatClient();
  const snapshot = useChatSnapshot();
  const { onLoaded, selectedSessionId } = host;

  useEffect(() => {
    let current = true;
    void client
      .loadConversation({
        conversationId: selectedSessionId,
        deadlineAt: deadlineAt(),
      })
      .then((result) => {
        if (current && result.ok) {
          onLoaded(result.value.conversation.id);
        }
      });
    return () => {
      current = false;
    };
  }, [client, onLoaded, selectedSessionId]);

  return createElement(
    "main",
    { "data-timeline-size": snapshot?.timeline.length ?? 0 },
    createElement(HostContextProbe),
    createElement(
      "aside",
      { "data-testid": "live-runtime-timeline" },
      ...(snapshot?.timeline.map((item) =>
        createElement(ChatTimelineItem, {
          item,
          key: getTimelineItemKey(item),
          registry: rendererRegistry,
        }),
      ) ?? []),
    ),
    snapshot?.error === undefined
      ? null
      : createElement(ChatStateView, {
          labels: host.labels,
          state: {
            description: snapshot.error.message,
            kind: snapshot.error.code === "network" ? "disconnected" : "error",
          },
        }),
    createElement(ChatConversationView, {
      defaultEventDetailMode: "split",
      getDeadlineAt: deadlineAt,
      labels: host.labels,
      onCommandError: host.onCommandError,
    }),
  );
};

const FrontStyleConsumer = ({
  factory,
  host,
}: {
  readonly factory: RuntimeFactory;
  readonly host: FrontHostInputs;
}) =>
  createElement(
    ConfigProvider,
    { theme: host.theme },
    createElement(
      PlatformContext.Provider,
      { value: host.platform },
      createElement(
        "section",
        null,
        createElement(
          "header",
          null,
          host.sessions.find(({ id }) => id === host.selectedSessionId)?.title,
        ),
        createElement(
          OwnedChatProvider,
          {
            factory,
            fallback: createElement("p", null, "Starting Kit path"),
            onDisposeError: host.onDisposeError,
          },
          createElement(RuntimeView, { host }),
        ),
      ),
    ),
  );

interface DomRender {
  readonly container: HTMLDivElement;
  readonly root: Root;
  render(node: ReactNode): Promise<void>;
  unmount(): Promise<void>;
}

const renderInDom = async (node: ReactNode): Promise<DomRender> => {
  const container = document.createElement("div");
  container.style.height = "640px";
  document.body.append(container);
  const root = createRoot(container);
  const previous = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const render = async (next: ReactNode): Promise<void> => {
    await act(async () => {
      root.render(next);
      await flushMicrotasks();
    });
  };
  await render(node);
  return {
    container,
    root,
    render,
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

const waitForText = async (
  container: HTMLElement,
  text: string,
): Promise<void> => {
  await vi.waitFor(() => {
    expect(container.textContent).toContain(text);
  });
};

const gatewayCases = [
  ["memory", createMemoryControlledGateway],
  ["controlled TFRobot", createTFRobotControlledGateway],
] as const;

describe("TFRobotFront-style V1 consumer", () => {
  it.each(gatewayCases)(
    "runs the public React/Runtime slice with the %s Gateway",
    async (_name, createGateway) => {
      const firstFixtures = createChatContractFixtures({
        conversationId: "front-session-a",
      });
      const secondFixtures = createChatContractFixtures({
        baseTimestamp: 1_773_705_700_000,
        conversationId: "front-session-b",
      });
      const firstFactory = createRuntimeFactory(firstFixtures, createGateway);
      const secondFactory = createRuntimeFactory(secondFixtures, createGateway);
      const commandFailures: ChatUiCommandFailure[] = [];
      const disposeErrors: unknown[] = [];
      const loaded: string[] = [];
      const sessions = [
        { id: firstFixtures.conversation.id, title: "Session A" },
        { id: secondFixtures.conversation.id, title: "Session B" },
      ];
      const hostFor = (selectedSessionId: string): FrontHostInputs => ({
        labels: {
          composerPlaceholder: "Ask through the Kit",
          send: "Send through Kit",
        },
        onCommandError: (failure) => {
          commandFailures.push(failure);
        },
        onDisposeError: (error) => {
          disposeErrors.push(error);
        },
        onLoaded: (conversationId) => {
          loaded.push(conversationId);
        },
        platform: { id: "platform-front", label: "Front platform" },
        selectedSessionId,
        sessions,
        theme: { token: { colorPrimary: "#1677ff", motion: false } },
      });
      const firstHost = hostFor(firstFixtures.conversation.id);
      const rendered = await renderInDom(
        createElement(FrontStyleConsumer, {
          factory: firstFactory,
          host: firstHost,
        }),
      );

      try {
        await waitForText(rendered.container, "Initial message");
        expect(loaded).toEqual([firstFixtures.conversation.id]);
        expect(rendered.container.textContent).toContain("Session A");
        expect(rendered.container.textContent).toContain("Front platform");
        expect(
          rendered.container
            .querySelector("output")
            ?.getAttribute("data-platform-id"),
        ).toBe("platform-front");
        expect(
          rendered.container
            .querySelector("output")
            ?.getAttribute("data-color-primary"),
        ).toBe("#1677ff");
        expect(
          rendered.container.querySelector<HTMLTextAreaElement>(
            'textarea[aria-label="Message"]',
          )?.placeholder,
        ).toBe("Ask through the Kit");

        const firstInstance = firstFactory.instances[0]!;
        const firstNotificationCount = firstInstance.notifications.length;
        const secondHost = hostFor(secondFixtures.conversation.id);
        await rendered.render(
          createElement(FrontStyleConsumer, {
            factory: secondFactory,
            host: secondHost,
          }),
        );
        await waitForText(rendered.container, "Session B");
        await vi.waitFor(() => {
          expect(firstInstance.client.disposed).toBe(true);
          expect(loaded).toEqual([
            firstFixtures.conversation.id,
            secondFixtures.conversation.id,
          ]);
        });
        expect(
          await firstInstance.gateway.emitUpdate(
            firstFixtures.realtimeMessageUpdate,
          ),
        ).toBe(0);
        expect(firstInstance.notifications).toHaveLength(
          firstNotificationCount,
        );

        const secondInstance = secondFactory.instances[0]!;
        await act(async () => {
          await secondInstance.gateway.emitUpdate(
            secondFixtures.realtimeMessageUpdate,
          );
          await flushMicrotasks();
        });
        await vi.waitFor(() => {
          expect(
            secondInstance.client
              .getSnapshot()
              ?.timeline.some(
                (item) =>
                  item.kind === "message" &&
                  item.content.kind === "text" &&
                  item.content.text === "Realtime response",
              ),
          ).toBe(true);
        });
        await waitForText(rendered.container, "Realtime response");
        expect(
          rendered.container.querySelector(
            '[data-testid="live-runtime-timeline"]',
          )?.textContent,
        ).toContain("Realtime response");

        await act(async () => {
          await secondInstance.gateway.emitUpdate(
            secondFixtures.unknownEventUpdate,
          );
          await flushMicrotasks();
        });
        await waitForText(rendered.container, "Unknown event:");
        expect(
          rendered.container.querySelector(
            '[data-testid="live-runtime-timeline"]',
          )?.textContent,
        ).toContain("Unknown event:");
        await setComposerText(rendered.container, "Hello from Front UI");
        await clickButton(rendered.container, "Send through Kit");
        await clickButton(rendered.container, "Stop");
        expect(
          secondInstance.gateway.calls.some(
            ({ operation }) => operation === "sendText",
          ),
        ).toBe(true);
        expect(
          secondInstance.gateway.calls.some(
            ({ operation }) => operation === "interrupt",
          ),
        ).toBe(true);

        await secondInstance.gateway.failNextSend({
          code: "server",
          conversationId: secondFixtures.conversation.id,
          message: "Controlled send failure",
          retryable: true,
        });
        await setComposerText(rendered.container, "Fail safely");
        await clickButton(rendered.container, "Send through Kit");
        expect(commandFailures).toMatchObject([
          { command: "sendText", error: { code: "server" } },
        ]);

        await act(async () => {
          await secondInstance.gateway.disconnect(
            secondFixtures.disconnectError,
          );
          await flushMicrotasks();
        });
        expect(secondInstance.client.getSnapshot()?.error).toMatchObject({
          code: secondFixtures.disconnectError.code,
        });
        await waitForText(
          rendered.container,
          secondFixtures.disconnectError.message,
        );
      } finally {
        const secondInstance = secondFactory.instances[0];
        const notificationCount = secondInstance?.notifications.length ?? 0;
        await rendered.unmount();
        if (secondInstance !== undefined) {
          expect(secondInstance.client.disposed).toBe(true);
          expect(
            await secondInstance.gateway.emitUpdate(
              secondFixtures.realtimeMessageUpdate,
            ),
          ).toBe(0);
          expect(secondInstance.notifications).toHaveLength(notificationCount);
        }
        expect(disposeErrors).toEqual([]);
      }
    },
  );

  it("renders capability absence without dispatching unavailable commands", async () => {
    const fixtures = createChatContractFixtures({
      conversationId: "front-limited-session",
    });
    const limitedSnapshot = {
      ...fixtures.initialSnapshot,
      capabilities: {
        ...fixtures.initialSnapshot.capabilities,
        interrupt: false,
        sendText: false,
      },
    };
    const limitedFixtures: ChatContractFixtures = {
      ...fixtures,
      initialSnapshot: limitedSnapshot,
    };
    const factory = createRuntimeFactory(
      limitedFixtures,
      createMemoryControlledGateway,
    );
    const host: FrontHostInputs = {
      labels: {
        composerPlaceholder: "Unavailable composer",
        send: "Unavailable send",
      },
      onCommandError: () => undefined,
      onDisposeError: () => undefined,
      onLoaded: () => undefined,
      platform: { id: "limited", label: "Limited platform" },
      selectedSessionId: fixtures.conversation.id,
      sessions: [{ id: fixtures.conversation.id, title: "Limited session" }],
      theme: { token: { colorPrimary: "#1677ff", motion: false } },
    };
    const rendered = await renderInDom(
      createElement(FrontStyleConsumer, { factory, host }),
    );
    try {
      await waitForText(rendered.container, "Text sending is unavailable.");
      expect(
        rendered.container.querySelector<HTMLTextAreaElement>(
          'textarea[aria-label="Message"]',
        )?.disabled,
      ).toBe(true);
      expect(rendered.container.textContent).toContain("Stop unavailable");
      expect(
        factory.instances[0]?.gateway.calls.filter(
          ({ operation }) =>
            operation === "sendText" || operation === "interrupt",
        ),
      ).toHaveLength(0);
    } finally {
      await rendered.unmount();
    }
  });
});
