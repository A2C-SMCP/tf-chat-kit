import {
  createTFRobotChatGateway,
  type TFRobotGatewayOptions,
} from "@turingfocus/chat-gateway-tfrobot";
import {
  createChatClient,
  type ChatClient,
  type ChatClientOptions,
} from "@turingfocus/chat-runtime";

export interface TFRobotChatClientOptions extends TFRobotGatewayOptions {
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
  const { cache, onUnhandledError, ...gatewayOptions } = options;
  const gateway = createTFRobotChatGateway(gatewayOptions);
  return createChatClient({
    gateway,
    onUnhandledError,
    ...(cache === undefined ? {} : { cache }),
  });
};
