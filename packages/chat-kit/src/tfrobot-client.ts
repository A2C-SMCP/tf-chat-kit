import {
  createTFRobotChatGateway,
  createTFRobotRemoteToolTransport,
  type TFRobotRemoteToolOptions,
  type TFRobotGatewayOptions,
} from "@turingfocus/chat-gateway-tfrobot";
import {
  createChatClient,
  createInteractionClient,
  createRemoteToolClient,
  type InteractionClient,
  type InteractionClientOptions,
  type RemoteToolClient,
  type RemoteToolClientOptions,
  type ChatClient,
  type ChatClientOptions,
} from "@turingfocus/chat-runtime";
import type {
  RemoteTool,
  RemoteToolTransport,
} from "@turingfocus/chat-protocol";

export interface TFRobotChatClientOptions extends TFRobotGatewayOptions {
  readonly diagnostics?: ChatClientOptions["diagnostics"];
  readonly cache?: ChatClientOptions["cache"];
  /** Receives isolated Runtime listener and cleanup failures. */
  readonly onUnhandledError?: ChatClientOptions["onUnhandledError"];
}

/**
 * Creates one instance-owned TFRobot Gateway and the ChatClient that owns it.
 * Disposing the returned client also disposes the Gateway and its Socket.
 */
export const createTFRobotChatClient = (
  options: TFRobotChatClientOptions,
): ChatClient => {
  const { cache, diagnostics, onUnhandledError, ...gatewayOptions } = options;
  const gateway = createTFRobotChatGateway(gatewayOptions);
  return createChatClient({
    gateway,
    onUnhandledError,
    diagnostics,
    ...(cache === undefined ? {} : { cache }),
  });
};

export interface TFRobotRemoteToolClientOptions
  extends
    Omit<TFRobotRemoteToolOptions, "supportsAskUserAdapter">,
    Omit<RemoteToolClientOptions, "transport"> {}

/**
 * Explicitly owned optional provider; dispose it when the host session ends.
 * This standalone client never sends interaction_hello, so
 * `supportsAskUserAdapter` is not part of its options. Use
 * createTFRobotRemoteToolInteractionBundle when interaction is needed.
 */
export const createTFRobotRemoteToolClient = (
  options: TFRobotRemoteToolClientOptions,
): RemoteToolClient => {
  if (
    (options as { readonly supportsAskUserAdapter?: unknown })
      .supportsAskUserAdapter !== undefined
  )
    throw new TypeError(
      "supportsAskUserAdapter requires an interaction consumer; use createTFRobotRemoteToolInteractionBundle",
    );
  const {
    tools,
    timeoutMs,
    maxConcurrentCalls,
    maxRememberedCalls,
    ...transportOptions
  } = options;
  return createRemoteToolClient({
    transport: createTFRobotRemoteToolTransport(transportOptions),
    tools,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(maxConcurrentCalls === undefined ? {} : { maxConcurrentCalls }),
    ...(maxRememberedCalls === undefined ? {} : { maxRememberedCalls }),
  });
};

export type TFRobotInteractionOptions = Omit<
  InteractionClientOptions,
  "transport"
>;

export interface TFRobotInteractionClientOptions
  extends
    Omit<TFRobotRemoteToolOptions, "supportsAskUserAdapter">,
    TFRobotInteractionOptions {}

/**
 * Creates an interaction-only client. It attaches before the shared
 * `/remote-tool` socket connects and does not require any RemoteTool.
 *
 * When the host already owns a RemoteToolClient (or a shared socketFactory),
 * use createTFRobotRemoteToolInteractionBundle instead. Two independent
 * clients would each acquire the `/remote-tool` namespace and trigger
 * "Socket namespace already has an owner".
 *
 * Terminal transport failures surface through onFrameError and require
 * retry() or recreating the client.
 */
export const createTFRobotInteractionClient = (
  options: TFRobotInteractionClientOptions,
): InteractionClient => {
  if (
    (options as { readonly supportsAskUserAdapter?: unknown })
      .supportsAskUserAdapter === true
  )
    throw new TypeError(
      "supportsAskUserAdapter is only supported by createTFRobotRemoteToolInteractionBundle",
    );
  const {
    robotId,
    acceptServerIdentity,
    expectedNamespace,
    ackTimeoutMs,
    tickIntervalMs,
    helloFlushGraceMs,
    maxBufferedFrames,
    queueLimit,
    tombstoneMs,
    onFrameError,
    ...transportOptions
  } = options;
  const transport = createTFRobotRemoteToolTransport(transportOptions);
  const client = createInteractionClient({
    transport,
    robotId,
    ...(acceptServerIdentity === undefined ? {} : { acceptServerIdentity }),
    ...(expectedNamespace === undefined ? {} : { expectedNamespace }),
    ...(ackTimeoutMs === undefined ? {} : { ackTimeoutMs }),
    ...(tickIntervalMs === undefined ? {} : { tickIntervalMs }),
    ...(helloFlushGraceMs === undefined ? {} : { helloFlushGraceMs }),
    ...(maxBufferedFrames === undefined ? {} : { maxBufferedFrames }),
    ...(queueLimit === undefined ? {} : { queueLimit }),
    ...(tombstoneMs === undefined ? {} : { tombstoneMs }),
    ...(onFrameError === undefined ? {} : { onFrameError }),
  });
  transport.connect();
  return client;
};

export interface TFRobotRemoteToolInteractionOptions extends TFRobotRemoteToolOptions {
  /** Omit or pass an empty list for interaction-only hosts. */
  readonly tools?: readonly RemoteTool[] | undefined;
  readonly timeoutMs?: RemoteToolClientOptions["timeoutMs"];
  readonly maxConcurrentCalls?: RemoteToolClientOptions["maxConcurrentCalls"];
  readonly maxRememberedCalls?: RemoteToolClientOptions["maxRememberedCalls"];
  readonly interaction: TFRobotInteractionOptions;
}

export interface TFRobotRemoteToolInteractionBundle {
  readonly interaction: InteractionClient;
  /** Undefined when no tools were supplied. */
  readonly remoteTools: RemoteToolClient | undefined;
  /** Releases both consumers and the shared socket. Idempotent. */
  dispose(): void;
}

/**
 * Creates one `/remote-tool` owner shared by RemoteTool and interaction.
 * Disposing either client only detaches that consumer; the bundle owns the
 * socket and closes it after both consumers are gone. Hosts that already have
 * a RemoteToolClient must replace it with this bundle (or otherwise share one
 * transport); a second independent client would contend for the namespace
 * owner and throw "Socket namespace already has an owner".
 */
export const createTFRobotRemoteToolInteractionBundle = (
  options: TFRobotRemoteToolInteractionOptions,
): TFRobotRemoteToolInteractionBundle => {
  const {
    tools,
    timeoutMs,
    maxConcurrentCalls,
    maxRememberedCalls,
    interaction,
    ...transportOptions
  } = options;
  const transport = createTFRobotRemoteToolTransport(transportOptions);
  const interactionClient = createInteractionClient({
    transport,
    ...interaction,
  });
  const remoteToolFacade: RemoteToolTransport = {
    clock: transport.clock,
    start: (definitions, observer) => transport.start(definitions, observer),
    retry: () => transport.retry(),
    // RemoteToolClient.dispose() must not tear down the shared socket.
    dispose: () => transport.detachRemoteTool(),
  };
  const remoteTools =
    tools === undefined || tools.length === 0
      ? undefined
      : createRemoteToolClient({
          transport: remoteToolFacade,
          tools,
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
          ...(maxConcurrentCalls === undefined ? {} : { maxConcurrentCalls }),
          ...(maxRememberedCalls === undefined ? {} : { maxRememberedCalls }),
        });
  remoteTools?.start();
  if (remoteTools === undefined) transport.connect();
  let disposed = false;
  return {
    interaction: interactionClient,
    remoteTools,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      interactionClient.dispose();
      remoteTools?.dispose();
      transport.dispose();
    },
  };
};
