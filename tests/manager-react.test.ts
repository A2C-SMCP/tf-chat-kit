// @vitest-environment jsdom
import { act, createElement, StrictMode, useCallback } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { ManagerChatProvider } from "../packages/chat-kit/src/manager-react.js";
import {
  createManagerChatController,
  type ManagerChatConnection,
} from "../packages/chat-kit/src/manager.js";

describe("Manager optional React and headless ownership", () => {
  it("rejects late connections and disposes superseded resources", async () => {
    let finish!: (value: ManagerChatConnection) => void;
    const dispose = vi.fn();
    const source = {
      subscribe: () => () => {},
      connect: async () =>
        new Promise<ManagerChatConnection>((resolve) => {
          finish = resolve;
        }),
    };
    const owned = createManagerChatController({
      manager: source,
      chat: {
        messageCreatorProvider: () => ({ name: "Fixture", uid: "user" }),
      },
    });
    const work = owned.select("robot-a");
    await owned.select(undefined);
    finish({
      target: {
        baseUrl: "https://robot.example",
        socketNamespaceUrl: "https://robot.example/chat",
        socketPath: "/socket.io/",
      },
      sessionProvider: {
        getSession: () => ({ kind: "bearer", token: "secret" }),
      },
      dispose,
    });
    await work;
    expect(dispose).toHaveBeenCalledOnce();
    expect(owned.getSnapshot().status).toBe("idle");
    await owned.dispose();
  });
  it("StrictMode, robot switching and unmount release each instance", async () => {
    const releases: ReturnType<typeof vi.fn>[] = [];
    const source = {
      subscribe: () => () => {},
      connect: async () => {
        const dispose = vi.fn();
        releases.push(dispose);
        return {
          target: {
            baseUrl: "https://robot.example",
            socketNamespaceUrl: "https://robot.example/chat",
            socketPath: "/socket.io/",
          },
          sessionProvider: {
            getSession: () => ({ kind: "bearer" as const, token: "secret" }),
          },
          dispose,
        };
      },
    };
    function Host({ robot }: { robot: string }) {
      const create = useCallback(
        () => ({
          manager: source,
          chat: {
            messageCreatorProvider: () => ({ name: "Fixture", uid: "user" }),
          },
        }),
        [],
      );
      return createElement(
        ManagerChatProvider<string>,
        { create, robot },
        "Chat ready",
      );
    }
    const container = document.createElement("div");
    const root = createRoot(container);
    const previous = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    try {
      await act(async () => {
        root.render(
          createElement(StrictMode, null, createElement(Host, { robot: "a" })),
        );
      });
      expect(container.textContent).toBe("Chat ready");
      await act(async () => {
        root.render(
          createElement(StrictMode, null, createElement(Host, { robot: "b" })),
        );
      });
      expect(
        releases
          .slice(0, -1)
          .every((release) => release.mock.calls.length === 1),
      ).toBe(true);
      await act(async () => {
        root.unmount();
      });
      expect(releases.length).toBeGreaterThan(1);
      expect(releases.every((release) => release.mock.calls.length === 1)).toBe(
        true,
      );
    } finally {
      Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previous);
    }
  });
});
