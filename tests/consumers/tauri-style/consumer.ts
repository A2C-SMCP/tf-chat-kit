import { JSDOM } from "jsdom";
import {
  StrictMode,
  act,
  createContext,
  createElement,
  useContext,
  type ReactElement,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import { ConfigProvider } from "antd";

import {
  ChatProvider,
  ChatResourceProvider,
  ChatResourceError,
  ChatResourceView,
  ChatDocumentSourceProvider,
  ChatTimelineItem,
  createChatRendererRegistry,
  appendComposerReference,
  type ChatResourcePort,
  type TimelineItem,
  OwnedChatProvider,
  ChatRunStatus,
  ChatWorkspace,
  createChatClient,
  createTFRobotChatGateway,
  useChatClient,
  useChatSnapshot,
  type ChatClient,
  type ChatClientFactory,
  type ChatEventDetailMode,
} from "@turingfocus/chat-kit";
import {
  createChatContractFixtures,
  createMemoryChatGateway,
  type ChatContractFixtures,
  type MemoryGatewayHarness,
} from "@turingfocus/chat-testing";

const check = (condition: unknown, message: string): void => {
  if (!condition) throw new Error(message);
};

const deadlineAt = (): number => Date.now() + 60_000;
const eventDetailMode: ChatEventDetailMode = "split";

const flushMicrotasks = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

interface TauriPlatformPort {
  readonly windowLabel: string;
  openExternal(url: string): Promise<void>;
  saveFile(name: string, content: Uint8Array): Promise<void>;
  updateTray(label: string): Promise<void>;
}

interface TauriRuntimeInstance {
  readonly client: ChatClient;
  readonly gateway: MemoryGatewayHarness;
}

interface TauriRuntimeFactory extends ChatClientFactory {
  readonly instances: TauriRuntimeInstance[];
}

interface TauriHostFixture {
  readonly commandResults: string[];
  readonly disposeErrors: unknown[];
  readonly factory: TauriRuntimeFactory;
  readonly fixtures: ChatContractFixtures;
  readonly platformCalls: string[];
  readonly platformPort: TauriPlatformPort;
  readonly renderedConversationIds: string[];
}

const createTauriHostFixture = (): TauriHostFixture => {
  const fixtures = createChatContractFixtures({
    conversationId: "tauri-conversation",
  });
  const commandResults: string[] = [];
  const disposeErrors: unknown[] = [];
  const instances: TauriRuntimeInstance[] = [];
  const platformCalls: string[] = [];
  const renderedConversationIds: string[] = [];
  const platformPort: TauriPlatformPort = {
    windowLabel: "main",
    async openExternal(url) {
      platformCalls.push(`open:${url}`);
    },
    async saveFile(name, content) {
      platformCalls.push(`save:${name}:${content.byteLength}`);
    },
    async updateTray(label) {
      platformCalls.push(`tray:${label}`);
    },
  };
  const factory: TauriRuntimeFactory = {
    instances,
    create() {
      const gateway = createMemoryChatGateway({ fixtures });
      const client = createChatClient({ gateway: gateway.gateway });
      instances.push({ client, gateway });
      return client;
    },
    getDisposeOptions: () => ({ deadlineAt: deadlineAt() }),
  };
  return {
    commandResults,
    disposeErrors,
    factory,
    fixtures,
    platformCalls,
    platformPort,
    renderedConversationIds,
  };
};

const TauriPlatformContext = createContext<TauriPlatformPort | null>(null);

const useTauriPlatform = (): TauriPlatformPort => {
  const platform = useContext(TauriPlatformContext);
  if (platform === null) {
    throw new Error("TauriPlatformProvider is required");
  }
  return platform;
};

const TauriRuntimeView = ({
  fixture,
}: {
  readonly fixture: TauriHostFixture;
}) => {
  const client = useChatClient();
  const snapshot = useChatSnapshot();
  const platform = useTauriPlatform();
  const conversationId = snapshot?.conversation.id ?? "empty";
  fixture.renderedConversationIds.push(conversationId);

  const platformActions = createElement(
    "nav",
    { "aria-label": "Tauri platform actions" },
    createElement(
      "button",
      {
        onClick: () => {
          void platform.openExternal("https://example.test/help");
        },
        type: "button",
      },
      "Open Tauri help",
    ),
    createElement(
      "button",
      {
        onClick: () => {
          void platform.saveFile(
            "transcript.txt",
            new TextEncoder().encode("safe transcript"),
          );
        },
        type: "button",
      },
      "Save Tauri transcript",
    ),
    createElement(
      "button",
      {
        onClick: () => {
          void platform.updateTray("Chat ready");
        },
        type: "button",
      },
      "Update Tauri tray",
    ),
  );

  return createElement(
    "div",
    {
      "data-conversation-id": conversationId,
      "data-window-label": platform.windowLabel,
    },
    createElement(ChatWorkspace, {
      conversationViewProps: {
        defaultEventDetailMode: eventDetailMode,
        defaultEventDetailSplitRatio: 0.6,
      },
      getDeadlineAt: deadlineAt,
      header: createElement(
        "section",
        null,
        platformActions,
        createElement(ChatRunStatus, {
          canInterrupt: snapshot?.capabilities.interrupt ?? false,
          labels: {
            interrupt: "Stop Tauri run",
            interrupting: "Stopping Tauri run",
          },
          onInterrupt: async () => {
            if (snapshot === null) return false;
            const result = await client.interrupt({
              conversationId: snapshot.conversation.id,
              deadlineAt: deadlineAt(),
            });
            fixture.commandResults.push(`interrupt:${result.ok}`);
            return result.ok;
          },
          run: snapshot?.run ?? null,
        }),
        createElement(
          "output",
          null,
          snapshot?.conversation.title ?? "No conversation",
        ),
        createElement(
          "output",
          { "data-timeline-size": snapshot?.timeline.length ?? 0 },
          `${snapshot?.timeline.length ?? 0} timeline items`,
        ),
        createElement(
          "button",
          {
            disabled: snapshot === null,
            onClick: () => {
              if (snapshot === null) return;
              void client
                .sendText({
                  conversationId: snapshot.conversation.id,
                  deadlineAt: deadlineAt(),
                  text: "Tauri message",
                })
                .then((result) => {
                  fixture.commandResults.push(`send:${result.ok}`);
                });
            },
            type: "button",
          },
          "Send from Tauri host",
        ),
      ),
      labels: {
        interrupt: "Stop managed chat run",
        interrupting: "Stopping managed chat run",
      },
    }),
  );
};

const TauriStyleConsumer = ({
  fixture,
}: {
  readonly fixture: TauriHostFixture;
}): ReactElement =>
  createElement(
    ConfigProvider,
    {
      theme: { token: { colorPrimary: "#1677ff", motion: false } },
      virtual: false,
      wave: { disabled: true },
    },
    createElement(
      TauriPlatformContext.Provider,
      { value: fixture.platformPort },
      createElement(
        OwnedChatProvider,
        {
          factory: fixture.factory,
          fallback: createElement("output", null, "Starting desktop chat"),
          onDisposeError: (error: unknown) => {
            fixture.disposeErrors.push(error);
          },
        },
        createElement(TauriRuntimeView, { fixture }),
      ),
    ),
  );

interface DomEnvironment {
  readonly container: HTMLDivElement;
  readonly root: Root;
  cleanup(): void;
}

const installDomEnvironment = (): DomEnvironment => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "https://tauri.local/",
  });
  const matchMedia = (query: string): MediaQueryList =>
    ({
      addEventListener: () => undefined,
      addListener: () => undefined,
      dispatchEvent: () => false,
      matches: false,
      media: query,
      onchange: null,
      removeEventListener: () => undefined,
      removeListener: () => undefined,
    }) as MediaQueryList;
  Object.defineProperty(dom.window, "matchMedia", {
    configurable: true,
    value: matchMedia,
  });

  const globalValues: Readonly<Record<string, unknown>> = {
    document: dom.window.document,
    Element: dom.window.Element,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
    MutationObserver: dom.window.MutationObserver,
    navigator: dom.window.navigator,
    Node: dom.window.Node,
    ShadowRoot: dom.window.ShadowRoot,
    SVGElement: dom.window.SVGElement,
    window: dom.window,
  };
  const previousValues = Object.entries(globalValues).map(([key, value]) => {
    const previous = Reflect.get(globalThis, key);
    const existed = Object.hasOwn(globalThis, key);
    Reflect.set(globalThis, key, value);
    return { existed, key, previous };
  });
  const container = dom.window.document.createElement("div");
  container.style.height = "640px";
  dom.window.document.body.append(container);
  const root = createRoot(container);

  return {
    container,
    root,
    cleanup() {
      container.remove();
      for (const { existed, key, previous } of previousValues.reverse()) {
        if (existed) {
          Reflect.set(globalThis, key, previous);
        } else {
          Reflect.deleteProperty(globalThis, key);
        }
      }
      dom.window.close();
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

const verifyLargeToolHistory = async (): Promise<void> => {
  const gateway = createTFRobotChatGateway({
    baseUrl: "https://tauri-contract.example/",
    serverProfile: { kind: "current-server" },
    sessionProvider: {
      getSession: () => ({ kind: "bearer", token: "tauri-session" }),
    },
    messageCreatorProvider: () => ({ uid: "tauri-user", name: "Tauri user" }),
    fetch: async (input) =>
      new Response(
        JSON.stringify({
          code: 200,
          message: "Success",
          data: new URL(String(input)).pathname.endsWith("/status")
            ? { working: false }
            : {
                messages: [],
                events: [
                  {
                    conversationId: 10,
                    eventId: "large-tool",
                    eventScene: "Tool",
                    status: "success",
                    createTimestamp: 1,
                    content: {
                      toolReturn: {
                        origin: "x".repeat(551_510),
                        meta: { success: true },
                      },
                    },
                  },
                ],
              },
        }),
      ),
  });
  try {
    const result = await gateway.loadConversation({
      conversationId: "10",
      deadlineAt: deadlineAt(),
    });
    check(
      result.ok,
      "Tauri packed Gateway must load a history containing a 551510-character tool result",
    );
    if (!result.ok) return;
    const event = result.value.timeline[0];
    check(
      event?.kind === "agent-event" &&
        event.eventCategory === "tool" &&
        event.transitions[0]?.toolReturn?.success === true &&
        event.transitions[0]?.toolReturn?.result ===
          "[Tool result omitted: exceeds safe display size or structure limits]",
      "oversized tool details must explain omission while preserving the successful event",
    );
  } finally {
    await gateway.dispose({ deadlineAt: deadlineAt() });
  }
};

const verifyIndependentParityConsumer = async (): Promise<void> => {
  const dom = installDomEnvironment();
  const memory = createMemoryChatGateway();
  const client = createChatClient({ gateway: memory.gateway });
  let releases = 0;
  const resources: ChatResourcePort = {
    resolve: ({ resource }) => ({
      url: resource.uri.startsWith("s3:")
        ? "https://example.test/screenshot.png"
        : resource.uri,
      dispose: () => {
        releases += 1;
      },
    }),
  };
  try {
    await client.loadConversation({
      conversationId: memory.fixtures.conversation.id,
      deadlineAt: deadlineAt(),
    });
    const item: TimelineItem = {
      kind: "agent-event",
      id: "packed-browser",
      conversationId: memory.fixtures.conversation.id,
      eventCategory: "tool",
      eventType: "Tool",
      status: "success",
      createdAt: 1,
      transitions: [
        {
          id: "one",
          status: "success",
          occurredAt: 1,
          toolReturn: {
            result: "retained origin",
            presentation: {
              kind: "browser",
              markdown: "# Independent browser result",
              image: { uri: "s3://private/screenshot" },
            },
          },
        },
      ],
    };
    memory.controller.emitUpdateToAll({
      kind: "timeline.upsert",
      conversationId: item.conversationId,
      item,
    });
    const runtimeItem = client
      .getSnapshot()
      ?.timeline.find((entry) => entry.id === item.id);
    check(
      runtimeItem !== undefined,
      "Packed Runtime lost standard presentation",
    );
    if (runtimeItem === undefined) return;
    await act(async () => {
      dom.root.render(
        createElement(
          ChatProvider,
          { client },
          createElement(
            ChatResourceProvider,
            { port: resources, scope: "account-a" },
            createElement(
              ChatDocumentSourceProvider,
              {
                source: {
                  list: () => [
                    {
                      id: "doc",
                      title: "Handbook",
                      content: "Authorized full text",
                    },
                  ],
                },
              },
              createElement(ChatTimelineItem, {
                item: runtimeItem,
                registry: createChatRendererRegistry(),
              }),
            ),
          ),
        ),
      );
      await flushMicrotasks();
    });
    check(
      dom.container.textContent?.includes("Independent browser result"),
      "Packed default Browser renderer failed",
    );
    check(
      dom.container.querySelector("img")?.getAttribute("src") ===
        "https://example.test/screenshot.png",
      "Packed private resource resolver failed",
    );
    let resourceAttempt = 0;
    const translatedResources: ChatResourcePort = {
      resolve: () => {
        if (++resourceAttempt === 1) throw new ChatResourceError("expired");
        return { url: "https://example.test/recovered.png" };
      },
    };
    await act(async () => {
      dom.root.render(
        createElement(
          ChatResourceProvider,
          { port: translatedResources },
          createElement(ChatResourceView, {
            kind: "image",
            resource: { uri: "private:packed" },
            labels: {
              resource: {
                expired: "链接已过期",
                retry: "重新加载",
                download: "下载",
              },
            },
          }),
        ),
      );
      await flushMicrotasks();
    });
    check(
      dom.container.textContent?.includes("链接已过期"),
      "Packed resource error translation missing",
    );
    await act(async () => {
      const retry = Array.from(dom.container.querySelectorAll("button")).find(
        (button) => button.textContent === "重新加载",
      );
      check(retry, "Packed resource retry missing");
      retry?.click();
      await flushMicrotasks();
    });
    check(
      dom.container.querySelector("img")?.getAttribute("src") ===
        "https://example.test/recovered.png",
      "Packed resource retry did not recover",
    );
    const current = client.getComposerDraft(item.conversationId);
    client.setComposerDraft({
      conversationId: item.conversationId,
      ...appendComposerReference(
        current,
        { id: "doc", title: "Handbook", content: "Authorized full text" },
        "packed-reference",
      ),
    });
    await client.sendComposerDraft({
      conversationId: item.conversationId,
      deadlineAt: deadlineAt(),
    });
    check(
      memory.controller.calls.some(
        (call) =>
          call.operation === "sendText" &&
          call.input.text === "Handbook\nAuthorized full text",
      ),
      "Packed reference did not expand before sending",
    );
  } finally {
    await act(async () => {
      dom.root.unmount();
      await flushMicrotasks();
    });
    await client.dispose({ deadlineAt: deadlineAt() });
    dom.cleanup();
  }
  check(releases > 0, "Packed resource lease was not disposed");
};

export const runTauriConsumerVerification = async (): Promise<void> => {
  await verifyIndependentParityConsumer();
  await verifyLargeToolHistory();
  const fixture = createTauriHostFixture();
  const dom = installDomEnvironment();
  let instance: TauriRuntimeInstance | undefined;
  let unmounted = false;

  try {
    check(
      fixture.factory.instances.length === 0 &&
        fixture.platformCalls.length === 0,
      "render composition must not create clients or call platform APIs",
    );

    await act(async () => {
      dom.root.render(
        createElement(
          StrictMode,
          null,
          createElement(TauriStyleConsumer, { fixture }),
        ),
      );
      await flushMicrotasks();
    });
    const rehearsalInstance = fixture.factory.instances[0];
    instance = fixture.factory.instances[1];
    check(
      fixture.factory.instances.length === 2,
      "Tauri StrictMode must replay the provider effect with one fresh client",
    );
    if (rehearsalInstance === undefined) {
      throw new Error("Tauri StrictMode rehearsal client was not created");
    }
    if (instance === undefined) throw new Error("Tauri client was not created");
    check(
      rehearsalInstance.client.disposed &&
        rehearsalInstance.gateway.controller.disposed &&
        !instance.client.disposed &&
        !instance.gateway.controller.disposed,
      "Tauri StrictMode must fully dispose its rehearsal client before using the active client",
    );

    await act(async () => {
      await flushMicrotasks();
    });
    check(
      instance.client.getSnapshot()?.conversation.id ===
        fixture.fixtures.conversation.id,
      "the managed Tauri workspace must load and select its first conversation",
    );
    check(
      fixture.renderedConversationIds.includes(
        fixture.fixtures.conversation.id,
      ) &&
        dom.container
          .querySelector('[data-window-label="main"]')
          ?.getAttribute("data-conversation-id") ===
          fixture.fixtures.conversation.id &&
        dom.container.textContent?.includes(
          fixture.fixtures.conversation.title,
        ) === true &&
        dom.container.textContent?.includes("1 timeline items") === true,
      "the mounted Ant Design shell must render the loaded Runtime snapshot inside the Tauri topology",
    );
    check(
      dom.container
        .querySelector('[role="separator"]')
        ?.getAttribute("aria-valuenow") === "60",
      "the packed Tauri consumer must apply the public uncontrolled split-ratio API",
    );

    await act(async () => {
      instance!.gateway.controller.emitUpdateToAll(
        fixture.fixtures.realtimeMessageUpdate,
      );
      await flushMicrotasks();
    });
    check(
      dom.container.textContent?.includes("2 timeline items") === true,
      "the mounted Ant Design shell must observe subscribed Runtime updates",
    );

    await act(async () => {
      for (const update of fixture.fixtures.outOfOrderEventUpdates) {
        instance!.gateway.controller.emitUpdateToAll(update);
      }
      await flushMicrotasks();
    });
    const eventTrigger = dom.container.querySelector<HTMLElement>(
      '[data-chat-event-trigger="event-out-of-order"]',
    );
    check(
      eventTrigger !== undefined,
      "the packed Tauri consumer must render a compact public event row",
    );
    await act(async () => {
      eventTrigger!.click();
      await flushMicrotasks();
    });
    check(
      dom.container
        .querySelector('[data-chat-event-detail=""]')
        ?.textContent?.includes("contract-step") === true,
      "the packed Tauri consumer must open the public split event detail",
    );

    await clickButton(dom.container, "Send from Tauri host");
    await clickButton(dom.container, "Stop Tauri run");
    check(
      fixture.commandResults.join(",") === "send:true,interrupt:true" &&
        instance.gateway.controller.calls.some(
          ({ operation }) => operation === "sendText",
        ) &&
        instance.gateway.controller.calls.some(
          ({ operation }) => operation === "interrupt",
        ),
      "the mounted desktop topology must complete send and public UI interrupt commands",
    );

    await clickButton(dom.container, "Open Tauri help");
    await clickButton(dom.container, "Save Tauri transcript");
    await clickButton(dom.container, "Update Tauri tray");
    check(
      fixture.platformCalls.join(",") ===
        "open:https://example.test/help,save:transcript.txt:15,tray:Chat ready",
      "mounted host controls must reach only the host-owned narrow Tauri port",
    );

    const notificationsBeforeUnmount: number[] = [];
    const subscription = instance.client.subscribe((snapshot) => {
      notificationsBeforeUnmount.push(snapshot.timeline.length);
    });
    await act(async () => {
      dom.root.unmount();
      await flushMicrotasks();
    });
    unmounted = true;
    check(
      instance.client.disposed,
      "Tauri unmount must initiate disposal of its provider-owned client",
    );
    await instance.client.dispose({ deadlineAt: deadlineAt() });
    check(
      fixture.factory.instances.every(
        ({ client, gateway }) => client.disposed && gateway.controller.disposed,
      ),
      "Tauri unmount must fully dispose every replayed and active client and gateway",
    );
    const notificationCount = notificationsBeforeUnmount.length;
    const lateDeliveryCount = instance.gateway.controller.emitUpdateToAll(
      fixture.fixtures.unknownEventUpdate,
    );
    check(
      lateDeliveryCount === 0 &&
        notificationsBeforeUnmount.length === notificationCount,
      "the disposed Tauri gateway must have no live observers or late notifications",
    );
    check(
      fixture.disposeErrors.length === 0,
      "Tauri provider disposal must complete without hidden cleanup errors",
    );
    subscription.dispose();
  } finally {
    if (!unmounted) {
      await act(async () => {
        dom.root.unmount();
        await flushMicrotasks();
      });
      if (instance !== undefined) {
        await instance.client.dispose({ deadlineAt: deadlineAt() });
      }
    }
    dom.cleanup();
  }
};
