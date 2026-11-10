import { describe, expect, it, vi } from "vitest";

import {
  createInteractionClient,
  type InteractionClient,
  type InteractionClientOptions,
} from "../packages/chat-runtime/src/index.js";
import { MemoryGatewayClock } from "../packages/chat-testing/src/memory-gateway-clock.js";
import { InteractionStore } from "../packages/chat-runtime/src/interaction-store.js";
import type {
  InteractionAck,
  InteractionClosed,
  InteractionPendingSnapshot,
  InteractionRequest,
  InteractionResponse,
  InteractionServerHello,
  InteractionTransport,
  InteractionTransportAttachment,
  InteractionTransportObserver,
} from "../packages/chat-protocol/src/index.js";

const NOW = 1_800_000_000_000;

const request = (
  interactionId: string,
  overrides: Partial<InteractionRequest> = {},
): InteractionRequest => ({
  interactionId,
  conversationId: "42",
  conversationTitle: "Deploy",
  robotId: "robot-1",
  namespace: "/remote-tool",
  requester: { id: "user-1", name: "Alice" },
  target: { kind: "human", id: "user-2", name: "Bob" },
  question: "Deploy now?",
  options: [{ value: "yes", label: "Yes" }],
  multiSelect: false,
  timeoutSeconds: 30,
  expiresAt: NOW + 30_000,
  ...overrides,
});

class MemoryInteractionTransport implements InteractionTransport {
  readonly #time = new MemoryGatewayClock(NOW);
  readonly clock = {
    now: (): number => this.#time.now(),
    schedule: (callback: () => void, delayMs: number): (() => void) => {
      const signal = this.#time.signal(this.#time.now() + delayMs);
      let active = true;
      void signal.promise.then(() => {
        if (active) callback();
      });
      return () => {
        active = false;
        signal.cancel();
      };
    },
  };
  readonly namespace = "/remote-tool";
  observer: InteractionTransportObserver | undefined;
  attachment: InteractionTransportAttachment | undefined;
  readonly responses: InteractionResponse[] = [];
  readonly acks: Array<(ack: InteractionAck | undefined) => void> = [];
  respondReturn = true;
  detached = false;
  retry = vi.fn();

  attachInteraction(
    observer: InteractionTransportObserver,
  ): InteractionTransportAttachment {
    this.observer = observer;
    this.attachment = {
      respond: (response, onAck) => {
        this.responses.push(response);
        this.acks.push(onAck);
        return this.respondReturn;
      },
      detach: () => {
        this.detached = true;
      },
    };
    return this.attachment;
  }

  advanceTo(timestamp: number): void {
    this.#time.advanceTo(timestamp);
  }

  hello(
    hello: InteractionServerHello = {
      versions: ["interaction_v1"],
      robotId: "robot-1",
      namespace: "/remote-tool",
    },
  ): void {
    this.observer?.hello(hello);
  }

  pending(snapshot: InteractionPendingSnapshot): void {
    this.observer?.pending(snapshot);
  }

  requested(value: InteractionRequest): void {
    this.observer?.requested(value);
  }

  closed(value: InteractionClosed): void {
    this.observer?.closed(value);
  }

  connection(state: "connected" | "disconnected"): void {
    this.observer?.connection(state);
  }

  ack(value: InteractionAck | undefined, index = this.acks.length - 1): void {
    this.acks[index]?.(value);
  }
}

const flush = async (): Promise<void> => {
  for (let index = 0; index < 20; ++index) await Promise.resolve();
};

const setup = (
  options: Partial<
    Omit<InteractionClientOptions, "transport" | "robotId">
  > = {},
) => {
  const transport = new MemoryInteractionTransport();
  const errors: string[] = [];
  const client = createInteractionClient({
    transport,
    robotId: "robot-1",
    tickIntervalMs: 1_000,
    onFrameError: (message) => errors.push(message),
    ...options,
  });
  return { transport, client, errors };
};

const synchronize = async (
  transport: MemoryInteractionTransport,
): Promise<void> => {
  transport.connection("connected");
  transport.hello();
  transport.pending({ kind: "snapshot", requests: [], knownIds: [] });
  await flush();
};

const entries = (client: InteractionClient) => client.getSnapshot().entries;

describe("InteractionClient state", () => {
  it("waits for a snapshot, then applies EDF ordering and single active selection", async () => {
    const { transport, client } = setup();
    expect(client.getSnapshot().connection).toBe("disconnected");
    transport.connection("connected");
    expect(client.getSnapshot().connection).toBe("awaiting-snapshot");
    transport.hello();
    await flush();
    // The hello grace is still pending; the snapshot path connects earlier.
    transport.pending({ kind: "snapshot", requests: [], knownIds: [] });
    await flush();
    expect(client.getSnapshot().connection).toBe("connected");

    transport.requested(request("late", { expiresAt: NOW + 20_000 }));
    transport.requested(request("early", { expiresAt: NOW + 5_000 }));
    await flush();
    expect(client.getSnapshot().activeId).toBe("early");
    expect(Object.keys(entries(client))).toEqual(["late", "early"]);

    client.activate("late");
    expect(client.getSnapshot().activeId).toBe("late");
    transport.requested(request("newer", { expiresAt: NOW + 10_000 }));
    await flush();
    // A pending (not submitting) member can be displaced by an earlier deadline.
    expect(client.getSnapshot().activeId).toBe("early");
    client.dispose();
  });

  it("flushes early frames after a 250ms hello grace when the snapshot is lost", async () => {
    const { transport, client } = setup();
    transport.connection("connected");
    transport.hello();
    transport.requested(request("early"));
    transport.closed({ interactionId: "early", terminalReason: "cancelled" });
    expect(entries(client)).toEqual({});

    transport.advanceTo(NOW + 249);
    await flush();
    expect(client.getSnapshot().connection).toBe("awaiting-snapshot");
    expect(entries(client)).toEqual({});

    transport.advanceTo(NOW + 250);
    await flush();
    expect(client.getSnapshot().connection).toBe("connected");
    expect(entries(client)).toMatchObject({
      early: { status: "closed", terminalReason: "cancelled" },
    });
    client.dispose();
  });

  it("closes local interactions missing from a snapshot and never revives closed items", async () => {
    const { transport, client } = setup();
    await synchronize(transport);
    transport.requested(request("local"));
    await flush();
    expect(entries(client)["local"]?.status).toBe("pending");

    transport.pending({
      kind: "snapshot",
      requests: [request("remote")],
      knownIds: ["remote"],
    });
    await flush();
    expect(entries(client)["local"]).toMatchObject({
      status: "closed",
      terminalReason: "not_in_snapshot",
    });
    expect(entries(client)["remote"]?.status).toBe("pending");

    transport.requested(request("local"));
    await flush();
    expect(entries(client)["local"]?.status).toBe("closed");

    transport.pending({ kind: "snapshot", requests: [], knownIds: [] });
    await flush();
    expect(entries(client)["remote"]).toMatchObject({
      status: "closed",
      terminalReason: "not_in_snapshot",
    });
    client.dispose();
  });

  it("fails safe on malformed snapshots and keeps locally known interactions", async () => {
    const { transport, client } = setup();
    await synchronize(transport);
    transport.requested(request("local"));
    await flush();

    transport.connection("disconnected");
    transport.connection("connected");
    transport.pending({ kind: "malformed" });
    await flush();
    expect(client.getSnapshot().connection).toBe("connected");
    expect(entries(client)["local"]?.status).toBe("pending");
    client.dispose();
  });

  it("filters foreign robotId and namespace frames", async () => {
    const { transport, client } = setup();
    await synchronize(transport);
    transport.requested(request("foreign-robot", { robotId: "robot-2" }));
    transport.requested(request("foreign-namespace", { namespace: "/other" }));
    transport.requested(request("local"));
    await flush();
    expect(Object.keys(entries(client))).toEqual(["local"]);

    transport.pending({
      kind: "snapshot",
      requests: [request("foreign-snapshot", { robotId: "robot-2" })],
      knownIds: ["foreign-snapshot", "local"],
    });
    await flush();
    expect(entries(client)["foreign-snapshot"]).toBeUndefined();
    expect(entries(client)["local"]?.status).toBe("pending");
    client.dispose();
  });

  it("filters identity before the server hello, including namespace", async () => {
    const { transport, client } = setup();
    transport.connection("connected");
    transport.pending({ kind: "malformed" });
    transport.requested(request("ok"));
    transport.requested(request("wrong-robot", { robotId: "robot-2" }));
    transport.requested(request("wrong-namespace", { namespace: "/other" }));
    await flush();
    expect(Object.keys(entries(client))).toEqual(["ok"]);
    client.dispose();
  });

  it("fails closed on a server hello with an unexpected robot", async () => {
    const { transport, client, errors } = setup();
    transport.connection("connected");
    transport.hello({
      versions: ["interaction_v1"],
      robotId: "robot-2",
      namespace: "/remote-tool",
    });
    transport.requested(request("foreign", { robotId: "robot-2" }));
    await flush();
    expect(client.getSnapshot().connection).toBe("disconnected");
    expect(entries(client)).toEqual({});
    expect(
      errors.some((message) => message.includes("reject interaction_hello")),
    ).toBe(true);
    client.dispose();
  });

  it("fails closed on a server hello from a foreign namespace", async () => {
    const { transport, client } = setup();
    transport.connection("connected");
    transport.hello({
      versions: ["interaction_v1"],
      robotId: "robot-1",
      namespace: "/other",
    });
    transport.pending({ kind: "snapshot", requests: [], knownIds: [] });
    await flush();
    expect(client.getSnapshot().connection).toBe("disconnected");
    expect(entries(client)).toEqual({});
    client.dispose();
  });

  it("can opt into the server-asserted identity explicitly", async () => {
    const { transport, client } = setup({ acceptServerIdentity: true });
    transport.connection("connected");
    transport.hello({
      versions: ["interaction_v1"],
      robotId: "robot-2",
      namespace: "/remote-tool",
    });
    transport.pending({ kind: "snapshot", requests: [], knownIds: [] });
    transport.requested(request("accepted", { robotId: "robot-2" }));
    await flush();
    expect(entries(client)["accepted"]?.status).toBe("pending");
    client.dispose();
  });

  it("delegates explicit recovery to the transport and contains failures", () => {
    const transport = new MemoryInteractionTransport();
    const client = createInteractionClient({ transport, robotId: "robot-1" });
    expect(client.retry()).toBe(true);
    expect(transport.retry).toHaveBeenCalledTimes(1);
    const failingTransport = new MemoryInteractionTransport();
    failingTransport.retry.mockImplementation(() => {
      throw new Error("connection disposed");
    });
    const errors: string[] = [];
    const failing = createInteractionClient({
      transport: failingTransport,
      robotId: "robot-1",
      onFrameError: (message) => errors.push(message),
    });
    expect(failing.retry()).toBe(false);
    expect(errors.some((message) => message.includes("retry failed"))).toBe(
      true,
    );
    failing.dispose();
    client.dispose();
    expect(client.retry()).toBe(false);
  });

  it("supports an explicit expected namespace for rewrite deployments", async () => {
    const { transport, client } = setup({ expectedNamespace: "/custom" });
    transport.connection("connected");
    transport.hello({
      versions: ["interaction_v1"],
      robotId: "robot-1",
      namespace: "/custom",
    });
    transport.pending({ kind: "snapshot", requests: [], knownIds: [] });
    transport.requested(request("custom", { namespace: "/custom" }));
    transport.requested(request("transport-namespace"));
    await flush();
    expect(entries(client)["custom"]?.status).toBe("pending");
    expect(entries(client)["transport-namespace"]).toBeUndefined();
    client.dispose();
  });

  it("copies closed answeredBy and answeredAt into the entry", async () => {
    const { transport, client } = setup();
    await synchronize(transport);
    transport.requested(request("answered"));
    await flush();
    transport.closed({
      interactionId: "answered",
      terminalReason: "answered",
      answeredBy: "Bob",
      answeredAt: NOW + 123,
    });
    await flush();
    expect(entries(client)["answered"]).toMatchObject({
      status: "closed",
      terminalReason: "answered",
      answeredBy: "Bob",
      answeredAt: NOW + 123,
    });
    client.dispose();
  });

  it("revives an accepted entry when a pending snapshot still contains it", async () => {
    const { transport, client } = setup();
    await synchronize(transport);
    transport.requested(request("answer"));
    await flush();
    client.respond("answer", { status: "answered", answer: "yes" });
    transport.ack({ interactionId: "answer", status: "accepted" });
    await flush();
    expect(entries(client)["answer"]?.status).toBe("accepted");

    transport.pending({
      kind: "snapshot",
      requests: [request("answer")],
      knownIds: ["answer"],
    });
    await flush();
    expect(entries(client)["answer"]?.status).toBe("pending");
    expect(entries(client)["answer"]?.staleReason).toBeUndefined();
    client.dispose();
  });

  it("enforces the live queue limit", async () => {
    const { transport, client, errors } = setup();
    await synchronize(transport);
    for (let index = 0; index < 10; ++index)
      transport.requested(request(`item-${index}`));
    transport.requested(request("overflow"));
    await flush();
    expect(Object.keys(entries(client))).toHaveLength(10);
    expect(entries(client)["overflow"]).toBeUndefined();
    expect(errors.some((message) => message.includes("queue limit"))).toBe(
      true,
    );
    client.dispose();
  });

  it("keeps duplicate requested and closed frames idempotent", async () => {
    const { transport, client } = setup();
    await synchronize(transport);
    transport.requested(request("same"));
    transport.requested(request("same", { question: "Updated question" }));
    await flush();
    expect(entries(client)["same"]).toMatchObject({
      status: "pending",
      question: "Updated question",
    });

    transport.closed({ interactionId: "same", terminalReason: "answered" });
    transport.closed({ interactionId: "same", terminalReason: "answered" });
    await flush();
    expect(entries(client)["same"]).toMatchObject({
      status: "closed",
      terminalReason: "answered",
    });
    transport.requested(request("same"));
    await flush();
    expect(entries(client)["same"]?.status).toBe("closed");
    client.dispose();
  });

  it("reconciles stale local entries before applying the snapshot queue limit", async () => {
    const { transport, client } = setup();
    await synchronize(transport);
    for (let index = 0; index < 10; ++index)
      transport.requested(request(`stale-${index}`));
    await flush();
    const serverRequests = Array.from({ length: 10 }, (_, index) =>
      request(`server-${index}`),
    );
    transport.pending({
      kind: "snapshot",
      requests: serverRequests,
      knownIds: serverRequests.map((entry) => entry.interactionId),
    });
    await flush();
    const live = Object.values(entries(client)).filter(
      (entry) => entry.status !== "closed",
    );
    expect(live).toHaveLength(10);
    expect(
      live.every((entry) => entry.interactionId.startsWith("server-")),
    ).toBe(true);
    client.dispose();
  });

  it("keeps an explicitly activated pending item across countdown ticks", async () => {
    const { transport, client } = setup();
    await synchronize(transport);
    transport.requested(request("early", { expiresAt: NOW + 5_000 }));
    transport.requested(request("late", { expiresAt: NOW + 20_000 }));
    await flush();
    client.activate("late");
    expect(client.getSnapshot().activeId).toBe("late");
    transport.advanceTo(NOW + 1_000);
    await flush();
    expect(client.getSnapshot().activeId).toBe("late");
    client.dispose();
  });

  it("expires over-budget local entries before rejecting a new request", () => {
    const transport = new MemoryInteractionTransport();
    const clock = transport.clock;
    const store = new InteractionStore({ clock });
    for (let index = 0; index < 10; ++index)
      store.receiveRequested(
        request(`expired-${index}`, {
          expiresAt: NOW + 1,
        }),
      );
    transport.advanceTo(NOW + 1);
    store.receiveRequested(request("fresh"));
    const live = Object.values(store.getSnapshot().entries).filter(
      (entry) => entry.status !== "closed",
    );
    expect(live.map((entry) => entry.interactionId)).toEqual(["fresh"]);
    store.dispose();
  });

  it("re-derives the active item when a duplicate request triggers expiry", () => {
    const transport = new MemoryInteractionTransport();
    const store = new InteractionStore({ clock: transport.clock });
    store.receiveRequested(request("a", { expiresAt: NOW + 1 }));
    store.receiveRequested(request("b", { expiresAt: NOW + 10_000 }));
    store.activate("a");
    transport.advanceTo(NOW + 1);
    // The duplicate path expires A then returns early; it must still republish
    // so activeId does not point at a closed entry.
    store.receiveRequested(request("a", { expiresAt: NOW + 1 }));
    expect(store.getSnapshot().entries["a"]?.status).toBe("closed");
    expect(store.getSnapshot().activeId).toBe("b");
    store.dispose();
  });

  it("preserves an explicit queue selection when an inline card is submitted", async () => {
    const { transport, client } = setup();
    await synchronize(transport);
    transport.requested(request("a", { expiresAt: NOW + 10_000 }));
    transport.requested(request("b", { expiresAt: NOW + 20_000 }));
    await flush();
    client.activate("b");
    expect(client.getSnapshot().activeId).toBe("b");
    expect(client.respond("a", { status: "cancelled" })).toBe(true);
    expect(client.getSnapshot().activeId).toBe("b");
    client.dispose();
  });

  it("preserves an explicit queue selection across a malformed snapshot", async () => {
    const { transport, client } = setup();
    await synchronize(transport);
    transport.requested(request("a", { expiresAt: NOW + 10_000 }));
    transport.requested(request("b", { expiresAt: NOW + 20_000 }));
    await flush();
    client.activate("b");
    transport.connection("disconnected");
    transport.connection("connected");
    transport.pending({ kind: "malformed" });
    await flush();
    expect(client.getSnapshot().activeId).toBe("b");
    client.dispose();
  });
});

describe("InteractionClient responses", () => {
  it.each([
    ["accepted", "accepted", undefined],
    ["already_closed", "closed", "already_closed"],
    ["unknown_request", "closed", "unknown_request"],
  ] as const)(
    "maps %s acknowledgements to %s",
    async (ackStatus, status, terminalReason) => {
      const { transport, client } = setup();
      await synchronize(transport);
      transport.requested(request("answer"));
      await flush();
      expect(
        client.respond("answer", {
          status: "answered",
          selectedOptions: ["yes"],
        }),
      ).toBe(true);
      expect(transport.responses[0]).toEqual({
        interactionId: "answer",
        status: "answered",
        selectedOptions: ["yes"],
      });
      transport.ack({ interactionId: "answer", status: ackStatus });
      await flush();
      expect(entries(client)["answer"]).toMatchObject({
        status,
        ...(terminalReason === undefined ? {} : { terminalReason }),
      });
      client.dispose();
    },
  );

  it("marks a missing or invalid ack uncertain and allows a retry", async () => {
    const { transport, client } = setup({ ackTimeoutMs: 10_000 });
    await synchronize(transport);
    transport.requested(request("answer"));
    await flush();
    client.respond("answer", { status: "answered", answer: "yes" });
    transport.advanceTo(NOW + 10_000);
    await flush();
    expect(entries(client)["answer"]).toMatchObject({
      status: "pending",
      staleReason: "ack_timeout",
      attempt: 1,
    });
    // Ack loss never auto-resends the response frame.
    expect(transport.responses).toHaveLength(1);

    expect(client.respond("answer", { status: "cancelled" })).toBe(true);
    transport.ack({ interactionId: "answer", status: "accepted" });
    await flush();
    expect(entries(client)["answer"]?.status).toBe("accepted");
    client.dispose();
  });

  it("returns to pending when the transport rejects the response", async () => {
    const { transport, client } = setup();
    await synchronize(transport);
    transport.requested(request("answer"));
    await flush();
    transport.respondReturn = false;
    expect(client.respond("answer", { status: "cancelled" })).toBe(false);
    expect(entries(client)["answer"]).toMatchObject({
      status: "pending",
      staleReason: "ack_timeout",
    });
    client.dispose();
  });

  it("marks in-flight responses uncertain on disconnect and blocks answering", async () => {
    const { transport, client } = setup();
    await synchronize(transport);
    transport.requested(request("answer"));
    await flush();
    client.respond("answer", { status: "answered", answer: "yes" });
    transport.connection("disconnected");
    await flush();
    expect(client.getSnapshot().connection).toBe("disconnected");
    expect(entries(client)["answer"]).toMatchObject({
      status: "pending",
      staleReason: "ack_timeout",
    });
    expect(client.respond("answer", { status: "cancelled" })).toBe(false);
    client.dispose();
  });

  it("closes locally expired interactions and recycles tombstones", async () => {
    const { transport, client } = setup();
    await synchronize(transport);
    transport.requested(request("expires", { expiresAt: NOW + 1_000 }));
    await flush();
    transport.advanceTo(NOW + 1_000);
    await flush();
    expect(entries(client)["expires"]).toMatchObject({
      status: "closed",
      terminalReason: "timeout",
    });
    transport.advanceTo(NOW + 61_000);
    await flush();
    expect(entries(client)["expires"]).toBeUndefined();
    client.dispose();
  });

  it("applies a late ack to the same uncertain attempt", async () => {
    const { transport, client } = setup({ ackTimeoutMs: 10_000 });
    await synchronize(transport);
    transport.requested(request("answer"));
    await flush();
    client.respond("answer", { status: "answered", answer: "yes" });
    transport.advanceTo(NOW + 10_000);
    await flush();
    expect(entries(client)["answer"]).toMatchObject({
      status: "pending",
      staleReason: "ack_timeout",
    });
    transport.ack({ interactionId: "answer", status: "accepted" });
    await flush();
    expect(entries(client)["answer"]?.status).toBe("accepted");
    client.dispose();
  });

  it("ignores an old attempt's ack after a retry", async () => {
    const { transport, client } = setup({ ackTimeoutMs: 10_000 });
    await synchronize(transport);
    transport.requested(request("answer"));
    await flush();
    client.respond("answer", { status: "answered", answer: "first" });
    transport.advanceTo(NOW + 10_000);
    await flush();
    expect(entries(client)["answer"]).toMatchObject({
      status: "pending",
      attempt: 1,
    });

    client.respond("answer", { status: "answered", answer: "second" });
    transport.ack({ interactionId: "answer", status: "unknown_request" }, 0);
    await flush();
    expect(entries(client)["answer"]?.status).toBe("submitting");
    transport.ack({ interactionId: "answer", status: "accepted" }, 1);
    await flush();
    expect(entries(client)["answer"]?.status).toBe("accepted");
    client.dispose();
  });

  it("rejects answers beyond the Server limits before submitting", async () => {
    const { transport, client } = setup();
    await synchronize(transport);
    transport.requested(request("answer"));
    await flush();
    expect(
      client.respond("answer", {
        status: "answered",
        answer: "a".repeat(64 * 1_024 + 1),
      }),
    ).toBe(false);
    expect(entries(client)["answer"]?.status).toBe("pending");
    expect(transport.responses).toHaveLength(0);
    client.dispose();
  });

  it("detaches and silences late frames after dispose", async () => {
    const { transport, client } = setup();
    await synchronize(transport);
    const listener = vi.fn();
    client.subscribe(listener);
    client.dispose();
    expect(transport.detached).toBe(true);
    transport.requested(request("late"));
    await flush();
    expect(listener).not.toHaveBeenCalled();
    expect(client.getSnapshot().entries).toEqual({});
    expect(client.respond("late", { status: "cancelled" })).toBe(false);
  });

  it("keeps two clients isolated", async () => {
    const first = setup();
    const second = setup();
    await synchronize(first.transport);
    await synchronize(second.transport);
    first.transport.requested(request("only-first"));
    await flush();
    expect(Object.keys(entries(first.client))).toEqual(["only-first"]);
    expect(Object.keys(entries(second.client))).toEqual([]);
    first.client.dispose();
    second.client.dispose();
  });
});
