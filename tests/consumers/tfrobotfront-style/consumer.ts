import { ConfigProvider, theme as antdTheme, type ThemeConfig } from "antd";
import { createElement, useEffect, useMemo, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import {
  createTFRobotChatGateway,
  type TFRobotMessageCreatorProvider,
  type TFRobotSession,
  type TFRobotSocket,
  type TFRobotSocketAnyListener,
  type TFRobotSocketFactory,
  type TFRobotSocketFactoryInput,
  type TFRobotSocketListener,
} from "@turingfocus/chat-gateway-tfrobot";
import type { ChatError, SessionProvider } from "@turingfocus/chat-protocol";
import {
  OwnedChatProvider,
  useChatClient,
  type ChatClientFactory,
} from "@turingfocus/chat-react";
import {
  createChatClient,
  type ChatClient,
  type ChatClientUnhandledError,
} from "@turingfocus/chat-runtime";
import { ChatStateView } from "@turingfocus/chat-ui-antd";

const check = (condition: unknown, message: string): void => {
  if (!condition) throw new Error(message);
};

const deadlineAt = (): number => Date.now() + 60_000;

const flushMicrotasks = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

const envelope = (data: unknown): Response =>
  new Response(JSON.stringify({ code: 200, message: "Success", data }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

class ControlledSocket implements TFRobotSocket {
  connected = false;
  readonly auth: Array<
    Awaited<ReturnType<TFRobotSocketFactoryInput["getAuth"]>>
  > = [];
  readonly emitted: Array<readonly [string, unknown]> = [];
  readonly #anyListeners = new Set<TFRobotSocketAnyListener>();
  readonly #input: TFRobotSocketFactoryInput;
  readonly #listeners = new Map<string, Set<TFRobotSocketListener>>();

  constructor(input: TFRobotSocketFactoryInput) {
    this.#input = input;
  }

  connect(): void {
    void this.#input.getAuth().then((auth) => {
      this.auth.push(auth);
      this.connected = true;
      this.#trigger("connect");
    });
  }

  disconnect(): void {
    this.connected = false;
  }

  emit(eventName: string, payload?: unknown): void {
    this.emitted.push([eventName, payload]);
  }

  off(eventName: string, listener: TFRobotSocketListener): void {
    this.#listeners.get(eventName)?.delete(listener);
  }

  offAny(listener: TFRobotSocketAnyListener): void {
    this.#anyListeners.delete(listener);
  }

  on(eventName: string, listener: TFRobotSocketListener): void {
    const listeners =
      this.#listeners.get(eventName) ?? new Set<TFRobotSocketListener>();
    listeners.add(listener);
    this.#listeners.set(eventName, listeners);
  }

  onAny(listener: TFRobotSocketAnyListener): void {
    this.#anyListeners.add(listener);
  }

  trigger(eventName: string, payload?: unknown): void {
    this.#trigger(eventName, payload);
  }

  #trigger(eventName: string, payload?: unknown): void {
    for (const listener of this.#listeners.get(eventName) ?? []) {
      listener(payload);
    }
    for (const listener of this.#anyListeners) {
      listener(eventName, payload);
    }
  }
}

interface HostCallbacks {
  readonly getMessageCreator: TFRobotMessageCreatorProvider;
  readonly onDiagnostic: (error: ChatError) => void;
  readonly onDisposeError: (error: unknown) => void;
  readonly onUnhandledError: (failure: ChatClientUnhandledError) => void;
}

interface HostEndpoints {
  readonly apiBaseUrl: string;
  readonly socketNamespaceUrl: string;
  readonly socketPath: string;
}

export interface HostClientOptions {
  readonly callbacks: HostCallbacks;
  readonly endpoints: HostEndpoints;
  readonly fetch: typeof globalThis.fetch;
  readonly getDisposeDeadlineAt: () => number;
  readonly platformId: string;
  readonly sessionProvider: SessionProvider<TFRobotSession>;
  readonly socketFactory: TFRobotSocketFactory;
  readonly theme: ThemeConfig;
  readonly uiReadyLabel: string;
}

interface HostProbe {
  readonly clients: ChatClient[];
  captureClient(client: ChatClient): void;
}

export const createHostChatClientFactory = (
  options: HostClientOptions,
  onCreate: (client: ChatClient) => void,
): ChatClientFactory => ({
  create() {
    const gateway = createTFRobotChatGateway({
      baseUrl: options.endpoints.apiBaseUrl,
      messageCreatorProvider: options.callbacks.getMessageCreator,
      onDiagnostic: options.callbacks.onDiagnostic,
      platformId: options.platformId,
      sessionProvider: options.sessionProvider,
      socketFactory: options.socketFactory,
      socketNamespaceUrl: options.endpoints.socketNamespaceUrl,
      socketPath: options.endpoints.socketPath,
      fetch: options.fetch,
    });
    const client = createChatClient({
      gateway,
      onUnhandledError: options.callbacks.onUnhandledError,
    });
    onCreate(client);
    return client;
  },
  getDisposeOptions: () => ({ deadlineAt: options.getDisposeDeadlineAt() }),
});

const ConsumerProbe = ({ probe }: { readonly probe: HostProbe }) => {
  const client = useChatClient();

  useEffect(() => {
    probe.captureClient(client);
  }, [client, probe]);

  return createElement("span", null, "ready");
};

const HostBoundary = ({
  options,
  probe,
}: {
  readonly options: HostClientOptions;
  readonly probe: HostProbe;
}): ReactElement => {
  const factory = useMemo(
    () =>
      createHostChatClientFactory(options, (client) => {
        probe.captureClient(client);
      }),
    [options, probe],
  );

  return createElement(
    OwnedChatProvider,
    {
      factory,
      fallback: createElement("span", null, "waiting"),
      onDisposeError: options.callbacks.onDisposeError,
    },
    createElement(ConsumerProbe, { probe }),
  );
};

const PackedHostUi = ({ options }: { readonly options: HostClientOptions }) => {
  const { token } = antdTheme.useToken();
  return createElement(
    "section",
    { "data-color-primary": token.colorPrimary },
    createElement(ChatStateView, {
      state: {
        description: "Rendered from the packed public UI package",
        kind: "empty",
        title: options.uiReadyLabel,
      },
    }),
  );
};

interface HostFixture {
  readonly authReads: string[];
  readonly diagnostics: ChatError[];
  readonly disposeErrors: unknown[];
  readonly expectedAuthorization: string;
  readonly expectedColor: string;
  readonly expectedSessionToken: string;
  readonly messageCreatorReads: string[];
  readonly options: HostClientOptions;
  readonly probe: HostProbe;
  readonly requests: Request[];
  readonly sockets: ControlledSocket[];
  readonly socketInputs: TFRobotSocketFactoryInput[];
  readonly unhandledErrors: ChatClientUnhandledError[];
}

const createHostFixture = (id: string, color: string): HostFixture => {
  const authReads: string[] = [];
  const diagnostics: ChatError[] = [];
  const disposeErrors: unknown[] = [];
  const messageCreatorReads: string[] = [];
  const requests: Request[] = [];
  const sockets: ControlledSocket[] = [];
  const socketInputs: TFRobotSocketFactoryInput[] = [];
  const unhandledErrors: ChatClientUnhandledError[] = [];
  const clients: ChatClient[] = [];
  const sessionValue = ["test", id, "session"].join("-");
  const expectedAuthorization = `Bearer ${sessionValue}`;
  const sessionProvider: SessionProvider<TFRobotSession> = {
    getSession: () => {
      authReads.push(id);
      return { kind: "bearer", token: sessionValue };
    },
    onSessionInvalid: () => undefined,
  };
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    requests.push(request);
    const url = new URL(request.url);
    const conversationId = url.pathname.split("/").filter(Boolean).at(-2);
    if (request.method === "GET" && url.pathname.endsWith("/conversations")) {
      return envelope({
        conversations: [
          {
            conversationId: id,
            title: `Conversation ${id}`,
            description: null,
            updateTimestamp: 1_773_705_600_000,
          },
        ],
        cursor: null,
      });
    }
    if (request.method === "GET" && url.pathname.endsWith("/messages")) {
      return envelope({
        messages: [
          {
            msgId: `message-${id}`,
            content: `Message ${id}`,
            additionalKwargs: {},
            attachments: null,
            createTimestamp: 1_773_705_600_000,
            creator: { uid: `user-${id}`, name: `User ${id}`, avatar: null },
            conversationId,
            role: "user",
            msgType: "text",
          },
        ],
        events: [],
        cursor: null,
      });
    }
    if (request.method === "GET" && url.pathname.endsWith("/status")) {
      return envelope({ working: false, taskId: null });
    }
    if (request.method === "POST" && url.pathname.endsWith("/messages")) {
      return envelope({ taskId: `run-${id}` });
    }
    throw new Error(`Unexpected controlled request: ${request.method}`);
  };
  const socketFactory: TFRobotSocketFactory = (input) => {
    socketInputs.push(input);
    const socket = new ControlledSocket(input);
    sockets.push(socket);
    return socket;
  };
  const probe: HostProbe = {
    clients,
    captureClient(client) {
      if (!clients.includes(client)) clients.push(client);
    },
  };

  return {
    authReads,
    diagnostics,
    disposeErrors,
    expectedAuthorization,
    expectedColor: color,
    expectedSessionToken: sessionValue,
    messageCreatorReads,
    options: {
      callbacks: {
        getMessageCreator: ({ conversationId: requestedConversationId }) => {
          messageCreatorReads.push(requestedConversationId);
          return {
            uid: `user-${id}`,
            name: `User ${id}`,
          };
        },
        onDiagnostic: (error) => diagnostics.push(error),
        onDisposeError: (error) => disposeErrors.push(error),
        onUnhandledError: (failure) => unhandledErrors.push(failure),
      },
      endpoints: {
        apiBaseUrl: `https://${id}.example.test/api/`,
        socketNamespaceUrl: `https://${id}.example.test/chat`,
        socketPath: `/socket-${id}`,
      },
      fetch,
      getDisposeDeadlineAt: deadlineAt,
      platformId: `platform-${id}`,
      sessionProvider,
      socketFactory,
      theme: { token: { colorPrimary: color } },
      uiReadyLabel: `${id} Kit UI ready`,
    },
    probe,
    requests,
    sockets,
    socketInputs,
    unhandledErrors,
  };
};

const renderHosts = (first: HostFixture, second: HostFixture): ReactElement =>
  createElement(
    "div",
    null,
    createElement(HostBoundary, {
      key: "first",
      options: first.options,
      probe: first.probe,
    }),
    createElement(HostBoundary, {
      key: "second",
      options: second.options,
      probe: second.probe,
    }),
  );

export const runHostConsumerVerification = async (): Promise<void> => {
  const first = createHostFixture("first", "#13579b");
  const second = createHostFixture("second", "#2468ac");
  const renderPackedUi = (fixture: HostFixture): string =>
    renderToStaticMarkup(
      createElement(
        ConfigProvider,
        { theme: fixture.options.theme },
        createElement(PackedHostUi, { options: fixture.options }),
      ),
    );
  const firstUiMarkup = renderPackedUi(first);
  const secondUiMarkup = renderPackedUi(second);
  const hostTree = renderHosts(first, second);
  check(
    first.probe.clients.length === 0 && first.authReads.length === 0,
    "composing a host tree must not create a client or read session material",
  );
  check(
    firstUiMarkup.includes(first.options.uiReadyLabel) &&
      secondUiMarkup.includes(second.options.uiReadyLabel) &&
      firstUiMarkup.includes(first.expectedColor) &&
      secondUiMarkup.includes(second.expectedColor),
    "each host must render the packed public Kit UI under its theme boundary",
  );

  let renderer: ReactTestRenderer | undefined;
  await act(async () => {
    renderer = create(hostTree);
    await flushMicrotasks();
  });
  if (renderer === undefined) throw new Error("host consumer did not mount");
  const mountedRenderer = renderer;
  check(
    first.probe.clients.length === 1 && second.probe.clients.length === 1,
    "each mounted host must create exactly one client",
  );
  check(
    first.authReads.length === 0 && second.authReads.length === 0,
    "client construction must not read session material",
  );
  check(
    first.messageCreatorReads.length === 0 &&
      second.messageCreatorReads.length === 0,
    "client construction must not read host identity",
  );
  const firstClient = first.probe.clients[0]!;
  const secondClient = second.probe.clients[0]!;
  const [firstLoaded, secondLoaded] = await Promise.all([
    firstClient.loadConversation({
      conversationId: "first",
      deadlineAt: deadlineAt(),
    }),
    secondClient.loadConversation({
      conversationId: "second",
      deadlineAt: deadlineAt(),
    }),
  ]);
  await flushMicrotasks();
  check(firstLoaded.ok && secondLoaded.ok, "both host clients must load");
  check(
    firstClient.getSnapshot()?.conversation.id === "first" &&
      secondClient.getSnapshot()?.conversation.id === "second",
    "host clients must keep conversation state isolated",
  );
  check(
    first.requests.every(
      (request) =>
        request.headers.get("Authorization") === first.expectedAuthorization &&
        request.url.startsWith(first.options.endpoints.apiBaseUrl),
    ) &&
      second.requests.every(
        (request) =>
          request.headers.get("Authorization") ===
            second.expectedAuthorization &&
          request.url.startsWith(second.options.endpoints.apiBaseUrl),
      ),
    "requests must use only their own endpoint and session",
  );
  check(
    first.socketInputs[0]?.namespaceUrl ===
      first.options.endpoints.socketNamespaceUrl &&
      second.socketInputs[0]?.namespaceUrl ===
        second.options.endpoints.socketNamespaceUrl &&
      first.socketInputs[0]?.path === first.options.endpoints.socketPath &&
      second.socketInputs[0]?.path === second.options.endpoints.socketPath,
    "socket endpoint injection must remain instance-scoped",
  );
  check(
    first.sockets[0]?.auth[0]?.token ===
      first.expectedAuthorization.slice("Bearer ".length) &&
      second.sockets[0]?.auth[0]?.token ===
        second.expectedAuthorization.slice("Bearer ".length),
    "socket authentication must remain instance-scoped",
  );

  const [firstSent, secondSent] = await Promise.all([
    firstClient.sendText({
      conversationId: "first",
      text: "first message",
      deadlineAt: deadlineAt(),
    }),
    secondClient.sendText({
      conversationId: "second",
      text: "second message",
      deadlineAt: deadlineAt(),
    }),
  ]);
  check(firstSent.ok && secondSent.ok, "both host clients must send text");
  check(
    first.messageCreatorReads.join(",") === "first" &&
      second.messageCreatorReads.join(",") === "second",
    "message creator lookup must be lazy and conversation-scoped",
  );

  first.sockets[0]?.trigger("chat_error", {
    conversationId: "first",
    error: `Authorization: ${first.expectedAuthorization}; token=${first.expectedSessionToken}`,
  });
  second.sockets[0]?.trigger("chat_error", {
    conversationId: "second",
    error: `Authorization: ${second.expectedAuthorization}; token=${second.expectedSessionToken}`,
  });
  await flushMicrotasks();
  const injectedFailureDiagnostics = JSON.stringify([
    ...first.diagnostics,
    ...second.diagnostics,
  ]);
  check(
    first.diagnostics.length === 1 &&
      second.diagnostics.length === 1 &&
      injectedFailureDiagnostics.includes("[REDACTED]"),
    "controlled failures must reach each host as sanitized diagnostics",
  );
  check(
    !injectedFailureDiagnostics.includes(first.expectedSessionToken) &&
      !injectedFailureDiagnostics.includes(second.expectedSessionToken) &&
      !injectedFailureDiagnostics.includes(first.expectedAuthorization) &&
      !injectedFailureDiagnostics.includes(second.expectedAuthorization),
    "controlled diagnostics must redact HTTP and Socket session material",
  );

  const replacement = createHostFixture("replacement", "#abcdef");
  await act(async () => {
    mountedRenderer.update(renderHosts(replacement, second));
    await flushMicrotasks();
  });
  check(
    firstClient.disposed,
    "factory replacement must dispose the old client",
  );
  check(
    !secondClient.disposed && second.probe.clients.length === 1,
    "an unrelated host instance must survive another factory replacement",
  );
  check(
    replacement.probe.clients.length === 1,
    "factory replacement must create one fresh client",
  );

  await act(async () => {
    mountedRenderer.unmount();
    await flushMicrotasks();
  });
  check(secondClient.disposed, "unmount must dispose the second client");
  check(
    replacement.probe.clients[0]?.disposed,
    "unmount must dispose the replacement client",
  );
  check(
    first.sockets.every(({ connected }) => !connected) &&
      second.sockets.every(({ connected }) => !connected),
    "disposed host clients must disconnect their sockets",
  );
  check(
    [
      ...first.disposeErrors,
      ...second.disposeErrors,
      ...replacement.disposeErrors,
      ...first.unhandledErrors,
      ...second.unhandledErrors,
      ...replacement.unhandledErrors,
    ].length === 0,
    "host lifecycle verification must not hide disposal errors",
  );
  const observableFailures = JSON.stringify([
    ...first.diagnostics,
    ...second.diagnostics,
    ...replacement.diagnostics,
  ]);
  check(
    !observableFailures.includes(first.expectedSessionToken) &&
      !observableFailures.includes(second.expectedSessionToken) &&
      !observableFailures.includes(first.expectedAuthorization) &&
      !observableFailures.includes(second.expectedAuthorization),
    "diagnostics must not expose session material",
  );
};
