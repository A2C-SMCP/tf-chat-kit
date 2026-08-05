import type {
  ChatClientDisposeOptions,
  ChatClientFactory,
} from "@turingfocus/chat-react";

import {
  createTFRobotChatClient,
  type TFRobotChatClientOptions,
} from "./tfrobot-client.js";

export interface TFRobotChatClientFactoryOptions extends TFRobotChatClientOptions {
  /** Supplies a fresh absolute disposal deadline for every cleanup. */
  readonly getDisposeOptions: () => ChatClientDisposeOptions;
}

/**
 * Adapts the default TFRobot composition to OwnedChatProvider. Every create
 * call returns a fresh isolated client, including React StrictMode replays.
 */
export const createTFRobotChatClientFactory = (
  options: TFRobotChatClientFactoryOptions,
): ChatClientFactory => {
  const { getDisposeOptions, ...clientOptions } = options;
  return Object.freeze({
    create: () => createTFRobotChatClient(clientOptions),
    getDisposeOptions,
  });
};
