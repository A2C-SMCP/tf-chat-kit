import type { Socket } from "socket.io-client";
import type { TFRobotSocket } from "./types.js";

/** Terminal notification from an explicitly disposed shared connection context. */
export class SocketConnectionDisposedError extends Error {
  constructor() {
    super("Socket connection context is disposed");
  }
}

/** Internal marker: a shared namespace must survive an in-flight Gateway handoff. */
export const REUSE_DISCONNECTED_SOCKET = Symbol("shared namespace socket");

// Private callback metadata keeps the narrow injected Socket API unchanged.
// The production adapter uses the same deadline as the Gateway's join timer.
export const ACK_TIMEOUT = Symbol("TFRobot ACK timeout");
type TimedAcknowledgement = ((...args: unknown[]) => void) & {
  readonly [ACK_TIMEOUT]: number;
};

/** Internal adapter metadata; lets all namespace owners bound native ACK retention. */
export const withSocketAckTimeout = (
  callback: (...args: unknown[]) => void,
  timeoutMs: number,
): ((...args: unknown[]) => void) =>
  Object.assign(callback, { [ACK_TIMEOUT]: timeoutMs });

/** Preserve native ACK deadlines and hide Socket.IO's error-first callback prefix. */
export const adaptSocketIoSocket = (socket: Socket): TFRobotSocket => ({
  get connected() {
    return socket.connected;
  },
  get active() {
    return socket.active;
  },
  connect: () => {
    socket.connect();
  },
  disconnect: () => {
    socket.disconnect();
  },
  on: (event, listener) => socket.on(event, listener),
  off: (event, listener) => socket.off(event, listener),
  onAny: (listener) => socket.onAny(listener),
  offAny: (listener) => socket.offAny(listener),
  emit: (event, ...args) => {
    const callback = args.at(-1);
    const timeout =
      typeof callback === "function"
        ? (callback as Partial<TimedAcknowledgement>)[ACK_TIMEOUT]
        : undefined;
    if (timeout === undefined) return socket.emit(event, ...args);
    return socket
      .timeout(timeout)
      .emit(
        event,
        ...args.slice(0, -1),
        (error: Error | null, ...values: unknown[]) => {
          if (error === null) (callback as TimedAcknowledgement)(...values);
        },
      );
  },
});

/** Wrapping an ACK must preserve its private native timeout metadata. */
export const guardSocketAcknowledgement = (
  args: unknown[],
  current: () => boolean,
): unknown[] => {
  const callback = args.at(-1);
  if (typeof callback !== "function") return args;
  const guarded = (...values: unknown[]) => {
    if (current()) callback(...values);
  };
  const timeout = (callback as Partial<TimedAcknowledgement>)[ACK_TIMEOUT];
  return [
    ...args.slice(0, -1),
    timeout === undefined ? guarded : withSocketAckTimeout(guarded, timeout),
  ];
};
