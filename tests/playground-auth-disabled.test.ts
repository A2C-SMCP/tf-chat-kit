// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { PlaygroundApp } from "../playground/src/app.js";
import { createMockPlaygroundSession } from "../playground/src/playground-session.js";
import { createPlaygroundAuthClient } from "../playground/src/playground-auth.js";

it("keeps authentication-disabled Chat Kit running across independent identity changes", async () => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: () => ({
      matches: false,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
    }),
  });
  const auth = createPlaygroundAuthClient();
  const chat = createMockPlaygroundSession();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        createElement(PlaygroundApp, {
          createAuthClient: () => auth,
          createSession: () => chat,
        }),
      ),
    );
    const enter = [
      ...container.querySelectorAll<HTMLButtonElement>("button"),
    ].find((button) => button.textContent?.includes("进入 Chat Kit"));
    expect(enter).toBeDefined();
    await act(async () => {
      enter!.click();
    });
    expect(chat.client.disposed).toBe(false);
    const before = chat.client.getSnapshot()?.conversation.id;
    expect(before).toBeDefined();
    await act(async () => {
      await auth.login({ identifier: "fixture", password: "transient" });
    });
    await act(async () => {
      await auth.logout();
    });
    expect(chat.client.disposed).toBe(false);
    expect(chat.client.getSnapshot()?.conversation.id).toBe(before);
    expect(container.querySelector('[aria-label="消息"]')).not.toBeNull();
  } finally {
    await act(async () => root.unmount());
    await Promise.all([chat.dispose(), auth.dispose()]);
    container.remove();
    Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  }
});
