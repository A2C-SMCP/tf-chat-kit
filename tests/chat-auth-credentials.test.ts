import { describe, expect, it, vi } from "vitest";
import {
  createAuthClient,
  type AccountContext,
  type AuthSession,
  type AuthTransport,
  type CredentialRecord,
  type CredentialScope,
  type CredentialStore,
} from "../packages/chat-auth/src/headless.js";

const account: AccountContext = {
  userId: "user-a",
  accountId: "account-a",
  organizationId: "org-a",
};
const scope: CredentialScope = { environment: "staging", ...account };
const session: AuthSession = {
  kind: "bearer" as const,
  token: "fixture-credential",
  expiresAt: 160_000,
};
const record: CredentialRecord = { version: 1, ...scope, session };
const input = { identifier: "fixture", password: "transient-fixture" };
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

class InjectedStore implements CredentialStore {
  readonly records = new Map<string, CredentialRecord>();
  key(scope: CredentialScope) {
    return JSON.stringify([
      scope.environment,
      scope.userId,
      scope.accountId,
      scope.organizationId,
    ]);
  }
  read = vi.fn(async (scope: CredentialScope) =>
    structuredClone(this.records.get(this.key(scope)) ?? null),
  );
  write = vi.fn(async (scope: CredentialScope, record: CredentialRecord) => {
    this.records.set(this.key(scope), structuredClone(record));
  });
  clear = vi.fn(async (scope: CredentialScope) => {
    this.records.delete(this.key(scope));
  });
}
const transportFixture = () => {
  let current: AuthSession | null = null;
  const transport: AuthTransport = {
    login: vi.fn(async () => {
      current = { ...session };
      return { kind: "authenticated" as const, account };
    }),
    selectAccount: async () => ({ kind: "authenticated" as const, account }),
    switchAccount: async () => account,
    listAccounts: async () => [account],
    getCurrentAccount: vi.fn(async () => {
      if (current === null) throw new Error("Missing session");
      return account;
    }),
    getSession: async () => current,
    restoreSession: vi.fn((value) => {
      current = { ...value };
    }),
    clearSession: () => {
      current = null;
    },
    logout: async () => {
      current = null;
    },
  };
  return transport;
};
const clientFixture = async (stored: unknown = record) => {
  const store = new InjectedStore();
  await store.write(scope, stored as CredentialRecord);
  const transport = transportFixture();
  const client = createAuthClient({
    environment: "staging",
    transport,
    credentialStore: store,
    credentialScope: scope,
    now: () => 100_000,
  });
  return { store, transport, client };
};

describe("credential scope, restoration and demand-driven expiry", () => {
  it("restores a projected credential and confirms the server identity", async () => {
    const test = await clientFixture({
      ...record,
      session: { ...session, raw: "must-not-persist" },
    });
    await test.client.restore();
    expect(test.transport.getCurrentAccount).toHaveBeenCalledTimes(1);
    expect(test.client.getSnapshot()).toMatchObject({
      status: "authenticated",
      account,
    });
    expect(await test.client.createSessionProvider().getSession()).toEqual(
      session,
    );
    expect(test.store.records.get(test.store.key(scope))).toEqual(record);
    expect(JSON.stringify(test.client.getSnapshot())).not.toMatch(
      /fixture-credential|must-not-persist/,
    );
  });

  it.each([
    { userId: "other" },
    { accountId: "other" },
    { organizationId: "other" },
    { organizationId: undefined },
  ])("rejects restored server identity mismatch %j", async (difference) => {
    const test = await clientFixture();
    test.transport.getCurrentAccount = async () =>
      ({ ...account, ...difference }) as AccountContext;
    await test.client.restore();
    expect(test.client.getSnapshot()).toMatchObject({
      status: "auth_required",
      error: { code: "invalid_response" },
    });
    expect(await test.transport.getSession()).toBeNull();
    expect(test.store.records.size).toBe(0);
  });

  it.each([
    { version: 2 },
    { environment: "production" },
    { userId: "other" },
    { accountId: "other" },
    { organizationId: "other" },
  ])(
    "discards incompatible persisted metadata %j before installing a session",
    async (difference) => {
      const test = await clientFixture({ ...record, ...difference });
      await test.client.restore();
      expect(test.client.getSnapshot().status).toBe("signed_out");
      expect(test.transport.restoreSession).not.toHaveBeenCalled();
      expect(test.transport.getCurrentAccount).not.toHaveBeenCalled();
      expect(test.store.records.size).toBe(0);
    },
  );

  it.each([
    null,
    [],
    { kind: "admin", token: "fixture" },
    { kind: "bearer" as const, token: " " },
    { ...session, expiresAt: -1 },
    { ...session, expiresAt: NaN },
  ])(
    "rejects malformed persisted session %j before server verification",
    async (invalid) => {
      const test = await clientFixture({ ...record, session: invalid });
      await test.client.restore();
      expect(test.client.getSnapshot().status).toBe("auth_required");
      expect(test.transport.restoreSession).not.toHaveBeenCalled();
      expect(test.transport.getCurrentAccount).not.toHaveBeenCalled();
      expect(test.store.records.size).toBe(0);
    },
  );

  it("does not use an injected Store without a trusted scope or any default browser storage", async () => {
    const store = new InjectedStore();
    const transport = transportFixture();
    const client = createAuthClient({
      environment: "staging",
      transport,
      credentialStore: store,
      now: () => 100_000,
    });
    await client.login(input);
    await client.logout();
    expect(store.read).not.toHaveBeenCalled();
    expect(store.write).not.toHaveBeenCalled();
    expect(store.clear).not.toHaveBeenCalled();
  });

  it("isolates Host store scopes including separator-containing identifiers", async () => {
    const store = new InjectedStore();
    const other = {
      environment: "production" as const,
      userId: "user:a",
      accountId: "b",
      organizationId: "org-a",
    };
    await store.write(scope, record);
    await store.write(other, { ...record, ...other });
    const test = await clientFixture();
    // A logout only clears the client-owned, startup-selected scope.
    const client = createAuthClient({
      environment: "staging",
      transport: test.transport,
      credentialStore: store,
      credentialScope: scope,
      now: () => 100_000,
    });
    await client.restore();
    await client.logout();
    expect(store.records.size).toBe(1);
    expect(await store.read(other)).toMatchObject({
      environment: "production",
      userId: "user:a",
    });
  });

  it("copies the startup scope rather than following caller mutations", async () => {
    const providedScope = { ...scope };
    const test = await clientFixture();
    const client = createAuthClient({
      environment: "staging",
      transport: test.transport,
      credentialStore: test.store,
      credentialScope: providedScope,
      now: () => 100_000,
    });
    providedScope.accountId = "changed";
    await client.restore();
    expect(client.getSnapshot().status).toBe("authenticated");
    expect(test.store.read).toHaveBeenCalledWith(scope);
  });

  it("keeps committed session private when a Host Store mutates its record", async () => {
    const test = await clientFixture();
    test.store.write.mockImplementation(async (_scope, stored) => {
      (stored.session as { token: string }).token = "host-mutated";
    });
    await test.client.login(input);
    expect((await test.client.createSessionProvider().getSession()).token).toBe(
      session.token,
    );
  });

  it.each(["verification", "persistence"])(
    "revokes a restored session that expires during %s",
    async (phase) => {
      const test = await clientFixture();
      let now = 100_000;
      if (phase === "verification")
        test.transport.getCurrentAccount = async () => {
          now = 140_000;
          return account;
        };
      else
        test.store.write.mockImplementation(async (scope, record) => {
          test.store.records.set(test.store.key(scope), record);
          now = 140_000;
        });
      const client = createAuthClient({
        environment: "staging",
        transport: test.transport,
        credentialStore: test.store,
        credentialScope: scope,
        now: () => now,
      });
      await client.restore();
      expect(client.getSnapshot().status).toBe("auth_required");
      expect(await test.transport.getSession()).toBeNull();
      expect(test.store.records.size).toBe(0);
    },
  );

  it("revokes a renewed session that expires while persistence is pending", async () => {
    const test = await clientFixture();
    let now = 100_000;
    const client = createAuthClient({
      environment: "staging",
      transport: test.transport,
      credentialStore: test.store,
      credentialScope: scope,
      now: () => now,
    });
    await client.login(input);
    test.transport.refresh = async () => ({
      kind: "bearer",
      token: "fixture-fresh",
      expiresAt: 500_000,
    });
    test.store.write.mockImplementation(async (scope, record) => {
      test.store.records.set(test.store.key(scope), record);
      now = 480_000;
    });
    await expect(client.refresh()).rejects.toMatchObject({
      authError: { code: "authentication_required" },
    });
    expect(client.getSnapshot().status).toBe("auth_required");
    expect(test.store.records.size).toBe(0);
  });

  it("safely rejects restored credentials when the transport cannot install them", async () => {
    const test = await clientFixture();
    delete test.transport.restoreSession;
    await test.client.restore();
    expect(test.client.getSnapshot()).toMatchObject({
      status: "auth_required",
      error: { code: "unsupported" },
    });
    expect(test.transport.getCurrentAccount).not.toHaveBeenCalled();
  });

  it.each([129_999, 130_000, 170_000])(
    "refreshes on demand at the configured expiry boundary (now %s)",
    async (now) => {
      const transport = transportFixture();
      const refresh = vi.fn(async () => ({
        kind: "bearer" as const,
        token: "fixture-fresh",
        expiresAt: 500_000,
      }));
      transport.refresh = refresh;
      const client = createAuthClient({
        environment: "staging",
        transport,
        now: () => now,
      });
      await client.login(input);
      expect(refresh).not.toHaveBeenCalled();
      const result = await client.createSessionProvider().getSession();
      expect(result.token).toBe(
        now < 130_000 ? session.token : "fixture-fresh",
      );
      expect(refresh).toHaveBeenCalledTimes(now < 130_000 ? 0 : 1);
    },
  );

  it("uses custom skew and leaves unknown TTL sessions untouched", async () => {
    const transport = transportFixture();
    transport.refresh = vi.fn(async () => session);
    const client = createAuthClient({
      environment: "staging",
      transport,
      now: () => 159_999,
      refreshSkewMs: 0,
    });
    await client.login(input);
    await client.createSessionProvider().getSession();
    expect(transport.refresh).not.toHaveBeenCalled();
    transport.getSession = async () => ({
      kind: "bearer" as const,
      token: "unknown-ttl",
    });
    const unknown = createAuthClient({
      environment: "staging",
      transport,
      now: () => 999_999,
    });
    await unknown.login(input);
    expect((await unknown.createSessionProvider().getSession()).token).toBe(
      "unknown-ttl",
    );
    expect(transport.refresh).not.toHaveBeenCalled();
  });

  it("coalesces expiry-triggered refresh across providers and subscriber reentry", async () => {
    const gate = deferred<AuthSession>();
    const transport = transportFixture();
    transport.refresh = vi.fn(() => gate.promise);
    const client = createAuthClient({
      environment: "staging",
      transport,
      now: () => 130_000,
    });
    await client.login(input);
    let reentrant: Promise<AuthSession> | undefined;
    client.subscribe((snapshot) => {
      if (snapshot.status === "refreshing") reentrant = client.refresh();
    });
    const first = client.createSessionProvider().getSession();
    const second = client.createSessionProvider().getSession();
    await Promise.resolve();
    expect(transport.refresh).toHaveBeenCalledTimes(1);
    gate.resolve({
      kind: "bearer" as const,
      token: "fixture-fresh",
      expiresAt: 500_000,
    });
    const results = await Promise.all([first, second, reentrant!]);
    expect(results.map(({ token }) => token)).toEqual([
      "fixture-fresh",
      "fixture-fresh",
      "fixture-fresh",
    ]);
  });

  it.each(["unsupported", "failure", "expired-result", "identity-change"])(
    "revokes expired sessions after %s without polling or login replay",
    async (failure) => {
      const test = await clientFixture();
      const client = createAuthClient({
        environment: "staging",
        transport: test.transport,
        credentialStore: test.store,
        credentialScope: scope,
        now: () => 170_000,
      });
      if (failure !== "unsupported")
        test.transport.refresh = vi.fn(async () => {
          if (failure === "failure") throw new Error("fixture-credential");
          return failure === "expired-result"
            ? session
            : {
                kind: "bearer" as const,
                token: "fixture-fresh",
                expiresAt: 500_000,
              };
        });
      if (failure === "identity-change")
        test.transport.getCurrentAccount = async () => ({
          ...account,
          userId: "other",
        });
      await client.restore();
      expect(client.getSnapshot().status).toBe("auth_required");
      expect(await test.transport.getSession()).toBeNull();
      expect(test.store.records.size).toBe(0);
      expect(test.transport.login).not.toHaveBeenCalled();
      expect(JSON.stringify(client.getSnapshot())).not.toContain(
        "fixture-credential",
      );
    },
  );

  it("refreshes an expired stored token before verifying and persisting its identity", async () => {
    const test = await clientFixture({
      ...record,
      session: { ...session, expiresAt: 100_000 },
    });
    test.transport.refresh = vi.fn(async () => ({
      kind: "bearer" as const,
      token: "fixture-fresh",
      expiresAt: 500_000,
    }));
    await test.client.restore();
    expect(test.transport.refresh).toHaveBeenCalledTimes(1);
    expect(test.transport.getCurrentAccount).toHaveBeenCalledTimes(1);
    expect(test.client.getSnapshot().status).toBe("authenticated");
    expect((await test.store.read(scope))?.session.token).toBe("fixture-fresh");
  });

  it.each(["read", "write", "clear"] as const)(
    "keeps authority revoked after Host Store %s failure",
    async (failure) => {
      const test = await clientFixture();
      test.store[failure].mockImplementation(async () => {
        throw new Error("fixture-credential");
      });
      if (failure === "write")
        await expect(test.client.login(input)).rejects.toThrow(
          "Authentication operation failed",
        );
      else if (failure === "clear") {
        await test.client.restore();
        await expect(test.client.logout()).rejects.toThrow(
          "Authentication operation failed",
        );
      } else await test.client.restore();
      expect(["auth_required", "error"]).toContain(
        test.client.getSnapshot().status,
      );
      expect(await test.transport.getSession()).toBeNull();
      await expect(
        test.client.createSessionProvider().getSession(),
      ).rejects.toThrow();
      expect(JSON.stringify(test.client.getSnapshot())).not.toContain(
        "fixture-credential",
      );
    },
  );

  it.each(["before-request", "during-refresh"])(
    "honors cancellation %s without returning credentials",
    async (when) => {
      const transport = transportFixture();
      const gate = deferred<AuthSession>();
      transport.refresh = () => gate.promise;
      const client = createAuthClient({
        environment: "staging",
        transport,
        now: () => 130_000,
      });
      await client.login(input);
      const signal = { aborted: when === "before-request" };
      const pending = client.createSessionProvider().getSession({ signal });
      const rejected = expect(pending).rejects.toMatchObject({
        authError: { code: "cancelled" },
      });
      if (when === "during-refresh") {
        await Promise.resolve();
        signal.aborted = true;
        gate.resolve({
          kind: "bearer" as const,
          token: "fixture-fresh",
          expiresAt: 500_000,
        });
      }
      await rejected;
      expect(client.getSnapshot().status).toBe("authenticated");
    },
  );

  it.each([-1, NaN, Infinity])(
    "rejects invalid refresh skew %s",
    (refreshSkewMs) => {
      expect(() =>
        createAuthClient({
          environment: "staging",
          transport: transportFixture(),
          refreshSkewMs,
        }),
      ).toThrow("Refresh skew");
    },
  );
});
