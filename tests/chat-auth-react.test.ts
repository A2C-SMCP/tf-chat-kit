// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import { AuthStatus, LoginPanel } from "../packages/chat-auth/src/antd.js";
import { AuthProvider } from "../packages/chat-auth/src/react.js";
import { createAuthClient } from "../packages/chat-auth/src/headless.js";
import type { AuthTransport } from "../packages/chat-auth/src/headless.js";

Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: () => ({
    matches: false,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
  }),
});

const transport: AuthTransport = {
  async login() {
    return {
      kind: "authenticated",
      account: { userId: "user-1", accountId: "account-1" },
    };
  },
  async selectAccount(accountId) {
    return { kind: "authenticated", account: { userId: "user-1", accountId } };
  },
  async getCurrentAccount() {
    return { userId: "user-1", accountId: "account-1" };
  },
  async listAccounts() {
    return [];
  },
  async switchAccount(accountId) {
    return { userId: "user-1", accountId };
  },
  async getSession() {
    return null;
  },
  async logout() {},
};

describe("chat-auth React and default UI bindings", () => {
  it("binds to an external client without taking ownership on unmount", async () => {
    const client = createAuthClient({ environment: "staging", transport });
    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        React.createElement(
          AuthProvider,
          { client },
          React.createElement(AuthStatus),
        ),
      );
    });
    expect(renderer!.toJSON()).toBeTruthy();
    renderer!.unmount();
    expect(client.getSnapshot().status).toBe("signed_out");
    await client.dispose();
  });

  it("renders the default login form without exposing credentials", async () => {
    const client = createAuthClient({ environment: "staging", transport });
    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        React.createElement(
          AuthProvider,
          { client },
          React.createElement(LoginPanel),
        ),
      );
    });
    expect(JSON.stringify(renderer!.toJSON())).not.toContain("secret-token");
    await client.dispose();
    renderer!.unmount();
  });
});
