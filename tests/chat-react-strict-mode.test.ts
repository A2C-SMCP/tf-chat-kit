// @vitest-environment jsdom

import { StrictMode, act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

import {
  OwnedChatProvider,
  useChatSelector,
  type ChatClientFactory,
} from "../packages/chat-react/src/index.js";
import { createMemoryChatGateway } from "../packages/chat-testing/src/index.js";
import {
  createLoadedClient,
  deadlineAt,
  flushMicrotasks,
} from "./support/chat-react.js";

describe("@turingfocus/chat-react StrictMode", () => {
  it("disposes a partially constructed client when uploader creation fails", async () => {
    const { client } = await createLoadedClient();
    const creationError = new Error("uploader construction failed");
    const factory: ChatClientFactory = {
      create: () => client,
      createAttachmentUploader: () => {
        throw creationError;
      },
      getDisposeOptions: () => ({ deadlineAt: deadlineAt() }),
    };
    const onDisposeError = vi.fn();
    const container = document.createElement("div");
    const root = createRoot(container);
    const previousActEnvironment = Reflect.get(
      globalThis,
      "IS_REACT_ACT_ENVIRONMENT",
    );
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    try {
      await act(async () => {
        root.render(
          createElement(OwnedChatProvider, {
            factory,
            fallback: createElement("span", null, "fallback"),
            onDisposeError,
          }),
        );
        await flushMicrotasks();
      });
      expect(client.disposed).toBe(true);
      expect(onDisposeError).toHaveBeenCalledWith(creationError);
      expect(container.textContent).toBe("fallback");
    } finally {
      await act(async () => {
        root.unmount();
        await flushMicrotasks();
      });
      if (previousActEnvironment === undefined) {
        Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
      } else {
        Reflect.set(
          globalThis,
          "IS_REACT_ACT_ENVIRONMENT",
          previousActEnvironment,
        );
      }
    }
  });

  it("creates a fresh owned client when React replays effects", async () => {
    const first = await createLoadedClient();
    const secondMemory = createMemoryChatGateway();
    secondMemory.controller.setSnapshot({
      ...secondMemory.fixtures.initialSnapshot,
      conversation: {
        ...secondMemory.fixtures.conversation,
        title: "StrictMode replacement",
      },
    });
    const second = await createLoadedClient(secondMemory);
    const clients = [first.client, second.client];
    const factory: ChatClientFactory = {
      create: vi.fn(() => {
        const client = clients.shift();
        if (client === undefined) {
          throw new Error("StrictMode created more clients than expected");
        }
        return client;
      }),
      getDisposeOptions: () => ({ deadlineAt: deadlineAt() }),
    };
    const onDisposeError = vi.fn();
    const Consumer = () =>
      createElement(
        "span",
        null,
        useChatSelector((snapshot) => snapshot?.conversation.title ?? "empty"),
      );
    const container = document.createElement("div");
    const root = createRoot(container);
    const actEnvironmentKey = "IS_REACT_ACT_ENVIRONMENT";
    const previousActEnvironment = Reflect.get(globalThis, actEnvironmentKey);
    Reflect.set(globalThis, actEnvironmentKey, true);
    let unmounted = false;

    try {
      await act(async () => {
        root.render(
          createElement(
            StrictMode,
            null,
            createElement(
              OwnedChatProvider,
              { factory, onDisposeError },
              createElement(Consumer),
            ),
          ),
        );
        await flushMicrotasks();
      });

      expect(factory.create).toHaveBeenCalledTimes(2);
      expect(first.client).not.toBe(second.client);
      expect(first.client.disposed).toBe(true);
      expect(second.client.disposed).toBe(false);
      expect(container.textContent).toBe("StrictMode replacement");

      await act(async () => {
        root.unmount();
        await flushMicrotasks();
      });
      unmounted = true;
      expect(second.client.disposed).toBe(true);
      expect(onDisposeError).not.toHaveBeenCalled();
    } finally {
      if (!unmounted) {
        await act(async () => {
          root.unmount();
          await flushMicrotasks();
        });
      }
      if (previousActEnvironment === undefined) {
        Reflect.deleteProperty(globalThis, actEnvironmentKey);
      } else {
        Reflect.set(globalThis, actEnvironmentKey, previousActEnvironment);
      }
    }
  });
});
