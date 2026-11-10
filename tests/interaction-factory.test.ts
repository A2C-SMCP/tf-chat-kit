import { describe, expect, it, vi } from "vitest";

import {
  INTERACTION_MAX_QUESTION_CHARACTERS,
  createInteractionResponsePayload,
  createTFRobotInteractionClient,
  createTFRobotRemoteToolInteractionBundle,
  defineRemoteTool,
  type SessionProvider,
} from "../packages/chat-kit/src/headless.js";
import type {
  TFRobotSession,
  TFRobotSocket,
  TFRobotSocketAnyListener,
  TFRobotSocketFactoryInput,
  TFRobotSocketListener,
} from "../packages/chat-gateway-tfrobot/src/index.js";
import type { InteractionRequest } from "../packages/chat-protocol/src/index.js";

class FactoryFakeSocket implements TFRobotSocket {
  connected = false;
  active = true;
  readonly emitted: Array<{
    readonly event: string;
    readonly payload: unknown;
    readonly ack?: (...values: unknown[]) => void;
  }> = [];
  readonly #listeners = new Map<string, Set<TFRobotSocketListener>>();
  readonly #anyListeners = new Set<TFRobotSocketAnyListener>();

  connect(): void {
    this.connected = true;
    this.trigger("connect");
  }

  disconnect(): void {
    const wasConnected = this.connected;
    this.connected = false;
    if (wasConnected) this.trigger("disconnect", "io client disconnect");
  }

  emit(eventName: string, ...arguments_: unknown[]): void {
    const ack =
      typeof arguments_.at(-1) === "function"
        ? (arguments_.at(-1) as (...values: unknown[]) => void)
        : undefined;
    this.emitted.push({
      event: eventName,
      payload: arguments_[0],
      ...(ack === undefined ? {} : { ack }),
    });
    if (eventName === "register" && ack !== undefined)
      ack({
        providerId: "provider-1",
        registeredToolNames: ["host_tool"],
        error: null,
      });
  }

  on(eventName: string, listener: TFRobotSocketListener): void {
    const listeners = this.#listeners.get(eventName) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(eventName, listeners);
  }

  off(eventName: string, listener: TFRobotSocketListener): void {
    this.#listeners.get(eventName)?.delete(listener);
  }

  onAny(listener: TFRobotSocketAnyListener): void {
    this.#anyListeners.add(listener);
  }

  offAny(listener: TFRobotSocketAnyListener): void {
    this.#anyListeners.delete(listener);
  }

  trigger(eventName: string, ...payloads: unknown[]): void {
    for (const listener of this.#listeners.get(eventName) ?? [])
      listener(...payloads);
    for (const listener of this.#anyListeners) listener(eventName, ...payloads);
  }

  events(eventName: string): unknown[] {
    return this.emitted
      .filter((entry) => entry.event === eventName)
      .map((entry) => entry.payload);
  }
}

const NOW = 1_800_000_000_000;

const sessionProvider: SessionProvider<TFRobotSession> = {
  getSession: () => ({ kind: "bearer", token: "session-token" }),
  onSessionInvalid: vi.fn(),
};

const createFixture = () => {
  const sockets: FactoryFakeSocket[] = [];
  const socketFactory = (input: TFRobotSocketFactoryInput): TFRobotSocket => {
    void input;
    const socket = new FactoryFakeSocket();
    sockets.push(socket);
    return socket;
  };
  return { sockets, socketFactory };
};

const request = (interactionId = "interaction-1"): InteractionRequest => ({
  interactionId,
  conversationId: "42",
  robotId: "robot-1",
  namespace: "/remote-tool",
  requester: { id: "user-1" },
  target: { kind: "human", id: "user-2" },
  question: "Continue?",
  options: [{ value: "yes", label: "Yes" }],
  multiSelect: false,
  timeoutSeconds: 30,
  expiresAt: NOW + 30_000,
});

const flush = async (): Promise<void> => {
  for (let index = 0; index < 12; ++index) await Promise.resolve();
};

const synchronize = async (socket: FactoryFakeSocket): Promise<void> => {
  socket.trigger("interaction_hello", {
    protocolVersion: 1,
    versions: ["interaction_v1"],
    robotId: "robot-1",
    namespace: "/remote-tool",
  });
  socket.trigger("interaction_pending", {
    protocolVersion: 1,
    interactions: [],
  });
  await flush();
};

describe("interaction public factories", () => {
  it("exposes the canonical response builder and Server-aligned limits", () => {
    expect(INTERACTION_MAX_QUESTION_CHARACTERS).toBe(32 * 1_024);
    expect(
      createInteractionResponsePayload({
        interactionId: "interaction-1",
        status: "cancelled",
      }),
    ).toEqual({
      protocolVersion: 1,
      interactionId: "interaction-1",
      status: "cancelled",
    });
  });

  it("creates an interaction-only client without any RemoteTool", async () => {
    const { sockets, socketFactory } = createFixture();
    const client = createTFRobotInteractionClient({
      baseUrl: "https://robot.example/",
      sessionProvider,
      socketFactory,
      robotId: "robot-1",
    });
    expect(sockets).toHaveLength(1);
    const socket = sockets[0]!;
    expect(socket.events("interaction_hello")).toEqual([
      {
        protocolVersion: 1,
        versions: ["interaction_v1"],
        supportsAskUserAdapter: false,
      },
    ]);
    await synchronize(socket);
    socket.trigger("interaction_requested", {
      ...request(),
      protocolVersion: 1,
    });
    await flush();
    expect(client.getSnapshot().entries["interaction-1"]?.status).toBe(
      "pending",
    );
    client.dispose();
    expect(socket.connected).toBe(false);
  });

  it("declares the legacy adapter only when the host asks for it", () => {
    const { sockets, socketFactory } = createFixture();
    const client = createTFRobotInteractionClient({
      baseUrl: "https://robot.example/",
      sessionProvider,
      socketFactory,
      robotId: "robot-1",
      supportsAskUserAdapter: true,
    });
    expect(sockets[0]?.events("interaction_hello")[0]).toMatchObject({
      supportsAskUserAdapter: true,
    });
    client.dispose();
  });

  it("shares one namespace owner and keeps both consumers independent", async () => {
    const { sockets, socketFactory } = createFixture();
    const bundle = createTFRobotRemoteToolInteractionBundle({
      baseUrl: "https://robot.example/",
      sessionProvider,
      socketFactory,
      tools: [
        defineRemoteTool({
          definition: {
            toolName: "host_tool",
            description: "Host operation",
            parameters: { type: "object" },
            tags: ["Read"],
          },
          validate: (params) => params,
          execute: () => ({ ok: true, resultForLlm: "done" }),
        }),
      ],
      interaction: { robotId: "robot-1" },
    });
    expect(sockets).toHaveLength(1);
    const socket = sockets[0]!;
    expect(socket.events("interaction_hello")).toHaveLength(1);
    expect(socket.events("register")).toHaveLength(1);
    expect(bundle.remoteTools?.getSnapshot().status).toBe("ready");

    await synchronize(socket);
    socket.trigger("interaction_requested", {
      ...request(),
      protocolVersion: 1,
    });
    await flush();
    expect(
      bundle.interaction.getSnapshot().entries["interaction-1"]?.status,
    ).toBe("pending");

    const reply = vi.fn();
    socket.trigger(
      "remote_tool_invoke",
      {
        requestId: "call-1",
        providerId: "provider-1",
        toolName: "host_tool",
        params: {},
      },
      reply,
    );
    for (let index = 0; index < 12; ++index) await Promise.resolve();
    expect(reply).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: "call-1", success: true }),
    );

    // Releasing tools leaves interaction and the shared socket alive.
    bundle.remoteTools!.dispose();
    expect(socket.connected).toBe(true);
    socket.trigger("interaction_requested", {
      ...request("interaction-2"),
      protocolVersion: 1,
    });
    await flush();
    expect(
      bundle.interaction.getSnapshot().entries["interaction-2"]?.status,
    ).toBe("pending");

    bundle.interaction.dispose();
    expect(socket.connected).toBe(false);
    bundle.dispose();
    expect(socket.connected).toBe(false);
  });

  it("closes the shared socket only after both consumers release", () => {
    const { sockets, socketFactory } = createFixture();
    const bundle = createTFRobotRemoteToolInteractionBundle({
      baseUrl: "https://robot.example/",
      sessionProvider,
      socketFactory,
      tools: [
        defineRemoteTool({
          definition: {
            toolName: "host_tool",
            description: "Host operation",
            parameters: { type: "object" },
            tags: ["Read"],
          },
          validate: (params) => params,
          execute: () => ({ ok: true, resultForLlm: "done" }),
        }),
      ],
      interaction: { robotId: "robot-1" },
    });
    const socket = sockets[0]!;
    bundle.interaction.dispose();
    expect(socket.connected).toBe(true);
    expect(bundle.remoteTools?.getSnapshot().status).toBe("ready");
    bundle.remoteTools!.dispose();
    expect(socket.connected).toBe(false);
    bundle.dispose();
  });
});
