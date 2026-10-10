import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  createAuthClient,
  type AuthSession,
  type CredentialRecord,
  type CredentialScope,
  type CredentialStore,
} from "../packages/chat-auth/src/headless.js";
import { createTfRobotAuthTransport } from "../packages/chat-auth/src/tfrobot.js";

const identity = {
  userId: "9",
  accountId: "account-a",
  organizationId: "org-a",
};
const scope: CredentialScope = { environment: "staging", ...identity };
const storedSession: AuthSession = {
  kind: "bearer",
  token: "fixture-stored",
  expiresAt: 160_000,
};
const freshSession: AuthSession = {
  kind: "bearer",
  token: "fixture-renewed",
  expiresAt: 500_000,
};
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

describe("credential restore and bounded refresh over real local HTTP", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
  });
  const fixture = async (
    options: {
      readonly identityDifference?: Partial<typeof identity>;
      readonly expired?: boolean;
      readonly refresh?: "success" | "failure" | "delayed";
      readonly rejectRetry?: boolean;
    } = {},
  ) => {
    const requests: Array<{ path: string; authorization: string | undefined }> =
      [];
    const renewalArrived = deferred();
    const releaseRenewal = deferred();
    let serialized: string | null = JSON.stringify({
      version: 1,
      ...scope,
      session: options.expired
        ? { ...storedSession, expiresAt: 99_000 }
        : storedSession,
    });
    const store: CredentialStore = {
      read: async () =>
        serialized === null
          ? null
          : (JSON.parse(serialized) as CredentialRecord),
      write: async (_scope, record) => {
        serialized = JSON.stringify(record);
      },
      clear: async () => {
        serialized = null;
      },
    };
    let attempts = 0;
    const server = createServer((request, response) => {
      const path = request.url ?? "";
      requests.push({ path, authorization: request.headers.authorization });
      response.setHeader("content-type", "application/json");
      const reply = (data: unknown, status = 200) => {
        response.statusCode = status;
        response.end(
          JSON.stringify({ code: status, message: "fixture response", data }),
        );
      };
      if (path === "/api/v1/auth/me")
        reply({ ...identity, ...options.identityDifference });
      else if (path === "/auth/login-by-password")
        reply({ ...identity, token: "fixture-login", expiresAt: 180_000 });
      else if (path === "/fixture/renew") {
        renewalArrived.resolve();
        if (options.refresh === "delayed")
          void releaseRenewal.promise.then(() => reply(freshSession));
        else if (options.refresh === "failure")
          reply({ detail: "fixture-stored" }, 500);
        else reply(freshSession);
      } else if (path === "/fixture/operation")
        reply(
          { ok: true },
          ++attempts === 1 || options.rejectRetry ? 401 : 200,
        );
      else reply(null, 404);
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
      throw new Error("Missing TCP port");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const transport = createTfRobotAuthTransport({ baseUrl });
    // This fixture-only Host strategy is not a claimed Manager refresh endpoint.
    if (options.refresh !== undefined)
      transport.refresh = async () => {
        const current = await transport.getSession();
        const response = await fetch(`${baseUrl}/fixture/renew`, {
          headers: { Authorization: `Bearer ${current?.token}` },
        });
        if (!response.ok) throw new Error("fixture-stored");
        return ((await response.json()) as { data: AuthSession }).data;
      };
    const client = createAuthClient({
      environment: "staging",
      transport,
      credentialStore: store,
      credentialScope: scope,
      now: () => 100_000,
    });
    return {
      client,
      transport,
      store,
      requests,
      renewalArrived,
      releaseRenewal,
      baseUrl,
    };
  };

  it("installs a stored credential and verifies actual /me Authorization before authentication", async () => {
    const test = await fixture();
    await test.client.restore();
    expect(test.requests).toEqual([
      { path: "/api/v1/auth/me", authorization: "Bearer fixture-stored" },
    ]);
    expect(test.client.getSnapshot()).toMatchObject({
      status: "authenticated",
      account: identity,
    });
    expect(await test.client.createSessionProvider().getSession()).toEqual(
      storedSession,
    );
    expect(JSON.stringify(test.client.getSnapshot())).not.toContain(
      "fixture-stored",
    );
  });

  it.each([
    { userId: "other" },
    { accountId: "other" },
    { organizationId: "other" },
  ])(
    "clears credentials after real server identity mismatch %j",
    async (identityDifference) => {
      const test = await fixture({ identityDifference });
      await test.client.restore();
      expect(test.requests).toHaveLength(1);
      expect(test.client.getSnapshot()).toMatchObject({
        status: "auth_required",
        error: { code: "invalid_response" },
      });
      expect(await test.store.read(scope)).toBeNull();
      expect(await test.transport.getSession()).toBeNull();
    },
  );

  it("renews an expired stored session once and verifies the candidate bearer", async () => {
    const test = await fixture({ expired: true, refresh: "success" });
    await test.client.restore();
    expect(test.requests).toEqual([
      { path: "/fixture/renew", authorization: "Bearer fixture-stored" },
      { path: "/api/v1/auth/me", authorization: "Bearer fixture-renewed" },
    ]);
    expect(await test.client.createSessionProvider().getSession()).toEqual(
      freshSession,
    );
    expect((await test.store.read(scope))?.session).toEqual(freshSession);
  });

  it("does not call an invented refresh or replay login when renewal is unavailable", async () => {
    const test = await fixture({ expired: true });
    await test.client.restore();
    expect(test.requests).toEqual([]);
    expect(test.client.getSnapshot().status).toBe("auth_required");
    expect(await test.store.read(scope)).toBeNull();
  });

  it.each(["success", "failure", "reject-retry"] as const)(
    "bounds 401 retry across real requests (%s)",
    async (outcome) => {
      const test = await fixture({
        refresh: outcome === "failure" ? "failure" : "success",
        rejectRetry: outcome === "reject-retry",
      });
      await test.client.login({
        identifier: "fixture",
        password: "fixture-transient",
      });
      const operation = test.client
        .createSessionProvider()
        .withAuthRetry(async (session) => {
          const response = await fetch(`${test.baseUrl}/fixture/operation`, {
            headers: { Authorization: `Bearer ${session.token}` },
          });
          if (response.status === 401)
            throw Object.assign(new Error(`Bearer ${session.token}`), {
              status: 401,
            });
          return response.status;
        });
      if (outcome === "success") await expect(operation).resolves.toBe(200);
      else {
        await expect(operation).rejects.not.toThrow(
          /fixture-login|fixture-renewed|fixture-stored/,
        );
        expect(test.client.getSnapshot().status).toBe("auth_required");
        expect(await test.store.read(scope)).toBeNull();
      }
      expect(
        test.requests.filter(({ path }) => path === "/fixture/renew"),
      ).toHaveLength(1);
      expect(
        test.requests
          .filter(({ path }) => path === "/fixture/operation")
          .map(({ authorization }) => authorization),
      ).toEqual(
        outcome === "failure"
          ? ["Bearer fixture-login"]
          : ["Bearer fixture-login", "Bearer fixture-renewed"],
      );
      expect(
        test.requests.filter(({ path }) => path === "/auth/login-by-password"),
      ).toHaveLength(1);
    },
  );

  it.each(["logout", "dispose"] as const)(
    "fences late real renewal after %s",
    async (termination) => {
      const test = await fixture({ expired: true, refresh: "delayed" });
      const restoring = test.client.restore();
      await test.renewalArrived.promise;
      if (termination === "logout") await test.client.logout();
      else await test.client.dispose();
      test.releaseRenewal.resolve();
      await restoring;
      expect(
        test.requests.filter(({ path }) => path === "/api/v1/auth/me"),
      ).toHaveLength(0);
      expect(await test.transport.getSession()).toBeNull();
      expect(await test.store.read(scope)).toBeNull();
      expect(test.client.getSnapshot().status).toBe(
        termination === "logout" ? "signed_out" : "disposed",
      );
    },
  );
});
