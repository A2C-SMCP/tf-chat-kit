// @vitest-environment jsdom
import { act, createElement, StrictMode, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AccountSelectionPanel,
  AuthStatus,
  LoginPanel,
  OrganizationSwitcher,
  SessionExpiredNotice,
  type LoginPanelProps,
  type AccountSelectionPanelProps,
  type OrganizationSwitcherProps,
  type SessionExpiredNoticeProps,
  type AuthStatusProps,
} from "../packages/chat-auth/src/antd.js";
import {
  AuthProvider,
  useAuthSelector,
} from "../packages/chat-auth/src/react.js";
import {
  createAuthClient,
  type AccountContext,
  type AuthClient,
  type AuthSession,
  type AuthTransport,
  type LoginResult,
} from "../packages/chat-auth/src/headless.js";

const account = (id = "a"): AccountContext => ({
  userId: "user-a",
  accountId: id,
  organizationId: `org-${id}`,
  displayName: `Account ${id}`,
});
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const fixture = () => {
  let session: AuthSession | null = null;
  const transport: AuthTransport = {
    login: vi.fn(async () => {
      session = { kind: "bearer", token: "fixture-private-token" };
      return { kind: "authenticated" as const, account: account() };
    }),
    selectAccount: vi.fn(async (id) => {
      session = { kind: "bearer", token: "fixture-private-token" };
      return { kind: "authenticated" as const, account: account(id) };
    }),
    switchAccount: vi.fn(async (id) => account(id)),
    listAccounts: vi.fn(async () => [account(), account("b")]),
    getCurrentAccount: async () => account(),
    getSession: async () => session,
    restoreSession: (value) => {
      session = value;
    },
    clearSession: () => {
      session = null;
    },
    logout: vi.fn(async () => {
      session = null;
    }),
  };
  return {
    transport,
    client: createAuthClient({ environment: "staging", transport }),
  };
};

const cleanups: Array<() => void> = [];
const mount = async (client: AuthClient, children: ReactNode) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root: Root = createRoot(container);
  let mounted = true;
  const render = async (nextClient: AuthClient, nextChildren = children) => {
    await act(async () => {
      root.render(
        createElement(AuthProvider, { client: nextClient }, nextChildren),
      );
    });
  };
  const unmount = () => {
    if (mounted) {
      act(() => root.unmount());
      container.remove();
      mounted = false;
    }
  };
  cleanups.push(unmount);
  await render(client);
  return { container, render, unmount };
};
const change = async (input: HTMLInputElement, value: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
const fillAndSubmit = async (container: HTMLElement) => {
  await change(
    container.querySelector<HTMLInputElement>("input#identifier")!,
    "fixture-user",
  );
  await change(
    container.querySelector<HTMLInputElement>("input#password")!,
    "fixture-password",
  );
  await act(async () => {
    container
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
};
const keyboardChooseSecond = async (input: HTMLInputElement) => {
  input.focus();
  for (const [key, keyCode] of [
    ["ArrowDown", 40],
    ["ArrowDown", 40],
    ["Enter", 13],
  ] as const) {
    await act(async () => {
      input.dispatchEvent(
        new KeyboardEvent("keydown", {
          key,
          keyCode,
          which: keyCode,
          bubbles: true,
        }),
      );
    });
  }
};
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
  cleanups
    .splice(0)
    .reverse()
    .forEach((cleanup) => cleanup());
  document.body.innerHTML = "";
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  Reflect.deleteProperty(globalThis, "ResizeObserver");
});

describe("optional authentication UI DOM behavior", () => {
  it("submits customized fields through Headless with theme and callback, without token rendering", async () => {
    const test = fixture();
    const onLogin = vi.fn();
    const view = await mount(
      test.client,
      createElement<LoginPanelProps>(LoginPanel, {
        labels: { login: "Continue" },
        fields: {
          identifier: { label: "Work identity", placeholder: "Email" },
          password: { label: "Passphrase" },
        },
        extraFields: createElement("span", null, "Host field"),
        className: "host-auth",
        theme: { token: { colorPrimary: "#102030" } },
        onLogin,
      }),
    );
    expect(view.container.textContent).toContain("Work identity");
    expect(view.container.textContent).toContain("Passphrase");
    expect(view.container.textContent).toContain("Host field");
    expect(view.container.querySelector(".host-auth")).toBeTruthy();
    expect(
      view.container.querySelector(
        '[aria-label="Environment"] input[role="combobox"]',
      ),
    ).toBeNull();
    await fillAndSubmit(view.container);
    expect(test.transport.login).toHaveBeenCalledWith({
      identifier: "fixture-user",
      password: "fixture-password",
    });
    expect(onLogin).toHaveBeenCalledWith({
      kind: "authenticated",
      account: account(),
    });
    expect(document.body.innerHTML).not.toContain("fixture-private-token");
  });

  it("shows loading and prevents duplicate login while the command is pending", async () => {
    const test = fixture();
    const gate = deferred<LoginResult>();
    test.transport.login = vi.fn(() => gate.promise);
    const view = await mount(test.client, createElement(LoginPanel));
    await fillAndSubmit(view.container);
    expect(view.container.querySelector('form[aria-busy="true"]')).toBeTruthy();
    expect(
      view.container.querySelector<HTMLInputElement>("input#identifier")
        ?.disabled,
    ).toBe(true);
    await act(async () => {
      view.container
        .querySelector("form")!
        .dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        );
    });
    expect(test.transport.login).toHaveBeenCalledTimes(1);
    await act(async () => {
      test.transport.restoreSession?.({
        kind: "bearer",
        token: "fixture-private-token",
      });
      gate.resolve({ kind: "authenticated", account: account() });
    });
    expect(test.client.getSnapshot().status).toBe("authenticated");
  });

  it("displays sanitized errors, clears the password and calls the Host error callback", async () => {
    const test = fixture();
    test.transport.login = vi.fn(async () => {
      throw new Error("Bearer fixture-private-token");
    });
    const onError = vi.fn();
    const view = await mount(
      test.client,
      createElement<LoginPanelProps>(LoginPanel, { onError }),
    );
    await fillAndSubmit(view.container);
    expect(
      view.container.querySelector('[role="alert"]')?.textContent,
    ).toContain("Authentication operation failed");
    expect(
      view.container.querySelector<HTMLInputElement>("input#password")?.value,
    ).toBe("");
    expect(view.container.innerHTML).not.toContain("fixture-private-token");
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ code: "unknown" }),
    );
  });

  it("selects an account using the real Select keyboard path", async () => {
    const test = fixture();
    test.transport.login = async () => ({
      kind: "account-selection-required",
      accounts: [account(), account("b")],
    });
    await test.client.login({ identifier: "fixture", password: "fixture" });
    const onSelected = vi.fn();
    const view = await mount(
      test.client,
      createElement<AccountSelectionPanelProps>(AccountSelectionPanel, {
        onSelected,
      }),
    );
    await keyboardChooseSecond(
      view.container.querySelector<HTMLInputElement>('[role="combobox"]')!,
    );
    expect(test.transport.selectAccount).toHaveBeenCalledWith("b");
    expect(test.client.getSnapshot().account?.accountId).toBe("b");
    expect(onSelected).toHaveBeenCalledTimes(1);
  });

  it("disables empty account choices and displays the configured empty state", async () => {
    const test = fixture();
    test.transport.login = async () => ({
      kind: "account-selection-required",
      accounts: [],
    });
    await test.client.login({ identifier: "fixture", password: "fixture" });
    const view = await mount(
      test.client,
      createElement<AccountSelectionPanelProps>(AccountSelectionPanel, {
        labels: { emptyAccounts: "No membership" },
      }),
    );
    expect(view.container.textContent).toContain("No membership");
    expect(
      view.container.querySelector<HTMLInputElement>('[role="combobox"]')
        ?.disabled,
    ).toBe(true);
    expect(test.transport.selectAccount).not.toHaveBeenCalled();
  });

  it.each([
    [
      new Error("Bearer fixture-private-token"),
      "unknown",
      "Authentication operation failed",
    ],
    [
      { code: "unsupported", message: "Bearer fixture-private-token" },
      "unsupported",
      "Authentication operation is unavailable",
    ],
  ])(
    "keeps a sanitized account-selection error visible after the action settles (%s)",
    async (failure, code, message) => {
      const test = fixture();
      test.transport.login = async () => ({
        kind: "account-selection-required",
        accounts: [account(), account("b")],
      });
      test.transport.selectAccount = vi.fn(async () => {
        throw failure;
      });
      await test.client.login({ identifier: "fixture", password: "fixture" });
      const onError = vi.fn();
      const onSelected = vi.fn();
      const view = await mount(
        test.client,
        createElement<AccountSelectionPanelProps>(AccountSelectionPanel, {
          onError,
          onSelected,
        }),
      );
      await keyboardChooseSecond(
        view.container.querySelector<HTMLInputElement>('[role="combobox"]')!,
      );
      expect(test.client.getSnapshot().status).toBe("error");
      expect(
        view.container.querySelector('[role="alert"]')?.textContent,
      ).toContain(message);
      expect(view.container.querySelector('[role="combobox"]')).toBeNull();
      expect(onSelected).not.toHaveBeenCalled();
      expect(test.transport.selectAccount).toHaveBeenCalledTimes(1);
      expect(view.container.innerHTML).not.toContain("fixture-private-token");
      expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code }));
    },
  );

  it("loads and switches organizations without repeating requests for fresh Host callbacks", async () => {
    const test = fixture();
    await test.client.login({ identifier: "fixture", password: "fixture" });
    const onSwitched = vi.fn();
    const Host = () => {
      useAuthSelector((snapshot) => ({ status: snapshot.status }));
      return createElement<OrganizationSwitcherProps>(OrganizationSwitcher, {
        onSwitched,
        onError: () => undefined,
        renderAccountLabel: (account) => `Host ${account.accountId}`,
      });
    };
    const view = await mount(test.client, createElement(Host));
    expect(test.transport.listAccounts).toHaveBeenCalledTimes(1);
    await keyboardChooseSecond(
      view.container.querySelector<HTMLInputElement>('[role="combobox"]')!,
    );
    expect(test.transport.switchAccount).toHaveBeenCalledWith("b");
    expect(test.client.getSnapshot().account?.accountId).toBe("b");
    expect(onSwitched).toHaveBeenCalledWith(account("b"));
    expect(test.transport.listAccounts).toHaveBeenCalledTimes(2);
    expect(document.body.innerHTML).not.toContain("fixture-private-token");
  });

  it("reports an unavailable account-list capability and preserves authenticated identity", async () => {
    const test = fixture();
    test.transport.listAccounts = async () => {
      throw { code: "unsupported", message: "fixture-private-token" };
    };
    await test.client.login({ identifier: "fixture", password: "fixture" });
    const view = await mount(
      test.client,
      createElement<OrganizationSwitcherProps>(OrganizationSwitcher, {
        labels: { unavailable: "No switch support" },
      }),
    );
    expect(view.container.textContent).toContain("No switch support");
    expect(
      view.container.querySelector<HTMLInputElement>('[role="combobox"]')
        ?.disabled,
    ).toBe(true);
    expect(test.client.getSnapshot().status).toBe("authenticated");
    expect(view.container.innerHTML).not.toContain("fixture-private-token");
  });

  it("delegates allowed environment selection to Host without mutating the current client", async () => {
    const test = fixture();
    const onEnvironmentChange = vi.fn();
    const view = await mount(
      test.client,
      createElement<AuthStatusProps>(AuthStatus, {
        showEnvironmentSelector: true,
        allowedEnvironments: ["staging", "production"],
        onEnvironmentChange,
      }),
    );
    await keyboardChooseSecond(
      view.container.querySelector<HTMLInputElement>(
        '[aria-label="Environment"] input[role="combobox"]',
      )!,
    );
    expect(onEnvironmentChange).toHaveBeenCalledWith("production");
    expect(test.client.environment).toBe("staging");
    await view.render(
      test.client,
      createElement<AuthStatusProps>(AuthStatus, {
        showEnvironmentSelector: true,
        allowedEnvironments: ["production"],
        onEnvironmentChange,
      }),
    );
    expect(view.container.textContent).not.toContain("staging");
    expect(
      view.container.querySelector<HTMLInputElement>(
        '[aria-label="Environment"] input[role="combobox"]',
      )?.disabled,
    ).toBe(true);
  });

  it("shows expired-session and logout states with Host callbacks", async () => {
    const test = fixture();
    await test.client.login({ identifier: "fixture", password: "fixture" });
    const onLogout = vi.fn();
    const view = await mount(
      test.client,
      createElement<AuthStatusProps>(AuthStatus, {
        labels: { logout: "Leave" },
        onLogout,
      }),
    );
    await act(async () => {
      view.container.querySelector<HTMLButtonElement>("button")!.click();
    });
    expect(test.client.getSnapshot().status).toBe("signed_out");
    expect(onLogout).toHaveBeenCalledTimes(1);
    await act(async () => {
      test.client.createSessionProvider().invalidate?.();
    });
    const onReauthenticate = vi.fn();
    await view.render(
      test.client,
      createElement<SessionExpiredNoticeProps>(SessionExpiredNotice, {
        labels: { sessionExpired: "Sign in again" },
        onReauthenticate,
      }),
    );
    expect(
      view.container.querySelector('[role="alert"]')?.textContent,
    ).toContain("Sign in again");
    await act(async () => {
      view.container.querySelector<HTMLButtonElement>("button")!.click();
    });
    expect(onReauthenticate).toHaveBeenCalledTimes(1);
  });

  it("replaces bindings, removes subscriptions and retains external client ownership", async () => {
    const first = fixture();
    const second = fixture();
    const unsubscribes: Array<ReturnType<typeof vi.fn>> = [];
    const subscribe = first.client.subscribe.bind(first.client);
    vi.spyOn(first.client, "subscribe").mockImplementation((listener) => {
      const stop = vi.fn(subscribe(listener));
      unsubscribes.push(stop);
      return stop;
    });
    const dispose = vi.spyOn(first.client, "dispose");
    const StatusObject = () =>
      createElement(
        "span",
        null,
        useAuthSelector((snapshot) => ({ status: snapshot.status })).status,
      );
    const view = await mount(
      first.client,
      createElement(StrictMode, null, createElement(StatusObject)),
    );
    await view.render(second.client, createElement(StatusObject));
    expect(unsubscribes.every((stop) => stop.mock.calls.length === 1)).toBe(
      true,
    );
    expect(dispose).not.toHaveBeenCalled();
    await act(async () => {
      first.client.login({ identifier: "fixture", password: "fixture" });
    });
    expect(view.container.textContent).toBe("signed_out");
    view.unmount();
    expect(second.client.getSnapshot().status).toBe("signed_out");
  });

  it("does not let a replaced client's late login clear new fields or fire a Host callback", async () => {
    const first = fixture();
    const second = fixture();
    const gate = deferred<LoginResult>();
    first.transport.login = () => gate.promise;
    const onLogin = vi.fn();
    const view = await mount(
      first.client,
      createElement<LoginPanelProps>(LoginPanel, { onLogin }),
    );
    await fillAndSubmit(view.container);
    await view.render(
      second.client,
      createElement<LoginPanelProps>(LoginPanel, { onLogin }),
    );
    expect(
      view.container.querySelector<HTMLInputElement>("input#password")?.value,
    ).toBe("");
    await change(
      view.container.querySelector<HTMLInputElement>("input#password")!,
      "new-client-password",
    );
    await act(async () => {
      first.transport.restoreSession?.({
        kind: "bearer",
        token: "fixture-private-token",
      });
      gate.resolve({ kind: "authenticated", account: account() });
    });
    expect(onLogin).not.toHaveBeenCalled();
    expect(second.client.getSnapshot().status).toBe("signed_out");
    expect(
      view.container.querySelector<HTMLInputElement>("input#password")?.value,
    ).toBe("new-client-password");
  });
});
