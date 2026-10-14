// @vitest-environment jsdom
import { act, createElement, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ManagerChatApp } from "../packages/chat-kit/src/manager-antd.js";
import { createAuthClient } from "../packages/chat-auth/src/headless.js";
import { createManagerClient } from "../packages/chat-auth/src/manager.js";

beforeEach(() => {
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
  Reflect.set(
    globalThis,
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  document.body.innerHTML = "";
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  Reflect.deleteProperty(globalThis, "ResizeObserver");
});
it("development StrictMode releases every UI subscription and preserves host clients after a late directory reply", async () => {
  const account = { accountId: "a", userId: "u", organizationId: "o" };
  const auth = createAuthClient({
    environment: "staging",
    transport: {
      login: async () => ({ kind: "authenticated", account }),
      selectAccount: async () => ({ kind: "authenticated", account }),
      getCurrentAccount: async () => account,
      listAccounts: async () => [account],
      switchAccount: async () => account,
      getSession: async () => ({ kind: "bearer", token: "fixture-only" }),
      logout: async () => {},
    },
  });
  await auth.login({ identifier: "fixture", password: "fixture" });
  let finish!: (response: Response) => void;
  const manager = createManagerClient({
    auth,
    baseUrl: "https://fixture.invalid",
    routing: {
      allowedOrigins: ["https://fixture.invalid"],
      http: { kind: "routed-server" },
    },
    fetch: async () =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
  });
  let active = 0,
    subscriptions = 0;
  const original = manager.subscribe.bind(manager);
  vi.spyOn(manager, "subscribe").mockImplementation((listener) => {
    active++;
    subscriptions++;
    const unsubscribe = original(listener);
    let disposed = false;
    return () => {
      if (!disposed) {
        disposed = true;
        active--;
        unsubscribe();
      }
    };
  });
  const authDispose = vi.spyOn(auth, "dispose"),
    managerDispose = vi.spyOn(manager, "dispose");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const chat = {
    messageCreatorProvider: () => ({ uid: "u", name: "Fixture" }),
  };
  try {
    await act(async () => {
      root.render(
        createElement(
          StrictMode,
          null,
          createElement(ManagerChatApp, { auth, manager, chat }),
        ),
      );
    });
    expect(subscriptions).toBeGreaterThanOrEqual(4); // Effect setup/cleanup/setup plus directory subscriptions.
    expect(active).toBeGreaterThan(0);
    act(() => root.unmount());
    expect(active).toBe(0);
    expect(authDispose).not.toHaveBeenCalled();
    expect(managerDispose).not.toHaveBeenCalled();
    await act(async () => {
      finish(
        new Response(
          JSON.stringify({
            code: 200,
            data: { items: [], page: 1, pageSize: 20, total: 0 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    });
    expect(container.textContent).toBe("");
    expect(auth.getSnapshot().status).toBe("authenticated");
    expect(manager.getSnapshot().status).not.toBe("disposed");
  } finally {
    await manager.dispose();
    await auth.dispose();
  }
});

it("labels a missing robot name as a directory ID and shows the distinct robot ID", async () => {
  const account = {
    accountId: "account",
    userId: "user",
    organizationId: "org",
  };
  const auth = createAuthClient({
    environment: "staging",
    transport: {
      login: async () => ({ kind: "authenticated", account }),
      selectAccount: async () => ({ kind: "authenticated", account }),
      getCurrentAccount: async () => account,
      listAccounts: async () => [account],
      switchAccount: async () => account,
      getSession: async () => ({ kind: "bearer", token: "fixture-only" }),
      logout: async () => {},
    },
  });
  await auth.login({ identifier: "fixture", password: "fixture" });
  const manager = createManagerClient({
    auth,
    baseUrl: "https://fixture.invalid",
    routing: {
      allowedOrigins: ["https://fixture.invalid"],
      http: { kind: "routed-server" },
    },
    fetch: async () =>
      new Response(
        JSON.stringify({
          code: 200,
          data: {
            items: [
              {
                id: "directory-x",
                robotId: "robot-x",
                robotAccountId: "robot-account",
                status: "running",
                templateType: "tfrserver",
              },
            ],
            page: 1,
            pageSize: 20,
            total: 1,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(
        createElement(ManagerChatApp, {
          auth,
          manager,
          chat: {
            messageCreatorProvider: () => ({ uid: "user", name: "Fixture" }),
          },
        }),
      );
      await manager.refresh();
    });
    const choice = container.querySelector(".tf-choice");
    expect(choice?.textContent).toContain("目录 ID: directory-x");
    expect(choice?.textContent).toContain("机器人 ID: robot-x");
  } finally {
    act(() => root.unmount());
    await manager.dispose();
    await auth.dispose();
  }
});
