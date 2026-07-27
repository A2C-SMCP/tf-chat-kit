import type { ChatError, ChatUpdate } from "@turingfocus/chat-protocol";

export type GatewayNotification =
  | { readonly kind: "update"; readonly update: ChatUpdate }
  | { readonly kind: "error"; readonly error: ChatError };

export interface GatewayNotificationQueue {
  activate(generation: number): void;
  enqueue(notification: GatewayNotification): void;
}

type GatewayNotificationDispatcher = (
  notification: GatewayNotification,
  generation: number,
) => void;

/** Buffers synchronous establishment notifications and drains them in FIFO order. */
export const createGatewayNotificationQueue = (
  dispatch: GatewayNotificationDispatcher,
): GatewayNotificationQueue => {
  const pending: GatewayNotification[] = [];
  let generation: number | undefined;
  let phase: "buffering" | "draining" | "active" = "buffering";

  const dispatchActive = (notification: GatewayNotification): void => {
    if (generation !== undefined) dispatch(notification, generation);
  };

  return {
    enqueue: (notification) => {
      if (phase !== "active") {
        pending.push(notification);
        return;
      }
      dispatchActive(notification);
    },
    activate: (activeGeneration) => {
      if (phase !== "buffering") return;
      generation = activeGeneration;
      phase = "draining";
      for (let index = 0; index < pending.length; index += 1) {
        dispatchActive(pending[index]!);
      }
      pending.length = 0;
      phase = "active";
    },
  };
};
