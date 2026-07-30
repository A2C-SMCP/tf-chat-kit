// @vitest-environment jsdom

import { StrictMode, createElement, useEffect } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";

import {
  createChatClient,
  type ChatClient,
} from "../packages/chat-runtime/src/index.js";
import { createMemoryChatGateway } from "../packages/chat-testing/src/index.js";
import {
  ChatPathLifecycleController,
  type ChatPath,
  type ChatPathFactory,
  type ChatPathKind,
  type ChatPathLifecycleState,
} from "./support/chat-path-lifecycle.js";

const deadlineAt = (): number => Date.now() + 60_000;

interface PathRecord {
  readonly client: ChatClient;
  readonly gateway: ReturnType<typeof createMemoryChatGateway>;
  readonly id: string;
  readonly kind: ChatPathKind;
  readonly notifications: string[];
  readonly sends: string[];
  readonly deadlines: number[];
  active: boolean;
  disposeAttempts: number;
}

interface PathFactoryHarness {
  readonly createStarted: Promise<void>;
  readonly disposeStarted: Promise<void>;
  readonly factory: ChatPathFactory;
  readonly records: PathRecord[];
  readonly sendStarted: Promise<void>;
  releaseCreate(): void;
  releaseDispose(): void;
  releaseSend(): void;
}

const createPathFactory = (
  kind: ChatPathKind,
  options: {
    readonly failCreateOnce?: boolean;
    readonly failDisposeAttempts?: number;
    readonly holdCreateOnce?: boolean;
    readonly holdDisposeOnce?: boolean;
    readonly holdSendOnce?: boolean;
  } = {},
): PathFactoryHarness => {
  const records: PathRecord[] = [];
  let createAttempts = 0;
  let releaseCreate!: () => void;
  let releaseDispose!: () => void;
  let releaseSend!: () => void;
  let markCreateStarted!: () => void;
  let markDisposeStarted!: () => void;
  let markSendStarted!: () => void;
  const createReleased = new Promise<void>((resolve) => {
    releaseCreate = resolve;
  });
  const createStarted = new Promise<void>((resolve) => {
    markCreateStarted = resolve;
  });
  const disposeReleased = new Promise<void>((resolve) => {
    releaseDispose = resolve;
  });
  const disposeStarted = new Promise<void>((resolve) => {
    markDisposeStarted = resolve;
  });
  const sendReleased = new Promise<void>((resolve) => {
    releaseSend = resolve;
  });
  const sendStarted = new Promise<void>((resolve) => {
    markSendStarted = resolve;
  });

  return {
    createStarted,
    disposeStarted,
    records,
    releaseCreate,
    releaseDispose,
    releaseSend,
    sendStarted,
    factory: {
      async create(): Promise<ChatPath> {
        createAttempts += 1;
        const gateway = createMemoryChatGateway();
        const client = createChatClient({ gateway: gateway.gateway });
        const id = `${kind}-${createAttempts}`;
        const record: PathRecord = {
          active: true,
          client,
          deadlines: [],
          disposeAttempts: 0,
          gateway,
          id,
          kind,
          notifications: [],
          sends: [],
        };
        records.push(record);
        markCreateStarted();
        if (options.holdCreateOnce && createAttempts === 1) {
          await createReleased;
        }
        const loaded = await client.loadConversation({
          conversationId: gateway.fixtures.conversation.id,
          deadlineAt: deadlineAt(),
        });
        if (!loaded.ok) throw new Error(`${id} failed to load`);
        const subscription = client.subscribe((snapshot) => {
          record.notifications.push(snapshot?.conversation.id ?? "empty");
        });

        if (options.failCreateOnce && createAttempts === 1) {
          subscription.dispose();
          record.active = false;
          await client.dispose({ deadlineAt: deadlineAt() });
          throw new Error(`${kind} create failed`);
        }

        return {
          kind,
          async dispose(disposeOptions): Promise<void> {
            record.disposeAttempts += 1;
            record.deadlines.push(disposeOptions.deadlineAt);
            markDisposeStarted();
            if (options.holdDisposeOnce && record.disposeAttempts === 1) {
              await disposeReleased;
            }
            if (record.disposeAttempts <= (options.failDisposeAttempts ?? 0)) {
              throw new Error(`${kind} dispose failed`);
            }
            subscription.dispose();
            record.active = false;
            await client.dispose(disposeOptions);
          },
          async send(text): Promise<void> {
            record.sends.push(text);
            markSendStarted();
            if (options.holdSendOnce && record.sends.length === 1) {
              await sendReleased;
            }
            const result = await client.sendText({
              conversationId: gateway.fixtures.conversation.id,
              deadlineAt: deadlineAt(),
              text,
            });
            if (!result.ok) throw new Error(`${id} send failed`);
          },
        };
      },
    },
  };
};

const activeCount = (...harnesses: PathFactoryHarness[]): number =>
  harnesses.flatMap(({ records }) => records).filter(({ active }) => active)
    .length;

const createController = (
  legacy: PathFactoryHarness,
  kit: PathFactoryHarness,
  options: {
    readonly onStateChange?: (state: ChatPathLifecycleState) => void;
  } = {},
) => {
  const activationErrors: Array<readonly [ChatPathKind, unknown]> = [];
  const disposeErrors: Array<readonly [ChatPathKind, unknown]> = [];
  const fallbacks: unknown[] = [];
  const states: ChatPathLifecycleState[] = [];
  const deadlines: number[] = [];
  let nextDeadline = 10_000;
  const controller = new ChatPathLifecycleController({
    factories: {
      kit: kit.factory,
      legacy: legacy.factory,
    },
    getDisposeDeadlineAt: () => {
      nextDeadline += 1;
      deadlines.push(nextDeadline);
      return nextDeadline;
    },
    onActivationError: (path, error) => activationErrors.push([path, error]),
    onDisposeError: (path, error) => disposeErrors.push([path, error]),
    onFallback: (error) => fallbacks.push(error),
    onStateChange: (state) => {
      states.push(state);
      options.onStateChange?.(state);
    },
  });
  return {
    activationErrors,
    controller,
    deadlines,
    disposeErrors,
    fallbacks,
    states,
  };
};

const stateLabels = (states: readonly ChatPathLifecycleState[]): string[] =>
  states.map((state) => {
    switch (state.kind) {
      case "active":
        return `active:${state.path}`;
      case "activating":
      case "activation-failed":
        return `${state.kind}:${state.target}`;
      case "deactivating":
      case "blocked-dispose":
        return `${state.kind}:${state.path}->${state.target ?? "none"}`;
      case "idle":
        return "idle";
    }
  });

describe("host Feature Flag lifecycle model", () => {
  it("keeps legacy and Kit ownership mutually exclusive across off-on-off and route unmount", async () => {
    const legacy = createPathFactory("legacy");
    const kit = createPathFactory("kit");
    const { controller, deadlines, disposeErrors, fallbacks, states } =
      createController(legacy, kit);

    await controller.select(false);
    expect(controller.activePath).toBe("legacy");
    expect(activeCount(legacy, kit)).toBe(1);
    await controller.send("legacy send");
    expect(legacy.records[0]?.sends).toEqual(["legacy send"]);

    await controller.select(true);
    expect(controller.activePath).toBe("kit");
    expect(legacy.records[0]?.client.disposed).toBe(true);
    expect(activeCount(legacy, kit)).toBe(1);
    await controller.send("kit send");
    expect(kit.records[0]?.sends).toEqual(["kit send"]);

    const disposedNotificationCount = kit.records[0]!.notifications.length;
    await controller.select(false);
    kit.records[0]!.gateway.controller.emitUpdateToAll(
      kit.records[0]!.gateway.fixtures.realtimeMessageUpdate,
    );
    expect(kit.records[0]?.notifications).toHaveLength(
      disposedNotificationCount,
    );
    expect(controller.activePath).toBe("legacy");
    expect(activeCount(legacy, kit)).toBe(1);

    await controller.dispose();
    expect(controller.state).toEqual({ kind: "idle" });
    expect(activeCount(legacy, kit)).toBe(0);
    expect(
      [
        ...[...legacy.records, ...kit.records].flatMap(
          ({ deadlines: received }) => received,
        ),
      ].sort((left, right) => left - right),
    ).toEqual(deadlines);
    expect(new Set(deadlines).size).toBe(deadlines.length);
    expect(stateLabels(states)).toEqual([
      "activating:legacy",
      "active:legacy",
      "deactivating:legacy->kit",
      "activating:kit",
      "active:kit",
      "deactivating:kit->legacy",
      "activating:legacy",
      "active:legacy",
      "deactivating:legacy->none",
      "idle",
    ]);
    expect(disposeErrors).toEqual([]);
    expect(fallbacks).toEqual([]);
  });

  it("coalesces StrictMode effect replay and releases the selected path on unmount", async () => {
    const legacy = createPathFactory("legacy");
    const kit = createPathFactory("kit");
    const { controller, states } = createController(legacy, kit);
    const Harness = ({ useKit }: { readonly useKit: boolean }) => {
      useEffect(() => {
        void controller.select(useKit);
        return () => {
          void controller.dispose();
        };
      }, [useKit]);
      return null;
    };
    const container = document.createElement("div");
    const root = createRoot(container);
    const previous = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

    try {
      await act(async () => {
        root.render(
          createElement(
            StrictMode,
            null,
            createElement(Harness, { useKit: false }),
          ),
        );
        await controller.settled();
      });
      await controller.settled();
      expect(controller.activePath).toBe("legacy");
      expect(activeCount(legacy, kit)).toBe(1);
      expect(legacy.records).toHaveLength(1);
      expect(kit.records).toHaveLength(0);

      const record = legacy.records[0]!;
      const notificationCount = record.notifications.length;
      await act(async () => {
        root.unmount();
        await controller.settled();
      });
      await controller.settled();
      expect(activeCount(legacy, kit)).toBe(0);
      record.gateway.controller.emitUpdateToAll(
        record.gateway.fixtures.realtimeMessageUpdate,
      );
      expect(record.notifications).toHaveLength(notificationCount);
      expect(stateLabels(states)).toEqual([
        "activating:legacy",
        "active:legacy",
        "deactivating:legacy->none",
        "idle",
      ]);
    } finally {
      if (previous === undefined) {
        Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
      } else {
        Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previous);
      }
    }
  });

  it("falls back observably when Kit creation fails without leaking the failed path", async () => {
    const legacy = createPathFactory("legacy");
    const kit = createPathFactory("kit", { failCreateOnce: true });
    const { activationErrors, controller, fallbacks, states } =
      createController(legacy, kit);

    await controller.select(false);
    await controller.select(true);

    expect(controller.activePath).toBe("legacy");
    expect(fallbacks).toHaveLength(1);
    expect(activationErrors).toHaveLength(1);
    expect(kit.records[0]?.client.disposed).toBe(true);
    expect(activeCount(legacy, kit)).toBe(1);
    expect(stateLabels(states).slice(-3)).toEqual([
      "deactivating:legacy->kit",
      "activating:kit",
      "active:legacy",
    ]);
    await controller.dispose();
  });

  it("fails closed when disposal cannot be proven before activating a replacement", async () => {
    const legacy = createPathFactory("legacy", { failDisposeAttempts: 1 });
    const kit = createPathFactory("kit");
    const { controller, deadlines, disposeErrors, states } = createController(
      legacy,
      kit,
    );

    await controller.select(false);
    await controller.select(true);

    expect(controller.state).toMatchObject({
      kind: "blocked-dispose",
      path: "legacy",
      target: "kit",
    });
    expect(disposeErrors).toHaveLength(1);
    expect(kit.records).toHaveLength(0);
    expect(activeCount(legacy, kit)).toBe(1);
    expect(legacy.records[0]?.active).toBe(true);

    await controller.select(true);
    expect(controller.state).toEqual({ kind: "active", path: "kit" });
    expect(legacy.records[0]?.disposeAttempts).toBe(2);
    expect(activeCount(legacy, kit)).toBe(1);
    expect(stateLabels(states).slice(-3)).toEqual([
      "deactivating:legacy->kit",
      "activating:kit",
      "active:kit",
    ]);
    expect(legacy.records[0]?.deadlines).toEqual(deadlines.slice(0, 2));
    await controller.dispose();
  });

  it("retains a superseded path when its cleanup fails and retries before replacement", async () => {
    const legacy = createPathFactory("legacy");
    const kit = createPathFactory("kit", {
      failDisposeAttempts: 2,
      holdCreateOnce: true,
    });
    const { controller, disposeErrors, states } = createController(legacy, kit);

    const selectKit = controller.select(true);
    await kit.createStarted;
    const selectLegacy = controller.select(false);
    kit.releaseCreate();
    await Promise.all([selectKit, selectLegacy]);

    expect(controller.state).toMatchObject({
      kind: "blocked-dispose",
      path: "kit",
      target: "legacy",
    });
    expect(controller.activePath).toBe("kit");
    expect(kit.records[0]?.disposeAttempts).toBe(2);
    expect(kit.records[0]?.active).toBe(true);
    expect(legacy.records).toHaveLength(0);
    expect(activeCount(legacy, kit)).toBe(1);
    expect(disposeErrors).toHaveLength(2);

    await controller.select(false);
    expect(kit.records[0]?.disposeAttempts).toBe(3);
    expect(controller.state).toEqual({ kind: "active", path: "legacy" });
    expect(activeCount(legacy, kit)).toBe(1);
    expect(stateLabels(states).slice(-3)).toEqual([
      "deactivating:kit->legacy",
      "activating:legacy",
      "active:legacy",
    ]);
    await controller.dispose();
  });

  it("cleans retained ownership before rolling back to a fresh path of the same kind", async () => {
    const legacy = createPathFactory("legacy", { failDisposeAttempts: 1 });
    const kit = createPathFactory("kit");
    const { controller, states } = createController(legacy, kit);

    await controller.select(false);
    await controller.select(true);
    expect(controller.state).toMatchObject({
      kind: "blocked-dispose",
      path: "legacy",
      target: "kit",
    });
    await expect(controller.send("must stay blocked")).rejects.toThrow(
      "No chat path is active",
    );

    await controller.select(false);
    expect(legacy.records).toHaveLength(2);
    expect(legacy.records[0]?.disposeAttempts).toBe(2);
    expect(legacy.records[0]?.active).toBe(false);
    expect(controller.state).toEqual({ kind: "active", path: "legacy" });
    expect(activeCount(legacy, kit)).toBe(1);
    expect(stateLabels(states).slice(-3)).toEqual([
      "deactivating:legacy->legacy",
      "activating:legacy",
      "active:legacy",
    ]);

    await controller.send("fresh legacy");
    expect(legacy.records[1]?.sends).toEqual(["fresh legacy"]);
    await controller.dispose();
  });

  it("isolates state observer failures from activation and fallback decisions", async () => {
    const legacy = createPathFactory("legacy");
    const kit = createPathFactory("kit");
    const { activationErrors, controller, fallbacks } = createController(
      legacy,
      kit,
      {
        onStateChange: (state) => {
          if (state.kind === "active" && state.path === "kit") {
            throw new Error("observer failed");
          }
        },
      },
    );

    await controller.select(false);
    await controller.select(true);

    expect(controller.state).toEqual({ kind: "active", path: "kit" });
    expect(controller.activePath).toBe("kit");
    expect(activeCount(legacy, kit)).toBe(1);
    expect(activationErrors).toEqual([]);
    expect(fallbacks).toEqual([]);
    await controller.dispose();
  });

  it("rejects new sends from selection intent through asynchronous disposal", async () => {
    const legacy = createPathFactory("legacy", { holdDisposeOnce: true });
    const kit = createPathFactory("kit");
    const { controller, states } = createController(legacy, kit);

    await controller.select(false);
    const switching = controller.select(true);
    await legacy.disposeStarted;

    expect(controller.state).toEqual({
      kind: "deactivating",
      path: "legacy",
      target: "kit",
    });
    await expect(controller.send("late legacy send")).rejects.toThrow(
      "No chat path is active",
    );
    expect(legacy.records[0]?.sends).toEqual([]);
    expect(kit.records).toHaveLength(0);

    legacy.releaseDispose();
    await switching;
    expect(controller.state).toEqual({ kind: "active", path: "kit" });
    expect(stateLabels(states).slice(-3)).toEqual([
      "deactivating:legacy->kit",
      "activating:kit",
      "active:kit",
    ]);
    await controller.dispose();
  });

  it("finishes an accepted send before disposing its path", async () => {
    const legacy = createPathFactory("legacy", { holdSendOnce: true });
    const kit = createPathFactory("kit");
    const { controller } = createController(legacy, kit);

    await controller.select(false);
    const sending = controller.send("accepted legacy send");
    await legacy.sendStarted;
    const switching = controller.select(true);

    expect(controller.state).toEqual({
      kind: "deactivating",
      path: "legacy",
      target: "kit",
    });
    expect(legacy.records[0]?.disposeAttempts).toBe(0);

    legacy.releaseSend();
    await Promise.all([sending, switching]);
    expect(legacy.records[0]?.sends).toEqual(["accepted legacy send"]);
    expect(legacy.records[0]?.disposeAttempts).toBe(1);
    expect(controller.state).toEqual({ kind: "active", path: "kit" });
    await controller.dispose();
  });
});
