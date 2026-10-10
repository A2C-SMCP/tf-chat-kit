import { JSDOM } from "jsdom";
import {
  createAuthClient,
  type AuthEnvironment,
  type AuthSession,
  type AuthTransport,
} from "@turingfocus/chat-auth/headless";

export const check = (value: unknown, message: string): void => {
  if (!value) throw new Error(message);
};

export const setupDom = () => {
  const dom = new JSDOM(
    '<!doctype html><html><body><div id="root"></div></body></html>',
    {
      url: "http://localhost/",
    },
  );
  const previous = new Map<string, PropertyDescriptor | undefined>();
  const install = (name: string, value: unknown) => {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value,
    });
  };
  for (const name of [
    "window",
    "document",
    "navigator",
    "HTMLElement",
    "Element",
    "Node",
    "Event",
    "MouseEvent",
    "KeyboardEvent",
    "HTMLInputElement",
    "HTMLTextAreaElement",
    "HTMLSelectElement",
    "HTMLButtonElement",
    "MutationObserver",
    "ShadowRoot",
    "SVGElement",
    "Document",
    "DocumentFragment",
  ] as const) {
    install(name, dom.window[name]);
  }
  install("getComputedStyle", dom.window.getComputedStyle.bind(dom.window));
  install("IS_REACT_ACT_ENVIRONMENT", true);
  install(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Object.defineProperty(dom.window, "matchMedia", {
    value: () => ({
      matches: false,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
    }),
  });
  return {
    container: dom.window.document.getElementById("root")!,
    close: () => {
      dom.window.close();
      for (const [name, descriptor] of previous) {
        if (descriptor === undefined) Reflect.deleteProperty(globalThis, name);
        else Object.defineProperty(globalThis, name, descriptor);
      }
    },
  };
};

export const authFixture = (environment: AuthEnvironment = "staging") => {
  let session: AuthSession | null = null;
  let accountId = "a";
  const account = () => ({
    userId: "packed-user",
    accountId,
    organizationId: `org-${accountId}`,
  });
  const transport: AuthTransport = {
    login: async () => {
      session = {
        kind: "bearer",
        token: `${environment}-private-fixture-credential`,
      };
      return { kind: "authenticated", account: account() };
    },
    selectAccount: async (id) => {
      accountId = id;
      return { kind: "authenticated", account: account() };
    },
    switchAccount: async (id) => {
      accountId = id;
      return account();
    },
    listAccounts: async () => [
      { userId: "packed-user", accountId: "a", organizationId: "org-a" },
      { userId: "packed-user", accountId: "b", organizationId: "org-b" },
    ],
    getCurrentAccount: async () => account(),
    getSession: async () => session,
    restoreSession: (value) => {
      session = value;
    },
    clearSession: () => {
      session = null;
    },
    logout: async () => {
      session = null;
    },
  };
  return { client: createAuthClient({ environment, transport }) };
};
