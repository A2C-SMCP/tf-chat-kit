import {
  createTFRobotChatGateway,
  createTFRobotRemoteToolTransport,
  type TFRobotRemoteToolOptions,
  type TFRobotGatewayOptions,
} from "@turingfocus/chat-gateway-tfrobot";
import {
  createChatClient,
  createRemoteToolClient,
  type RemoteToolClient,
  type RemoteToolClientOptions,
  type ChatClient,
  type ChatClientOptions,
} from "@turingfocus/chat-runtime";

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
    TFRobotRemoteToolOptions,
    Omit<RemoteToolClientOptions, "transport"> {}

/** Explicitly owned optional provider; dispose it when the host session ends. */
export const createTFRobotRemoteToolClient = (
  options: TFRobotRemoteToolClientOptions,
): RemoteToolClient => {
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
