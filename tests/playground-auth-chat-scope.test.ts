import { describe, expect, it } from "vitest";
import {
  createAuthClient,
  type AuthSession,
  type AuthTransport,
} from "../packages/chat-auth/src/headless.js";
import { createChatClient } from "../packages/chat-runtime/src/index.js";
import { createMemoryChatGateway } from "../packages/chat-testing/src/index.js";
import {
  authChatScope,
  observeAuthChatScope,
} from "../playground/src/auth-chat-scope.js";

const fixture = () => {
  let identity = {
    userId: "host-user",
    accountId: "a",
    organizationId: "org-a",
  };
  let session: AuthSession | null = null;
  const transport: AuthTransport = {
    login: async () => {
      session = { kind: "bearer", token: "private-host-fixture" };
      return { kind: "authenticated", account: identity };
    },
    selectAccount: async () => ({ kind: "authenticated", account: identity }),
    switchAccount: async (id) => {
      identity = { ...identity, accountId: id, organizationId: `org-${id}` };
      session = { kind: "bearer", token: "private-host-fixture" };
      return identity;
    },
    listAccounts: async () => [identity],
    getCurrentAccount: async () => identity,
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
    refresh: async () => ({ kind: "bearer", token: "renewed-host-fixture" }),
  };
  return createAuthClient({ environment: "staging", transport });
};

describe("private host authentication and chat ownership", () => {
  it("retains the current chat during refresh and fences an old load after an account switch", async () => {
    const auth = fixture();
    await auth.login({ identifier: "fixture", password: "transient" });
    const createOwnedChat = () => {
      const memory = createMemoryChatGateway();
      return { memory, client: createChatClient({ gateway: memory.gateway }) };
    };
    let owned: ReturnType<typeof createOwnedChat> | undefined =
      createOwnedChat();
    const first = owned;
    const disposals: Promise<unknown>[] = [];
    const unwatch = observeAuthChatScope(auth, (scope) => {
      if (owned !== undefined)
        disposals.push(
          owned.client.dispose({ deadlineAt: Date.now() + 5_000 }),
        );
      owned = scope === undefined ? undefined : createOwnedChat();
    });
    try {
      await auth.refresh();
      expect(owned).toBe(first);
      const hold = first.memory.controller.holdNext("loadConversation");
      const late = first.client.loadConversation({
        conversationId: first.memory.fixtures.conversation.id,
        deadlineAt: Date.now() + 5_000,
      });
      await hold.started;
      const switchIdentity = auth.switchAccount("b");
      expect(owned).toBeUndefined();
      await switchIdentity;
      expect(owned).toBeDefined();
      expect(owned?.client).not.toBe(first.client);
      expect(owned?.client.getSnapshot()).toBeNull();
      hold.release();
      await expect(late).resolves.toMatchObject({ ok: false });
      expect(owned?.client.getSnapshot()).toBeNull();
      await Promise.all(disposals);
      expect(first.client.disposed).toBe(true);
      await auth.logout();
      expect(owned).toBeUndefined();
      await Promise.all(disposals);
    } finally {
      unwatch();
      await owned?.client.dispose({ deadlineAt: Date.now() + 5_000 });
      await auth.dispose();
    }
  });

  it("distinguishes environment, user, account and organization without credentials", async () => {
    const auth = fixture();
    await auth.login({ identifier: "fixture", password: "transient" });
    const snapshot = auth.getSnapshot();
    const base = authChatScope(snapshot);
    expect(base).toBeDefined();
    expect(base).not.toContain("private-host-fixture");
    expect(authChatScope({ ...snapshot, environment: "production" })).not.toBe(
      base,
    );
    for (const field of ["userId", "accountId", "organizationId"] as const) {
      expect(
        authChatScope({
          ...snapshot,
          account: { ...snapshot.account!, [field]: "different" },
        }),
      ).not.toBe(base);
    }
    expect(authChatScope({ ...snapshot, status: "refreshing" })).toBe(base);
    expect(
      authChatScope({ ...snapshot, status: "auth_required" }),
    ).toBeUndefined();
    await auth.dispose();
  });
});
