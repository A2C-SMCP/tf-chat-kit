// @vitest-environment jsdom
import { act, createElement, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  ManagerChatApp,
  type ManagerChatIdentity,
} from "../packages/chat-kit/src/manager-antd.js";
import { createAuthClient } from "../packages/chat-auth/src/headless.js";
import { createManagerClient } from "../packages/chat-auth/src/manager.js";
import type { InteractionClient } from "../packages/chat-runtime/src/index.js";

const interactionClient = {
  activate: () => undefined,
  dispose: () => undefined,
  getSnapshot: () => ({
    activeId: null,
    connection: "disconnected" as const,
    entries: {},
    now: 0,
  }),
  respond: () => false,
  retry: () => false,
  subscribe: () => () => undefined,
} as unknown as InteractionClient;

const createFixture = async () => {
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
    fetch: async (input) => {
      const url = new URL(
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url,
      );
      if (url.pathname.endsWith("/digital-employees"))
        return new Response(
          JSON.stringify({
            code: 200,
            data: {
              items: [
                {
                  id: "a",
                  name: "Robot A",
                  robotId: "robot-a",
                  robotAccountId: "account-a",
                  status: "running",
                  templateType: "tfrserver",
                },
                {
                  id: "b",
                  name: "Robot B",
                  robotId: "robot-b",
                  robotAccountId: "account-b",
                  status: "running",
                  templateType: "tfrserver",
                },
              ],
              page: 1,
              pageSize: 20,
              total: 2,
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      return new Response("{}", {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    },
  });
  return { auth, manager };
};

const findButton = (
  container: HTMLElement,
  text: string,
): HTMLButtonElement | undefined =>
  [...container.querySelectorAll("button")].find((button) =>
    button.textContent?.includes(text),
  );

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

it("requires an identity for a non-null Interaction client", async () => {
  const { auth, manager } = await createFixture();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const chat = {
    messageCreatorProvider: () => ({ uid: "user", name: "Fixture" }),
  };
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    expect(() => {
      act(() => {
        root.render(
          createElement(ManagerChatApp, {
            auth,
            manager,
            chat,
            interactionClient,
          }),
        );
      });
    }).toThrow(/interactionIdentity/u);
    consoleError.mockRestore();
    await act(async () => {
      root.render(
        createElement(ManagerChatApp, {
          allowUnscopedInteractionClient: true,
          auth,
          manager,
          chat,
          interactionClient,
        }),
      );
    });
  } finally {
    act(() => root.unmount());
    await manager.dispose();
    await auth.dispose();
  }
});

it("emits Manager identity changes and scopes the Interaction client", async () => {
  const { auth, manager } = await createFixture();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const changes: Array<ManagerChatIdentity | undefined> = [];
  const chat = {
    messageCreatorProvider: () => ({ uid: "user", name: "Fixture" }),
  };
  try {
    await act(async () => {
      root.render(
        createElement(ManagerChatApp, {
          auth,
          manager,
          chat,
          interactionClient,
          interactionIdentity: { robotId: "robot-a" },
          onChatIdentityChange: (identity) => changes.push(identity),
        }),
      );
    });
    await act(async () => {
      await manager.refresh();
    });
    await vi.waitFor(() => {
      expect(container.querySelectorAll(".tf-choice")).toHaveLength(2);
    });
    act(() => {
      container.querySelectorAll<HTMLButtonElement>(".tf-choice")[0]?.click();
    });
    const useA = findButton(container, "使用这个机器人");
    expect(useA).toBeDefined();
    await act(async () => {
      useA?.click();
      await Promise.resolve();
    });
    expect(changes.at(-1)).toMatchObject({
      accountId: "account",
      organizationId: "org",
      robotId: "robot-a",
      userId: "user",
    });

    await vi.waitFor(() => {
      expect(findButton(container, "返回")).toBeDefined();
    });
    act(() => {
      findButton(container, "返回")?.click();
    });
    await vi.waitFor(() => {
      expect(container.querySelectorAll(".tf-choice")).toHaveLength(2);
    });
    act(() => {
      container.querySelectorAll<HTMLButtonElement>(".tf-choice")[1]?.click();
    });
    const useB = findButton(container, "使用这个机器人");
    expect(useB).toBeDefined();
    await act(async () => {
      useB?.click();
      await Promise.resolve();
    });
    expect(changes.at(-1)).toMatchObject({ robotId: "robot-b" });
  } finally {
    act(() => root.unmount());
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
