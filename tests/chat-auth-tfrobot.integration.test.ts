import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionProvider as GatewaySessionProvider } from "../packages/chat-protocol/src/gateway.js";
import {
  createAuthClient,
  type AuthSession,
} from "../packages/chat-auth/src/headless.js";
import { createTfRobotAuthTransport } from "../packages/chat-auth/src/tfrobot.js";
import { createTFRobotChatGateway } from "../packages/chat-gateway-tfrobot/src/index.js";

const envelope = (data: unknown) => ({ code: 200, message: "success", data });
const identity = (accountId = "account-a") => ({
  userId: 9,
  accountId,
  organizationId: `org-${accountId}`,
});
const loginInput = {
  identifier: "fixture@example.test",
  password: "fixture-password",
};
const credential = (accountId = "account-a") => ({
  ...identity(accountId),
  token: `fixture-${accountId}`,
  password: "must-not-project",
  raw: { token: "must-not-project" },
});
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

describe("TFRobot authentication real HTTP contracts", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
  });
  const fixture = async (
    handler: (
      request: IncomingMessage,
      response: ServerResponse,
      body: unknown,
    ) => void | Promise<void>,
  ) => {
    const requests: Array<{
      path: string;
      body: unknown;
      authorization: string | undefined;
    }> = [];
    const server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk: Buffer) => {
        body += chunk.toString();
      });
      request.on("end", () => {
        const parsed: unknown = body === "" ? undefined : JSON.parse(body);
        requests.push({
          path: request.url ?? "",
          body: parsed,
          authorization: request.headers.authorization,
        });
        response.setHeader("content-type", "application/json");
        void Promise.resolve(handler(request, response, parsed)).catch(() => {
          response.destroy();
        });
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
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const transport = createTfRobotAuthTransport({ baseUrl });
    return {
      transport,
      baseUrl,
      requests,
      client: createAuthClient({ environment: "staging", transport }),
    };
  };
  const reply = (response: ServerResponse, data: unknown) =>
    response.end(JSON.stringify(envelope(data)));

  it.each(["13800138008", "fixture@example.test"])(
    "maps single-account login %s without credential projection",
    async (identifier) => {
      const test = await fixture((_request, response) => {
        reply(response, credential());
      });
      expect(await test.client.login({ ...loginInput, identifier })).toEqual({
        kind: "authenticated",
        account: {
          userId: "9",
          accountId: "account-a",
          organizationId: "org-account-a",
        },
      });
      expect(test.requests).toEqual([
        {
          path: "/auth/login-by-password",
          authorization: undefined,
          body: {
            [identifier.includes("@") ? "email" : "phone"]: identifier,
            password: "fixture-password",
          },
        },
      ]);
      expect(JSON.stringify(test.client.getSnapshot())).not.toMatch(
        /fixture-account|fixture-password|must-not-project|token/i,
      );
      const provider: GatewaySessionProvider<AuthSession> =
        test.client.createSessionProvider();
      expect(
        await provider.getSession({ purpose: "request", operation: "read" }),
      ).toEqual({ kind: "bearer", token: "fixture-account-a" });
    },
  );

  it("maps account options without user IDs, selects and switches using verified candidate bearer", async () => {
    const options = ["account-a", "account-b"].map((accountId) => ({
      accountId,
      organizationId: `org-${accountId}`,
      accountName: accountId,
      token: "must-not-project",
    }));
    const test = await fixture((request, response, body) => {
      if (request.url === "/auth/login-by-password")
        reply(response, {
          tempToken: "fixture-temp",
          expiresIn: 300,
          accounts: options,
        });
      else if (request.url === "/api/v1/accounts/my")
        reply(response, { accounts: options });
      else if (request.url === "/api/v1/auth/me")
        reply(
          response,
          identity(
            request.headers.authorization?.endsWith("account-b")
              ? "account-b"
              : "account-a",
          ),
        );
      else
        reply(response, credential((body as { accountId: string }).accountId));
    });
    expect(await test.client.login(loginInput)).toEqual({
      kind: "account-selection-required",
      accounts: options.map(({ accountId, organizationId, accountName }) => ({
        accountId,
        organizationId,
        displayName: accountName,
      })),
    });
    expect(await test.transport.getSession()).toBeNull();
    expect(await test.client.selectAccount("account-a")).toMatchObject({
      kind: "authenticated",
      account: { userId: "9", accountId: "account-a" },
    });
    await test.client.listAccounts();
    await test.client.switchAccount("account-b");
    expect(await test.transport.getCurrentAccount()).toEqual({
      userId: "9",
      accountId: "account-b",
      organizationId: "org-account-b",
    });
    expect(test.requests.map(({ path }) => path)).toEqual([
      "/auth/login-by-password",
      "/auth/select-account",
      "/api/v1/auth/me",
      "/api/v1/accounts/my",
      "/api/v1/auth/switch-account",
      "/api/v1/auth/me",
      "/api/v1/auth/me",
    ]);
    expect(test.requests[1]).toMatchObject({
      body: { tempToken: "fixture-temp", accountId: "account-a" },
      authorization: undefined,
    });
    expect(test.requests[2]?.authorization).toBe("Bearer fixture-account-a");
    expect(test.requests[4]).toMatchObject({
      body: { accountId: "account-b" },
      authorization: "Bearer fixture-account-a",
    });
    expect(test.requests[5]?.authorization).toBe("Bearer fixture-account-b");
    expect(test.client.getSnapshot().account?.accountId).toBe("account-b");
    expect(JSON.stringify(test.client.getSnapshot())).not.toMatch(
      /fixture-temp|fixture-account|must-not-project/,
    );
  });

  it("keeps onboarding user separate from account and usable chat credentials", async () => {
    const test = await fixture((_request, response) => {
      reply(response, {
        needsOnboarding: true,
        userId: 9,
        token: "fixture-onboarding",
      });
    });
    expect(await test.client.login(loginInput)).toEqual({
      kind: "onboarding-required",
      user: { userId: "9" },
    });
    expect(test.client.getSnapshot()).toMatchObject({
      status: "onboarding_required",
      user: { userId: "9" },
      accounts: [],
    });
    expect(test.client.getSnapshot().account).toBeUndefined();
    expect(await test.transport.getSession()).toBeNull();
    await expect(
      test.client.createSessionProvider().getSession(),
    ).rejects.toMatchObject({ authError: { code: "authentication_required" } });
    await test.client.logout();
    expect(test.client.getSnapshot().user).toBeUndefined();
  });

  it.each([
    [401, "authentication_required"],
    [403, "authorization_denied"],
    [404, "unsupported"],
    [500, "unknown"],
  ] as const)("maps HTTP and envelope %s safely", async (status, code) => {
    for (const businessEnvelope of [false, true]) {
      const test = await fixture((_request, response) => {
        response.statusCode = businessEnvelope ? 200 : status;
        response.end(
          JSON.stringify({
            code: status,
            message: "fixture-password fixture-token",
            detail: "fixture-token",
          }),
        );
      });
      await expect(test.client.login(loginInput)).rejects.toMatchObject({
        authError: { code, status },
      });
      expect(test.client.getSnapshot().error).toMatchObject({ code, status });
      expect(JSON.stringify(test.client.getSnapshot())).not.toMatch(
        /fixture-password|fixture-token/,
      );
      expect(await test.transport.getSession()).toBeNull();
    }
  });

  it.each([
    null,
    [],
    {},
    { id: 9, token: "fixture-token" },
    { userId: -1, accountId: "a", token: "fixture-token" },
    { userId: 1.5, accountId: "a", token: "fixture-token" },
    { userId: 9, accountId: "a" },
    { userId: 9, uid: 10, accountId: "a", token: "fixture-token" },
    { needsOnboarding: "true", token: "fixture-token", userId: 9 },
    { tempToken: "fixture-temp", accounts: [{}] },
    {
      tempToken: "fixture-temp",
      accounts: [{ accountId: "a" }, { accountId: "a" }],
    },
  ])("rejects invalid DTO %j before credential commit", async (data) => {
    const test = await fixture((_request, response) => {
      reply(response, data);
    });
    await expect(test.client.login(loginInput)).rejects.toMatchObject({
      authError: { code: "invalid_response" },
    });
    expect(await test.transport.getSession()).toBeNull();
    expect(test.client.getSnapshot().account).toBeUndefined();
  });

  it.each([
    { accountId: "other" },
    { userId: 10 },
    { organizationId: "other" },
  ])(
    "rejects switch identity mismatch %j without committing candidate",
    async (difference) => {
      const test = await fixture((request, response) => {
        if (request.url === "/auth/login-by-password")
          reply(response, credential());
        else if (request.url === "/api/v1/auth/me")
          reply(response, { ...identity("account-b"), ...difference });
        else reply(response, credential("account-b"));
      });
      await test.client.login(loginInput);
      await expect(
        test.client.switchAccount("account-b"),
      ).rejects.toMatchObject({ authError: { code: "invalid_response" } });
      expect(await test.transport.getSession()).toBeNull();
      expect(test.client.getSnapshot()).toMatchObject({
        status: "error",
        error: { code: "invalid_response" },
      });
      expect(test.requests.at(-1)?.authorization).toBe(
        "Bearer fixture-account-b",
      );
    },
  );

  it("fences credentials when logout happens during candidate /me verification", async () => {
    const arrived = deferred();
    const release = deferred();
    const test = await fixture(async (request, response) => {
      if (request.url === "/auth/login-by-password")
        reply(response, credential());
      else if (request.url === "/api/v1/auth/me") {
        arrived.resolve();
        await release.promise;
        reply(response, identity("account-b"));
      } else reply(response, credential("account-b"));
    });
    await test.client.login(loginInput);
    const switching = test.client.switchAccount("account-b");
    await arrived.promise;
    await test.client.logout();
    release.resolve();
    await switching;
    expect(await test.transport.getSession()).toBeNull();
    expect(test.client.getSnapshot().status).toBe("signed_out");
  });

  it.each(["invalid-json", "network"])(
    "maps %s without leaking server details",
    async (failure) => {
      const test = await fixture((_request, response) => {
        if (failure === "network") response.destroy();
        else response.end("not-json fixture-token");
      });
      await expect(test.client.login(loginInput)).rejects.toMatchObject({
        authError: {
          code: failure === "network" ? "network" : "invalid_response",
        },
      });
      expect(JSON.stringify(test.client.getSnapshot())).not.toContain(
        "fixture-token",
      );
    },
  );

  it.each(["refresh", "unavailable", "forbidden"] as const)(
    "bridges real Gateway invalidation (%s) without replaying login",
    async (strategy) => {
      const test = await fixture((request, response) => {
        if (request.url === "/auth/login-by-password")
          reply(response, credential());
        else if (request.url === "/api/v1/auth/me") reply(response, identity());
        else if (
          strategy === "forbidden" ||
          request.headers.authorization === "Bearer fixture-account-a"
        ) {
          const status = strategy === "forbidden" ? 403 : 401;
          response.statusCode = status;
          response.end(
            JSON.stringify({ code: status, message: "Rejected", data: null }),
          );
        } else reply(response, { conversations: [] });
      });
      let refreshes = 0;
      if (strategy === "refresh")
        test.transport.refresh = async () => {
          refreshes++;
          await new Promise<void>((resolve) => setImmediate(resolve));
          return { kind: "bearer", token: "fixture-refreshed" };
        };
      await test.client.login(loginInput);
      const gateway = createTFRobotChatGateway({
        baseUrl: test.baseUrl,
        sessionProvider: test.client.createSessionProvider(),
        messageCreatorProvider: () => ({ uid: "9", name: "Fixture user" }),
      });
      try {
        const result = await gateway.listConversations({
          deadlineAt: Date.now() + 5000,
        });
        expect(result.ok).toBe(strategy === "refresh");
        expect(
          test.requests.filter(
            ({ path }) => path === "/auth/login-by-password",
          ),
        ).toHaveLength(1);
        expect(refreshes).toBe(strategy === "refresh" ? 1 : 0);
        if (strategy === "refresh") {
          expect(
            test.requests
              .filter(({ path }) => path.startsWith("/v1/chat/"))
              .map(({ authorization }) => authorization),
          ).toEqual(["Bearer fixture-account-a", "Bearer fixture-refreshed"]);
          expect(test.client.getSnapshot().status).toBe("authenticated");
        } else if (strategy === "unavailable") {
          expect(test.client.getSnapshot().status).toBe("auth_required");
          expect(await test.transport.getSession()).toBeNull();
        } else {
          expect(test.client.getSnapshot()).toMatchObject({
            status: "authenticated",
            error: { code: "authorization_denied" },
          });
          expect(test.requests).toHaveLength(2);
        }
      } finally {
        await gateway.dispose({ deadlineAt: Date.now() + 5000 });
      }
    },
  );
});
