import { createServer, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";

import {
  createAuthClient,
  type AccountContext,
  type AuthSession,
  type AuthTransport,
  type CredentialRecord,
  type CredentialStore,
} from "../packages/chat-auth/src/headless.js";
import { createTfRobotAuthTransport } from "../packages/chat-auth/src/tfrobot.js";

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const account = (accountId = "account-1"): AccountContext => ({
  userId: "user-1",
  accountId,
});
const credential: AuthSession = {
  kind: "bearer",
  token: "fixture-only-credential",
};
const loginInput = {
  identifier: "fixture@example.test",
  password: "fixture-only",
};
const body = (accountId = "account-1") => ({
  token: `fixture-${accountId}`,
  account: account(accountId),
});

describe("AuthClient lifecycle across real local HTTP", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  const fixture = async () => {
    const verificationAccounts = new Map<string, AccountContext>();
    const pending: Array<{
      path: string;
      body: string;
      response: ServerResponse;
    }> = [];
    const arrivals: Array<ReturnType<typeof deferred<void>>> = [];
    const server = createServer((request, response) => {
      response.setHeader("content-type", "application/json");
      let body = "";
      request.on("data", (chunk: Buffer) => {
        body += chunk.toString();
      });
      request.on("end", () => {
        const verified = verificationAccounts.get(
          request.headers.authorization ?? "",
        );
        if (request.url === "/api/v1/auth/me" && verified !== undefined) {
          response.end(JSON.stringify(verified));
          return;
        }
        pending.push({ path: request.url ?? "", body, response });
        arrivals[pending.length - 1]?.resolve();
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    cleanups.push(async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    });
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new Error("Missing fixture port");
    const transport = createTfRobotAuthTransport({
      baseUrl: `http://127.0.0.1:${address.port}`,
    });
    const client = createAuthClient({ environment: "staging", transport });
    return {
      client,
      transport,
      async arrival(index: number) {
        if (pending[index] !== undefined) return;
        const gate = deferred<void>();
        arrivals[index] = gate;
        await gate.promise;
      },
      reply(index: number, payload: unknown) {
        const item = pending[index];
        if (item === undefined) throw new Error("Request has not arrived");
        if (
          item.path.endsWith("select-account") ||
          item.path.endsWith("switch-account")
        ) {
          const selected = payload as ReturnType<typeof body>;
          verificationAccounts.set(
            `Bearer ${selected.token}`,
            selected.account,
          );
        }
        item.response.end(JSON.stringify(payload));
      },
      path(index: number) {
        return pending[index]?.path;
      },
      requestBody(index: number) {
        return JSON.parse(pending[index]?.body ?? "{}");
      },
    };
  };

  for (const operation of ["login", "select", "switch"] as const) {
    it.each(["logout", "dispose", "invalidate"] as const)(
      `fences a delayed ${operation} after %s`,
      async (termination) => {
        const test = await fixture();
        const pending =
          operation === "login"
            ? test.client.login(loginInput)
            : operation === "select"
              ? test.client.selectAccount("account-1")
              : test.client.switchAccount("account-1");
        await test.arrival(0);
        if (termination === "logout") await test.client.logout();
        else if (termination === "dispose") await test.client.dispose();
        else test.client.createSessionProvider().invalidate?.();
        const snapshots: string[] = [];
        test.client.subscribe((snapshot) => snapshots.push(snapshot.status));
        test.reply(0, body());
        await pending;
        expect(test.path(0)).toBe(
          operation === "login"
            ? "/auth/login-by-password"
            : operation === "select"
              ? "/auth/select-account"
              : "/api/v1/auth/switch-account",
        );
        expect(test.client.getSnapshot().status).toBe(
          termination === "logout"
            ? "signed_out"
            : termination === "dispose"
              ? "disposed"
              : "auth_required",
        );
        expect(await test.transport.getSession()).toBeNull();
        await expect(
          test.client.createSessionProvider().getSession(),
        ).rejects.toThrow();
        expect(
          snapshots.filter((status) => status === "authenticated"),
        ).toEqual([]);
      },
    );
  }

  it("retains the newer HTTP login when responses arrive in reverse order", async () => {
    const test = await fixture();
    const first = test.client.login(loginInput);
    await test.arrival(0);
    const second = test.client.login(loginInput);
    await test.arrival(1);
    test.reply(1, body("new"));
    await second;
    test.reply(0, body("old"));
    await first;
    expect(test.client.getSnapshot().account?.accountId).toBe("new");
    expect(await test.transport.getSession()).toEqual({
      kind: "bearer",
      token: "fixture-new",
    });
    expect(await test.client.createSessionProvider().getSession()).toEqual({
      kind: "bearer",
      token: "fixture-new",
    });
  });

  it("restores the current identity without accepting a superseded switch credential", async () => {
    const test = await fixture();
    const login = test.client.login(loginInput);
    await test.arrival(0);
    test.reply(0, body());
    await login;
    const switching = test.client.switchAccount("account-2");
    await test.arrival(1);
    const restoring = test.client.restore();
    await test.arrival(2);
    test.reply(1, body("account-2"));
    await switching;
    test.reply(2, account());
    await restoring;
    expect(test.path(2)).toBe("/api/v1/auth/me");
    expect(test.client.getSnapshot().account).toEqual(account());
    expect(await test.client.createSessionProvider().getSession()).toEqual({
      kind: "bearer",
      token: "fixture-account-1",
    });
    expect(await test.transport.getSession()).toEqual({
      kind: "bearer",
      token: "fixture-account-1",
    });
  });

  it("does not revive a pending login superseded by restore", async () => {
    const test = await fixture();
    const login = test.client.login(loginInput);
    await test.arrival(0);
    const restoring = test.client.restore();
    await test.arrival(1);
    test.reply(0, body());
    await login;
    // Even a syntactically valid /me response cannot authenticate without a
    // session owned by this restore generation.
    test.reply(1, account());
    await restoring;
    expect(test.client.getSnapshot().status).toBe("auth_required");
    expect(await test.transport.getSession()).toBeNull();
    await expect(
      test.client.createSessionProvider().getSession(),
    ).rejects.toThrow();
  });

  it("does not expose a session while an account switch is pending", async () => {
    const test = await fixture();
    const login = test.client.login(loginInput);
    await test.arrival(0);
    test.reply(0, body());
    await login;
    const switching = test.client.switchAccount("account-2");
    await test.arrival(1);
    await expect(
      test.client.createSessionProvider().getSession(),
    ).rejects.toMatchObject({ authError: { code: "authentication_required" } });
    test.reply(1, body("account-2"));
    await switching;
    expect(await test.client.createSessionProvider().getSession()).toEqual({
      kind: "bearer",
      token: "fixture-account-2",
    });
  });

  it("clears the temporary account-selection credential on logout", async () => {
    const test = await fixture();
    const login = test.client.login(loginInput);
    await test.arrival(0);
    test.reply(0, {
      tempToken: "fixture-temp",
      accounts: [account("a"), account("b")],
    });
    await login;
    await test.client.logout();
    // A direct transport caller must not retain the old multi-account token.
    const selecting = test.transport.selectAccount("a");
    await test.arrival(1);
    expect(test.requestBody(1)).toEqual({ accountId: "a" });
    test.reply(1, body("a"));
    await selecting;
    await expect(
      test.client.createSessionProvider().getSession(),
    ).rejects.toThrow();
  });
});

describe("AuthClient injected transport and storage interleavings", () => {
  const memoryTransport = (): AuthTransport => {
    let session: AuthSession | null = credential;
    return {
      login: async () => {
        session = credential;
        return { kind: "authenticated", account: account() };
      },
      selectAccount: async (id) => ({
        kind: "authenticated",
        account: account(id),
      }),
      switchAccount: async (id) => account(id),
      getCurrentAccount: async () => account(),
      listAccounts: async () => [account()],
      getSession: async () => session,
      restoreSession: (next) => {
        session = next;
      },
      clearSession: () => {
        session = null;
      },
      logout: async () => {
        session = null;
      },
    };
  };

  it.each(["login", "select", "switch"] as const)(
    "does not start %s after a subscriber disposes the client",
    async (operation) => {
      const calls: string[] = [];
      const transport = memoryTransport();
      transport.login = async () => {
        calls.push("login");
        return { kind: "authenticated", account: account() };
      };
      transport.selectAccount = async () => {
        calls.push("select");
        return { kind: "authenticated", account: account() };
      };
      transport.switchAccount = async () => {
        calls.push("switch");
        return account();
      };
      const client = createAuthClient({ environment: "staging", transport });
      client.subscribe((snapshot) => {
        if (
          snapshot.status === "authenticating" ||
          snapshot.status === "switching"
        )
          void client.dispose();
      });
      const pending =
        operation === "login"
          ? client.login(loginInput)
          : operation === "select"
            ? client.selectAccount("account-1")
            : client.switchAccount("account-1");
      await expect(pending).rejects.toMatchObject({
        authError: { code: "cancelled" },
      });
      expect(calls).toEqual([]);
      expect(client.getSnapshot().status).toBe("disposed");
      expect(await transport.getSession()).toBeNull();
    },
  );

  it("does not start an older login after a subscriber starts a newer one", async () => {
    const calls: string[] = [];
    const transport = memoryTransport();
    transport.login = async (input) => {
      calls.push(input.identifier);
      transport.restoreSession?.(credential);
      return { kind: "authenticated", account: account(input.identifier) };
    };
    const client = createAuthClient({ environment: "staging", transport });
    let nested: Promise<unknown> | undefined;
    client.subscribe((snapshot) => {
      if (
        snapshot.status === "authenticating" &&
        calls.length === 0 &&
        nested === undefined
      ) {
        // Set the guard before synchronous nested notifications.
        nested = Promise.resolve();
        nested = client.login({ ...loginInput, identifier: "new" });
      }
    });
    await expect(
      client.login({ ...loginInput, identifier: "old" }),
    ).rejects.toMatchObject({ authError: { code: "cancelled" } });
    await nested;
    expect(calls).toEqual(["new"]);
    expect(client.getSnapshot().account?.accountId).toBe("new");
  });

  it("does not call refresh without a committed authenticated session", async () => {
    let calls = 0;
    const transport = memoryTransport();
    transport.refresh = async () => {
      calls++;
      return credential;
    };
    const client = createAuthClient({ environment: "staging", transport });
    await expect(client.refresh()).rejects.toMatchObject({
      authError: { code: "authentication_required" },
    });
    expect(calls).toBe(0);
    expect(client.getSnapshot().status).toBe("signed_out");
  });

  it("revokes local authority even when a host logout throws synchronously", async () => {
    const transport = memoryTransport();
    const client = createAuthClient({ environment: "staging", transport });
    await client.login(loginInput);
    transport.logout = () => {
      throw new Error("fixture logout failure");
    };
    await expect(client.logout()).rejects.toMatchObject({
      authError: {
        code: "unknown",
        message: "Authentication operation failed",
      },
    });
    expect(client.getSnapshot().status).toBe("error");
    expect(await transport.getSession()).toBeNull();
    await expect(client.createSessionProvider().getSession()).rejects.toThrow();
  });

  it("does not call an operation if logout follows getSession before its continuation", async () => {
    const client = createAuthClient({
      environment: "staging",
      transport: memoryTransport(),
    });
    await client.login(loginInput);
    let calls = 0;
    const pending = client.createSessionProvider().withAuthRetry(async () => {
      calls++;
      return "ok";
    });
    const rejected = expect(pending).rejects.toMatchObject({
      authError: { code: "cancelled" },
    });
    await client.logout();
    await rejected;
    expect(calls).toBe(0);
  });

  it("does not retry with credentials revoked by a refresh subscriber", async () => {
    const transport = memoryTransport();
    transport.refresh = async () => ({
      kind: "bearer",
      token: "fixture-refreshed",
    });
    const client = createAuthClient({ environment: "staging", transport });
    await client.login(loginInput);
    let refreshing = false;
    client.subscribe((snapshot) => {
      if (snapshot.status === "refreshing") refreshing = true;
      if (refreshing && snapshot.status === "authenticated")
        void client.logout();
    });
    let calls = 0;
    await expect(
      client.createSessionProvider().withAuthRetry(async () => {
        calls++;
        throw Object.assign(new Error("fixture unauthorized"), { status: 401 });
      }),
    ).rejects.toMatchObject({ authError: { code: "cancelled" } });
    expect(calls).toBe(1);
    expect(await transport.getSession()).toBeNull();
  });

  it("does not return an old operation result after account identity changes", async () => {
    const client = createAuthClient({
      environment: "staging",
      transport: memoryTransport(),
    });
    await client.login(loginInput);
    const started = deferred<void>();
    const gate = deferred<string>();
    const pending = client.createSessionProvider().withAuthRetry(async () => {
      started.resolve();
      return gate.promise;
    });
    const rejected = expect(pending).rejects.toMatchObject({
      authError: { code: "cancelled" },
    });
    await started.promise;
    await client.switchAccount("new");
    gate.resolve("old-context-result");
    await rejected;
    expect(client.getSnapshot().account?.accountId).toBe("new");
  });

  it("orders a pending store write before the logout clear", async () => {
    const writeStarted = deferred<void>();
    const finishWrite = deferred<void>();
    let record: CredentialRecord | null = null;
    const store: CredentialStore = {
      read: async () => record,
      write: async (_scope, next) => {
        writeStarted.resolve();
        await finishWrite.promise;
        record = next;
      },
      clear: async () => {
        record = null;
      },
    };
    const client = createAuthClient({
      environment: "staging",
      transport: memoryTransport(),
      credentialStore: store,
      credentialScope: { environment: "staging", ...account() },
    });
    const login = client.login(loginInput);
    await writeStarted.promise;
    const logout = client.logout();
    expect(client.getSnapshot().status).toBe("signed_out");
    await expect(client.createSessionProvider().getSession()).rejects.toThrow();
    finishWrite.resolve();
    await Promise.all([login, logout]);
    expect(record).toBeNull();
    expect(client.getSnapshot().status).not.toBe("authenticated");
  });

  it.each([
    "logout",
    "invalidate",
    "refresh-failure",
    "retry-failure",
    "login-failure",
  ] as const)(
    "does not let a %s subscriber restore revoked persisted credentials",
    async (termination) => {
      let record: CredentialRecord | null = null;
      const store: CredentialStore = {
        read: async () => record,
        write: async (_scope, next) => {
          record = next;
        },
        clear: async () => {
          record = null;
        },
      };
      const transport = memoryTransport();
      transport.refresh = async () => {
        if (termination === "refresh-failure")
          throw new Error("fixture-refresh-failure");
        return credential;
      };
      const client = createAuthClient({
        environment: "staging",
        transport,
        credentialStore: store,
        credentialScope: { environment: "staging", ...account() },
      });
      await client.login(loginInput);
      expect(record).not.toBeNull();
      let restore: Promise<void> | undefined;
      client.subscribe((snapshot) => {
        if (
          restore === undefined &&
          ["signed_out", "auth_required", "error"].includes(snapshot.status)
        ) {
          restore = Promise.resolve();
          restore = client.restore();
        }
      });
      if (termination === "logout") await client.logout();
      else if (termination === "invalidate")
        client.createSessionProvider().invalidate?.();
      else if (termination === "refresh-failure")
        await expect(client.refresh()).rejects.toThrow();
      else if (termination === "retry-failure")
        await expect(
          client.createSessionProvider().withAuthRetry(async () => {
            throw Object.assign(new Error("fixture unauthorized"), {
              status: 401,
            });
          }),
        ).rejects.toThrow();
      else {
        transport.login = async () => {
          throw new Error("fixture login failure");
        };
        await expect(client.login(loginInput)).rejects.toThrow();
      }
      await restore;
      expect(record).toBeNull();
      expect(client.getSnapshot().status).toBe("signed_out");
      expect(await transport.getSession()).toBeNull();
    },
  );

  it("rejects a delayed refresh result after invalidation", async () => {
    const started = deferred<void>();
    const gate = deferred<AuthSession>();
    const transport = memoryTransport();
    transport.refresh = async () => {
      started.resolve();
      return gate.promise;
    };
    const client = createAuthClient({ environment: "staging", transport });
    await client.login(loginInput);
    const refreshing = client.refresh();
    const rejected = expect(refreshing).rejects.toMatchObject({
      authError: { code: "cancelled" },
    });
    await started.promise;
    client.createSessionProvider().invalidate?.();
    gate.resolve({ kind: "bearer", token: "fixture-late-refresh" });
    await rejected;
    expect(client.getSnapshot().status).toBe("auth_required");
    await expect(client.createSessionProvider().getSession()).rejects.toThrow();
  });

  it("does not let an old account-list response change the new account context", async () => {
    const gate = deferred<readonly AccountContext[]>();
    const transport = memoryTransport();
    transport.listAccounts = () => gate.promise;
    const client = createAuthClient({ environment: "staging", transport });
    await client.login(loginInput);
    const listing = client.listAccounts();
    await client.switchAccount("new");
    gate.resolve([account("old")]);
    await listing;
    expect(client.getSnapshot().accounts).toEqual([account("new")]);
  });
});
