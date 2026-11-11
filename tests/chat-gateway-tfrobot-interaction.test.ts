import { describe, expect, it, vi } from "vitest";

import { createRemoteToolClient } from "../packages/chat-runtime/src/index.js";
import { TFRobotRemoteToolTransport } from "../packages/chat-gateway-tfrobot/src/index.js";
import { mapEvent } from "../packages/chat-gateway-tfrobot/src/mapper.js";
import {
  defineRemoteTool,
  type InteractionAck,
  type InteractionClosed,
  type InteractionPendingSnapshot,
  type InteractionRequest,
  type InteractionServerHello,
  type InteractionTransportObserver,
  type RemoteToolConnectionState,
  type SessionProvider,
} from "../packages/chat-protocol/src/index.js";
import type {
  TFRobotSession,
  TFRobotSocket,
  TFRobotSocketAnyListener,
  TFRobotSocketFactoryInput,
  TFRobotSocketListener,
} from "../packages/chat-gateway-tfrobot/src/index.js";

class InteractionFakeSocket implements TFRobotSocket {
  connected = false;
  active = true;
  readonly emitted: Array<{
    readonly event: string;
    readonly payload: unknown;
    readonly ack?: (...values: unknown[]) => void;
  }> = [];
  readonly #listeners = new Map<string, Set<TFRobotSocketListener>>();
  readonly #anyListeners = new Set<TFRobotSocketAnyListener>();
  registerReply: ((reply: (value: unknown) => void) => void) | undefined = (
    reply,
  ) =>
    reply({
      providerId: "provider-1",
      registeredToolNames: ["host_tool"],
      error: null,
    });

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
      this.registerReply?.(ack);
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

const sessionProvider: SessionProvider<TFRobotSession> = {
  getSession: () => ({ kind: "bearer", token: "session-token" }),
  onSessionInvalid: vi.fn(),
};

const createTransport = (
  options: {
    readonly connectionTimeoutMs?: number;
    readonly preconnected?: boolean;
    readonly socketNamespaceUrl?: string;
  } = {},
) => {
  const sockets: InteractionFakeSocket[] = [];
  const inputs: TFRobotSocketFactoryInput[] = [];
  const transport = new TFRobotRemoteToolTransport({
    baseUrl: "https://robot.example/",
    sessionProvider,
    ...(options.connectionTimeoutMs === undefined
      ? {}
      : { connectionTimeoutMs: options.connectionTimeoutMs }),
    ...(options.socketNamespaceUrl === undefined
      ? {}
      : { socketNamespaceUrl: options.socketNamespaceUrl }),
    socketFactory: (input) => {
      inputs.push(input);
      const socket = new InteractionFakeSocket();
      if (options.preconnected === true) socket.connected = true;
      sockets.push(socket);
      return socket;
    },
  });
  return { transport, sockets, inputs };
};

const requestedPayload = (overrides: Record<string, unknown> = {}) => ({
  protocolVersion: 1,
  interactionId: "interaction-1",
  conversationId: 42,
  conversationTitle: "Deploy",
  robotId: "robot-1",
  namespace: "/remote-tool",
  requester: { id: "user-1", name: "Alice" },
  target: { kind: "human", id: "user-2", name: "Bob" },
  question: "Deploy now?",
  options: [{ value: "yes", label: "Yes" }],
  multiSelect: false,
  timeoutSeconds: 30,
  expiresAt: 1_800_000_000_000,
  ...overrides,
});

const createObserver = () => {
  const events: string[] = [];
  const hellos: InteractionServerHello[] = [];
  const snapshots: InteractionPendingSnapshot[] = [];
  const requests: InteractionRequest[] = [];
  const closed: InteractionClosed[] = [];
  const connections: string[] = [];
  const observer: InteractionTransportObserver = {
    hello: (hello) => {
      events.push("hello");
      hellos.push(hello);
    },
    pending: (snapshot) => {
      events.push("pending");
      snapshots.push(snapshot);
    },
    requested: (request) => {
      events.push("requested");
      requests.push(request);
    },
    closed: (event) => {
      events.push("closed");
      closed.push(event);
    },
    connection: (state) => {
      events.push(`connection:${state}`);
      connections.push(state);
    },
  };
  return {
    observer,
    events,
    hellos,
    snapshots,
    requests,
    closed,
    connections,
  };
};

describe("TFRobot interaction transport", () => {
  it("sends hello on connect and delivers every interaction frame", () => {
    const { transport, sockets } = createTransport();
    const observed = createObserver();
    transport.attachInteraction(observed.observer);
    transport.connect();
    const socket = sockets[0]!;

    expect(socket.events("interaction_hello")).toEqual([
      {
        protocolVersion: 1,
        versions: ["interaction_v1"],
        supportsAskUserAdapter: false,
      },
    ]);
    socket.trigger("interaction_hello", {
      protocolVersion: 1,
      versions: ["interaction_v1"],
      robotId: "robot-1",
      namespace: "/remote-tool",
    });
    socket.trigger("interaction_pending", {
      protocolVersion: 1,
      interactions: [requestedPayload()],
    });
    socket.trigger(
      "interaction_requested",
      requestedPayload({
        interactionId: "interaction-2",
      }),
    );
    socket.trigger("interaction_closed", {
      protocolVersion: 1,
      interactionId: "interaction-2",
      terminalReason: "answered",
    });

    expect(observed.events).toEqual([
      "connection:connected",
      "hello",
      "pending",
      "requested",
      "closed",
    ]);
    expect(observed.snapshots[0]).toMatchObject({
      kind: "snapshot",
      knownIds: ["interaction-1"],
      requests: [{ interactionId: "interaction-1", conversationId: "42" }],
    });
    expect(observed.requests[0]).toMatchObject({
      interactionId: "interaction-2",
    });
    expect(observed.closed[0]).toMatchObject({ terminalReason: "answered" });
    transport.dispose();
  });

  it("resends the client hello after a reconnect", () => {
    const { transport, sockets } = createTransport();
    const observed = createObserver();
    transport.attachInteraction(observed.observer);
    transport.connect();
    const socket = sockets[0]!;
    expect(socket.events("interaction_hello")).toHaveLength(1);
    socket.disconnect();
    socket.connect();
    expect(socket.events("interaction_hello")).toHaveLength(2);
    expect(observed.connections).toEqual([
      "connected",
      "disconnected",
      "connected",
    ]);
    transport.dispose();
  });

  it("buffers early frames until a consumer attaches, then replays in order", () => {
    const { transport, sockets } = createTransport();
    transport.connect();
    const socket = sockets[0]!;
    socket.trigger("interaction_pending", {
      protocolVersion: 1,
      interactions: [requestedPayload()],
    });
    socket.trigger(
      "interaction_requested",
      requestedPayload({
        interactionId: "early",
      }),
    );

    const observed = createObserver();
    transport.attachInteraction(observed.observer);
    expect(observed.events).toEqual([
      "pending",
      "requested",
      "connection:connected",
    ]);
    expect(socket.events("interaction_hello")).toHaveLength(1);
    transport.dispose();
  });

  it("rejects a second interaction owner on the same namespace", () => {
    const { transport } = createTransport();
    transport.attachInteraction(createObserver().observer);
    expect(() =>
      transport.attachInteraction(createObserver().observer),
    ).toThrow("Interaction transport already has an owner");
    transport.dispose();
  });

  it("carries response acks and treats invalid acks as unknown", () => {
    const { transport, sockets } = createTransport();
    const observed = createObserver();
    const attachment = transport.attachInteraction(observed.observer);
    transport.connect();
    const socket = sockets[0]!;
    socket.trigger("interaction_requested", requestedPayload());

    const acks: Array<InteractionAck | undefined> = [];
    expect(
      attachment.respond(
        {
          interactionId: "interaction-1",
          status: "answered",
          selectedOptions: ["yes"],
        },
        (ack) => acks.push(ack),
      ),
    ).toBe(true);
    const response = socket.emitted.find(
      (entry) => entry.event === "interaction_response",
    );
    expect(response?.payload).toEqual({
      protocolVersion: 1,
      interactionId: "interaction-1",
      status: "answered",
      selectedOptions: ["yes"],
    });
    response?.ack?.({
      protocolVersion: 1,
      interactionId: "interaction-1",
      status: "accepted",
    });
    // The port promises at most one terminal callback per response.
    response?.ack?.({
      protocolVersion: 2,
      interactionId: "interaction-1",
      status: "accepted",
    });
    expect(acks).toEqual([
      { interactionId: "interaction-1", status: "accepted" },
    ]);

    const unsupported: Array<InteractionAck | undefined> = [];
    attachment.respond(
      { interactionId: "interaction-1", status: "cancelled" },
      (ack) => unsupported.push(ack),
    );
    socket.emitted
      .filter((entry) => entry.event === "interaction_response")
      .at(-1)
      ?.ack?.({
        protocolVersion: 2,
        interactionId: "interaction-1",
        status: "accepted",
      });
    expect(unsupported).toEqual([undefined]);

    const mismatched: Array<InteractionAck | undefined> = [];
    attachment.respond(
      { interactionId: "interaction-1", status: "cancelled" },
      (ack) => mismatched.push(ack),
    );
    socket.emitted
      .filter((entry) => entry.event === "interaction_response")
      .at(-1)
      ?.ack?.({
        protocolVersion: 1,
        interactionId: "other",
        status: "accepted",
      });
    expect(mismatched).toEqual([undefined]);
    transport.dispose();
  });

  it("drops unsupported versions and reports malformed snapshots without closing frames", () => {
    const { transport, sockets } = createTransport();
    const observed = createObserver();
    transport.attachInteraction(observed.observer);
    transport.connect();
    const socket = sockets[0]!;

    socket.trigger(
      "interaction_requested",
      requestedPayload({
        protocolVersion: 2,
      }),
    );
    socket.trigger("interaction_pending", {
      protocolVersion: 2,
      interactions: [],
    });
    socket.trigger("interaction_pending", {
      protocolVersion: 1,
      interactions: [
        requestedPayload(),
        { interactionId: "broken" },
        { nope: true },
      ],
    });

    expect(observed.requests).toEqual([]);
    expect(observed.snapshots[0]).toEqual({ kind: "malformed" });
    expect(observed.snapshots[1]).toMatchObject({
      kind: "snapshot",
      knownIds: ["interaction-1", "broken"],
      requests: [{ interactionId: "interaction-1" }],
    });
    transport.dispose();
  });

  it("shares one namespace owner between RemoteTool and interaction", async () => {
    const { transport, sockets } = createTransport();
    const observed = createObserver();
    transport.attachInteraction(observed.observer);
    const states: RemoteToolConnectionState[] = [];
    const client = createRemoteToolClient({
      transport,
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
    });
    client.subscribe(() => states.push(client.getSnapshot()));
    client.start();
    const socket = sockets[0]!;

    expect(socket.events("interaction_hello")).toHaveLength(1);
    expect(states.at(-1)?.status).toBe("ready");
    socket.trigger("interaction_requested", requestedPayload());
    expect(observed.requests).toHaveLength(1);

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

    client.dispose();
    // RemoteToolClient.dispose closes the standalone transport by contract.
    expect(socket.connected).toBe(false);
    transport.dispose();
  });

  it("keeps interaction alive when the remote tool consumer detaches", () => {
    const { transport, sockets } = createTransport();
    const observed = createObserver();
    const attachment = transport.attachInteraction(observed.observer);
    transport.start(
      [
        {
          toolName: "host_tool",
          description: "Host operation",
          parameters: { type: "object" },
          tags: ["Read"],
        },
      ],
      { state: () => undefined, invoke: () => undefined },
    );
    const socket = sockets[0]!;
    expect(socket.connected).toBe(true);

    transport.detachRemoteTool();
    expect(socket.connected).toBe(true);
    socket.trigger("interaction_requested", requestedPayload());
    expect(observed.requests).toHaveLength(1);

    attachment.detach();
    expect(socket.connected).toBe(false);
    transport.dispose();
  });

  it("does not let a registration failure tear down an attached interaction channel", () => {
    const { transport, sockets } = createTransport();
    const observed = createObserver();
    transport.attachInteraction(observed.observer);
    transport.connect();
    const socket = sockets[0]!;
    socket.registerReply = (reply) =>
      reply({ providerId: "provider-1", error: "Remote tool name conflicts" });
    const states: RemoteToolConnectionState[] = [];
    transport.start(
      [
        {
          toolName: "host_tool",
          description: "Host operation",
          parameters: { type: "object" },
          tags: ["Read"],
        },
      ],
      {
        state: (state) => states.push(state),
        invoke: () => undefined,
      },
    );
    expect(states.at(-1)).toMatchObject({
      status: "error",
      error: "name-conflict",
    });
    expect(socket.connected).toBe(true);
    socket.trigger("interaction_requested", requestedPayload());
    expect(observed.requests).toHaveLength(1);

    socket.registerReply = (reply) =>
      reply({
        providerId: "provider-1",
        registeredToolNames: ["host_tool"],
        error: null,
      });
    transport.retry();
    expect(states.at(-1)).toMatchObject({ status: "ready" });
    expect(socket.connected).toBe(true);
    transport.dispose();
  });

  it("settles the interaction-only handshake budget on namespace connect", () => {
    vi.useFakeTimers();
    try {
      const transport = new TFRobotRemoteToolTransport({
        baseUrl: "https://robot.example/",
        sessionProvider,
        connectionTimeoutMs: 100,
        socketFactory: () => new InteractionFakeSocket(),
      });
      const observed = createObserver();
      transport.attachInteraction(observed.observer);
      transport.connect();
      vi.advanceTimersByTime(500);
      expect(observed.connections).toEqual(["connected"]);
      transport.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends hello when an injected socket is already connected", () => {
    const { transport, sockets } = createTransport({ preconnected: true });
    const observed = createObserver();
    transport.attachInteraction(observed.observer);
    transport.connect();
    expect(sockets[0]?.events("interaction_hello")).toHaveLength(1);
    expect(observed.connections).toEqual(["connected"]);
    transport.dispose();
  });

  it("preserves hello and pending when the early buffer overflows", () => {
    const { transport, sockets } = createTransport();
    transport.connect();
    const socket = sockets[0]!;
    socket.trigger("interaction_hello", {
      protocolVersion: 1,
      versions: ["interaction_v1"],
      robotId: "robot-1",
      namespace: "/remote-tool",
    });
    socket.trigger("interaction_pending", {
      protocolVersion: 1,
      interactions: [requestedPayload()],
    });
    for (let index = 0; index < 51; ++index)
      socket.trigger(
        "interaction_requested",
        requestedPayload({
          interactionId: `early-${index}`,
        }),
      );

    const observed = createObserver();
    transport.attachInteraction(observed.observer);
    expect(observed.hellos).toHaveLength(1);
    expect(observed.snapshots[0]).toMatchObject({
      kind: "snapshot",
      knownIds: ["interaction-1"],
    });
    expect(observed.requests).toHaveLength(48);
    transport.dispose();
  });

  it("isolates a registration timeout from an attached interaction channel", () => {
    vi.useFakeTimers();
    try {
      const { transport, sockets } = createTransport({
        connectionTimeoutMs: 100,
      });
      const observed = createObserver();
      transport.attachInteraction(observed.observer);
      transport.connect();
      const socket = sockets[0]!;
      socket.registerReply = () => undefined;
      const states: RemoteToolConnectionState[] = [];
      transport.start(
        [
          {
            toolName: "host_tool",
            description: "Host operation",
            parameters: { type: "object" },
            tags: ["Read"],
          },
        ],
        {
          state: (state) => states.push(state),
          invoke: () => undefined,
        },
      );
      vi.advanceTimersByTime(100);
      expect(states.at(-1)).toMatchObject({
        status: "error",
        error: "timeout",
      });
      expect(socket.connected).toBe(true);
      socket.trigger("interaction_requested", requestedPayload());
      expect(observed.requests).toHaveLength(1);
      transport.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps an in-flight interaction ack valid when RemoteTool detaches", () => {
    const { transport, sockets } = createTransport();
    const observed = createObserver();
    const attachment = transport.attachInteraction(observed.observer);
    transport.start(
      [
        {
          toolName: "host_tool",
          description: "Host operation",
          parameters: { type: "object" },
          tags: ["Read"],
        },
      ],
      { state: () => undefined, invoke: () => undefined },
    );
    const socket = sockets[0]!;
    const onAck = vi.fn();
    attachment.respond(
      {
        interactionId: "interaction-1",
        status: "answered",
        selectedOptions: ["yes"],
      },
      onAck,
    );
    const response = socket.emitted.find(
      (entry) => entry.event === "interaction_response",
    );
    transport.detachRemoteTool();
    response?.ack?.({
      protocolVersion: 1,
      interactionId: "interaction-1",
      status: "accepted",
    });
    expect(onAck).toHaveBeenCalledWith({
      interactionId: "interaction-1",
      status: "accepted",
    });
    transport.dispose();
  });

  it("settles a missing ack as undefined within the ack budget", () => {
    vi.useFakeTimers();
    try {
      const { transport, sockets } = createTransport();
      const observed = createObserver();
      const attachment = transport.attachInteraction(observed.observer);
      transport.connect();
      const socket = sockets[0]!;
      socket.trigger("interaction_requested", requestedPayload());
      const onAck = vi.fn();
      attachment.respond(
        { interactionId: "interaction-1", status: "cancelled" },
        onAck,
      );
      expect(onAck).not.toHaveBeenCalled();
      vi.advanceTimersByTime(60_000);
      expect(onAck).toHaveBeenCalledTimes(1);
      expect(onAck).toHaveBeenCalledWith(undefined);
      transport.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels the ack fallback when the server replies", () => {
    vi.useFakeTimers();
    try {
      const { transport, sockets } = createTransport();
      const observed = createObserver();
      const attachment = transport.attachInteraction(observed.observer);
      transport.connect();
      const socket = sockets[0]!;
      const onAck = vi.fn();
      attachment.respond(
        { interactionId: "interaction-1", status: "cancelled" },
        onAck,
      );
      const response = socket.emitted.find(
        (entry) => entry.event === "interaction_response",
      );
      response?.ack?.({
        protocolVersion: 1,
        interactionId: "interaction-1",
        status: "accepted",
      });
      vi.advanceTimersByTime(60_000);
      expect(onAck).toHaveBeenCalledTimes(1);
      expect(onAck).toHaveBeenCalledWith({
        interactionId: "interaction-1",
        status: "accepted",
      });
      transport.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("recovers an interaction-only transport through retry", () => {
    const { transport, sockets } = createTransport();
    const observed = createObserver();
    transport.attachInteraction(observed.observer);
    transport.connect();
    const socket = sockets[0]!;
    expect(transport.namespace).toBe("/remote-tool");
    expect(socket.events("interaction_hello")).toHaveLength(1);
    socket.trigger("connect_error", new Error("not authorized"));
    expect(socket.connected).toBe(false);
    transport.retry();
    expect(socket.connected).toBe(true);
    expect(socket.events("interaction_hello")).toHaveLength(2);
    // A retry while connected must redo the namespace handshake so the Server
    // resends hello/pending after an identity mismatch.
    transport.retry();
    expect(socket.connected).toBe(true);
    expect(socket.events("interaction_hello")).toHaveLength(3);
    transport.dispose();
  });

  it("forces a shared-channel resync without a second owner", () => {
    const { transport, sockets } = createTransport();
    const observed = createObserver();
    transport.attachInteraction(observed.observer);
    const states: RemoteToolConnectionState[] = [];
    transport.start(
      [
        {
          toolName: "host_tool",
          description: "Host operation",
          parameters: { type: "object" },
          tags: ["Read"],
        },
      ],
      {
        state: (state) => states.push(state),
        invoke: () => undefined,
      },
    );
    const socket = sockets[0]!;
    expect(socket.events("register")).toHaveLength(1);
    expect(socket.events("interaction_hello")).toHaveLength(1);
    expect(states.at(-1)?.status).toBe("ready");

    transport.retryInteraction();
    expect(sockets).toHaveLength(1);
    expect(socket.connected).toBe(true);
    expect(socket.events("interaction_hello")).toHaveLength(2);
    expect(socket.events("register")).toHaveLength(2);
    expect(states.some((state) => state.status === "registering")).toBe(true);
    expect(states.at(-1)?.status).toBe("ready");
    transport.dispose();
  });

  it("no-ops retryInteraction without a consumer or after dispose", () => {
    const { transport, sockets } = createTransport();
    transport.connect();
    const socket = sockets[0]!;
    expect(() => transport.retryInteraction()).not.toThrow();
    expect(socket.connected).toBe(true);
    transport.dispose();
    expect(() => transport.retryInteraction()).not.toThrow();
  });

  it("normalizes a trailing slash in the expected namespace", () => {
    const { transport, sockets } = createTransport({
      socketNamespaceUrl: "https://robot.example/remote-tool/",
    });
    const observed = createObserver();
    transport.attachInteraction(observed.observer);
    transport.connect();
    const socket = sockets[0]!;
    expect(transport.namespace).toBe("/remote-tool");
    socket.trigger("interaction_hello", {
      protocolVersion: 1,
      versions: ["interaction_v1"],
      robotId: "robot-1",
      namespace: "/remote-tool",
    });
    socket.trigger("interaction_requested", requestedPayload());
    expect(observed.requests).toHaveLength(1);
    expect(observed.connections).toEqual(["connected"]);
    transport.dispose();
  });

  it("cancels the ack fallback when the interaction consumer detaches", () => {
    vi.useFakeTimers();
    try {
      const { transport } = createTransport();
      const observed = createObserver();
      const attachment = transport.attachInteraction(observed.observer);
      transport.start(
        [
          {
            toolName: "host_tool",
            description: "Host operation",
            parameters: { type: "object" },
            tags: ["Read"],
          },
        ],
        { state: () => undefined, invoke: () => undefined },
      );
      const onAck = vi.fn();
      attachment.respond(
        { interactionId: "interaction-1", status: "cancelled" },
        onAck,
      );
      attachment.detach();
      vi.advanceTimersByTime(60_000);
      expect(onAck).not.toHaveBeenCalled();
      transport.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels the ack fallback on disconnect and dispose", () => {
    vi.useFakeTimers();
    try {
      const first = createTransport();
      const firstObserved = createObserver();
      const firstAttachment = first.transport.attachInteraction(
        firstObserved.observer,
      );
      first.transport.connect();
      const firstSocket = first.sockets[0]!;
      const firstAck = vi.fn();
      firstAttachment.respond(
        { interactionId: "interaction-1", status: "cancelled" },
        firstAck,
      );
      firstSocket.disconnect();
      vi.advanceTimersByTime(60_000);
      expect(firstAck).not.toHaveBeenCalled();
      first.transport.dispose();

      const second = createTransport();
      const secondObserved = createObserver();
      const secondAttachment = second.transport.attachInteraction(
        secondObserved.observer,
      );
      second.transport.connect();
      const secondAck = vi.fn();
      secondAttachment.respond(
        { interactionId: "interaction-1", status: "cancelled" },
        secondAck,
      );
      second.transport.dispose();
      vi.advanceTimersByTime(60_000);
      expect(secondAck).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("interaction history mapping", () => {
  const baseEvent = {
    eventId: "colleague-event",
    status: "success",
    eventScene: "Tool",
    conversationId: 42,
    createTimestamp: 1_773_705_600_100,
    exception: null,
  };

  it("maps ask_colleague tool results into a read-only history model", () => {
    const event = mapEvent({
      ...baseEvent,
      content: {
        toolCall: {
          toolId: "call-1",
          functionCall: {
            name: "ask_colleague",
            parameters: JSON.stringify({ question: "Deploy done?" }),
          },
        },
        toolReturn: {
          origin: {
            interactionId: "it-1",
            status: "answered",
            answer: "Yes",
            answeredBy: "Bob",
            answeredAt: 1_773_705_600_200,
          },
          meta: { success: true, done: true },
        },
      },
    });
    expect(event).toMatchObject({
      eventCategory: "tool",
      transitions: [
        {
          interactionHistory: {
            kind: "interaction-history",
            interactionId: "it-1",
            direction: "ask",
            status: "answered",
            question: "Deploy done?",
            answer: "Yes",
            answeredBy: "Bob",
            answeredAt: 1_773_705_600_200,
          },
        },
      ],
    });
  });

  it("maps answer_colleague meta results and selected option values", () => {
    const event = mapEvent({
      ...baseEvent,
      content: {
        toolCall: {
          toolId: "call-2",
          functionCall: {
            name: "answer_colleague",
            parameters: JSON.stringify({ selected_options: ["yes", "later"] }),
          },
        },
        toolReturn: {
          meta: {
            __MCP__: {
              a2c_vrl_transformed: JSON.stringify({
                interactionId: "it-2",
                status: "timeout",
              }),
            },
          },
        },
      },
    });
    expect(event).toMatchObject({
      transitions: [
        {
          interactionHistory: {
            interactionId: "it-2",
            direction: "answer",
            status: "timeout",
            answer: "yes、later",
          },
        },
      ],
    });
  });

  it("accepts stringified origins and array answers from TFRS", () => {
    const event = mapEvent({
      ...baseEvent,
      content: {
        toolCall: {
          toolId: "call-3",
          functionCall: { name: "ask_colleague", parameters: "{}" },
        },
        toolReturn: {
          origin: JSON.stringify({
            interactionId: "it-3",
            status: "answered",
            question: "Which targets?",
            answer: ["staging", "beta"],
          }),
        },
      },
    });
    expect(event).toMatchObject({
      transitions: [
        {
          interactionHistory: {
            interactionId: "it-3",
            direction: "ask",
            status: "answered",
            question: "Which targets?",
            answer: "staging、beta",
          },
        },
      ],
    });
  });

  it("truncates long colleague questions instead of dropping the history", () => {
    const question = "q".repeat(3_000);
    const event = mapEvent({
      ...baseEvent,
      content: {
        toolCall: {
          toolId: "call-4",
          functionCall: {
            name: "ask_colleague",
            parameters: JSON.stringify({ question }),
          },
        },
        toolReturn: {
          origin: { interactionId: "it-4", status: "answered" },
        },
      },
    });
    expect(event).toMatchObject({
      transitions: [
        { interactionHistory: { interactionId: "it-4", status: "answered" } },
      ],
    });
    if (event.eventCategory !== "tool") return;
    expect(event.transitions[0]?.interactionHistory?.question).toHaveLength(
      3_000,
    );
  });

  it("leaves unrecognized colleague returns to the generic Tool path", () => {
    const event = mapEvent({
      ...baseEvent,
      content: {
        toolCall: {
          toolId: "call-3",
          functionCall: { name: "ask_colleague", parameters: "{}" },
        },
        toolReturn: { origin: { foo: "bar" } },
      },
    });
    expect(event).toMatchObject({ eventCategory: "tool" });
    if (event.eventCategory !== "tool") return;
    const transition = event.transitions[0];
    expect(transition?.interactionHistory).toBeUndefined();
  });
});
