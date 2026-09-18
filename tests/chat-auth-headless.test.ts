import { describe, expect, it } from "vitest";

import {
  createAuthClient,
  type AccountContext,
  type AuthSession,
  type AuthTransport,
  type CredentialRecord,
  type CredentialScope,
  type CredentialStore,
} from "../packages/chat-auth/src/headless.js";

const account = (accountId: string): AccountContext => ({
  userId: "user-1",
  accountId,
  organizationId: `org-${accountId}`,
});

const session: AuthSession = { kind: "bearer", token: "secret-token" };

class MemoryTransport implements AuthTransport {
  readonly calls: string[] = [];
  refresh?: () => Promise<AuthSession>;
  current: AccountContext | undefined;
  loginResult: Awaited<ReturnType<AuthTransport["login"]>> = {
    kind: "authenticated",
    account: account("account-1"),
  };

  async login(): Promise<Awaited<ReturnType<AuthTransport["login"]>>> {
    this.calls.push("login");
    this.current =
      this.loginResult.kind === "authenticated" ||
      this.loginResult.kind === "onboarding-required"
        ? this.loginResult.account
        : undefined;
    return this.loginResult;
  }

  async selectAccount(accountId: string) {
    this.calls.push(`select:${accountId}`);
    this.current = account(accountId);
    return { kind: "authenticated" as const, account: this.current };
  }

  async getCurrentAccount() {
    this.calls.push("me");
    if (!this.current) throw new Error("not authenticated");
    return this.current;
  }

  async listAccounts() {
    this.calls.push("accounts");
    return [account("account-1"), account("account-2")];
  }

  async switchAccount(accountId: string) {
    this.calls.push(`switch:${accountId}`);
    this.current = account(accountId);
    return this.current;
  }

  async getSession() {
    this.calls.push("session");
    return this.current ? session : null;
  }

  restoreSession(next: AuthSession) {
    this.current = account("account-1");
    void next;
  }

  async logout() {
    this.calls.push("logout");
    this.current = undefined;
  }

  clearSession() {
    this.current = undefined;
  }
}

class MemoryCredentialStore implements CredentialStore {
  readonly records = new Map<string, CredentialRecord>();
  scopeKey(scope: CredentialScope) {
    return [
      scope.environment,
      scope.userId,
      scope.accountId,
      scope.organizationId,
    ].join(":");
  }
  async read(scope: CredentialScope) {
    return this.records.get(this.scopeKey(scope)) ?? null;
  }
  async write(scope: CredentialScope, record: CredentialRecord) {
    this.records.set(this.scopeKey(scope), record);
  }
  async clear(scope: CredentialScope) {
    this.records.delete(this.scopeKey(scope));
  }
}

describe("chat-auth headless AuthClient", () => {
  it("keeps login state and credentials instance-scoped", async () => {
    const store = new MemoryCredentialStore();
    const firstTransport = new MemoryTransport();
    const secondTransport = new MemoryTransport();
    const scope = {
      environment: "staging" as const,
      userId: "user-1",
      accountId: "account-1",
      organizationId: "org-account-1",
    };
    const first = createAuthClient({
      environment: "staging",
      transport: firstTransport,
      credentialStore: store,
      credentialScope: scope,
    });
    const second = createAuthClient({
      environment: "production",
      transport: secondTransport,
    });

    await first.login({
      identifier: "user@example.test",
      password: "transient",
    });
    expect(first.getSnapshot()).toMatchObject({
      status: "authenticated",
      environment: "staging",
    });
    expect(second.getSnapshot()).toMatchObject({
      status: "signed_out",
      environment: "production",
    });
    expect(store.records.size).toBe(1);
    expect(JSON.stringify(first.getSnapshot())).not.toContain("secret-token");
  });

  it("drops late generation results and stays silent after dispose", async () => {
    let resolveLogin!: (
      value: Awaited<ReturnType<AuthTransport["login"]>>,
    ) => void;
    const transport = new MemoryTransport();
    const pending = new Promise<Awaited<ReturnType<AuthTransport["login"]>>>(
      (resolve) => {
        resolveLogin = resolve;
      },
    );
    transport.login = () => pending;
    const client = createAuthClient({ environment: "staging", transport });
    const snapshots: string[] = [];
    client.subscribe((next) => snapshots.push(next.status));
    const login = client.login({ identifier: "user", password: "one-time" });
    await client.dispose();
    resolveLogin({ kind: "authenticated", account: account("late") });
    await login;
    expect(client.getSnapshot().status).toBe("disposed");
    expect(snapshots).toEqual(["authenticating"]);
  });

  it("maps missing sessions to auth-required through SessionProvider", async () => {
    const client = createAuthClient({
      environment: "production",
      transport: new MemoryTransport(),
    });
    const provider = client.createSessionProvider();
    await expect(provider.getSession()).rejects.toMatchObject({
      authError: { code: "authentication_required" },
    });
    expect(client.getSnapshot()).toMatchObject({ status: "auth_required" });
  });

  it("rejects a credential scope from another environment", () => {
    expect(() =>
      createAuthClient({
        environment: "staging",
        transport: new MemoryTransport(),
        credentialScope: {
          environment: "production",
          userId: "user-1",
          accountId: "account-1",
        },
      }),
    ).toThrow("Credential scope environment");
  });

  it("coalesces concurrent refreshes and degrades safely when refresh is unavailable", async () => {
    const transport = new MemoryTransport();
    let refreshCalls = 0;
    transport.refresh = async () => {
      refreshCalls += 1;
      await Promise.resolve();
      return { kind: "bearer", token: `refreshed-${refreshCalls}` };
    };
    const client = createAuthClient({ environment: "staging", transport });
    const [first, second] = await Promise.all([
      client.refresh(),
      client.refresh(),
    ]);
    expect(first).toEqual(second);
    expect(refreshCalls).toBe(1);

    const unavailable = createAuthClient({
      environment: "production",
      transport: new MemoryTransport(),
    });
    await expect(unavailable.refresh()).rejects.toMatchObject({
      authError: { code: "authentication_required" },
    });
    expect(unavailable.getSnapshot().status).toBe("auth_required");
  });

  it("rejects mismatched persisted identity and redacts unknown error text", async () => {
    const store = new MemoryCredentialStore();
    const scope = {
      environment: "staging" as const,
      userId: "user-1",
      accountId: "account-1",
      organizationId: "org-account-1",
    };
    await store.write(scope, {
      version: 1,
      environment: "staging",
      userId: "user-1",
      accountId: "account-2",
      organizationId: "org-account-2",
      session,
    });
    const transport = new MemoryTransport();
    const client = createAuthClient({
      environment: "staging",
      transport,
      credentialStore: store,
      credentialScope: scope,
    });
    await client.restore();
    expect(client.getSnapshot().status).toBe("signed_out");
    expect(store.records.size).toBe(0);

    transport.login = async () => {
      throw new Error("Bearer secret-token");
    };
    await expect(client.login({ identifier: "u", password: "p" })).rejects.toThrow();
    expect(JSON.stringify(client.getSnapshot())).not.toContain("secret-token");
  });

  it("retries an operation once after a 401 using the refreshed session", async () => {
    const transport = new MemoryTransport();
    transport.current = account("account-1");
    transport.refresh = async () => ({ kind: "bearer", token: "rotated-token" });
    const provider = createAuthClient({ environment: "staging", transport }).createSessionProvider();
    let attempts = 0;
    await expect(
      provider.withAuthRetry(async () => {
        attempts += 1;
        if (attempts === 1) throw Object.assign(new Error("expired"), { status: 401 });
        return "ok";
      }),
    ).resolves.toBe("ok");
    expect(attempts).toBe(2);
  });

  it("clears credentials when the one allowed retry is also unauthorized", async () => {
    const store = new MemoryCredentialStore();
    const scope = {
      environment: "staging" as const,
      userId: "user-1",
      accountId: "account-1",
      organizationId: "org-account-1",
    };
    const transport = new MemoryTransport();
    transport.current = account("account-1");
    transport.refresh = async () => ({ kind: "bearer", token: "rotated-token" });
    const client = createAuthClient({
      environment: "staging",
      transport,
      credentialStore: store,
      credentialScope: scope,
    });
    const provider = client.createSessionProvider();
    await expect(
      provider.withAuthRetry(async () => {
        throw Object.assign(new Error("expired"), { status: 401 });
      }),
    ).rejects.toThrow("expired");
    expect(client.getSnapshot().status).toBe("auth_required");
    await expect(provider.getSession()).rejects.toMatchObject({
      authError: { code: "authentication_required" },
    });
  });
});
