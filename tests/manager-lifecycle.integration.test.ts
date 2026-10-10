import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { managerDiagnosticToChatError } from "../packages/chat-kit/src/manager.js";
import { createManagerClient } from "../packages/chat-auth/src/manager.js";
import { managerAuthFixture } from "./support/manager-auth.js";
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.allSettled(cleanups.splice(0).map((fn) => fn()));
});
const fixture = async (
  handler: (req: IncomingMessage, res: ServerResponse, body: string) => void,
) => {
  const auth = await managerAuthFixture();
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on("end", () => handler(req, res, body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing port");
  const manager = createManagerClient({
    auth,
    baseUrl: `http://127.0.0.1:${address.port}`,
    routing: { allowedOrigins: [], http: { kind: "direct" } },
  });
  cleanups.push(async () => {
    await manager.dispose();
    await auth.dispose();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { auth, manager, baseUrl: `http://127.0.0.1:${address.port}` };
};
const json = (res: ServerResponse, data: unknown, status = 200) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
};
describe("Manager real HTTP lifecycle", () => {
  it.each([
    "urn:ietf:params:oauth:token-type:jwt",
    "urn:ietf:params:oauth:token-type:access_token",
    undefined,
  ])(
    "accepts Manager Bearer exchange type %s over real HTTP",
    async (issuedTokenType) => {
      const { manager } = await fixture((_req, res) =>
        json(res, {
          access_token: "robot-session-fixture",
          token_type: "Bearer",
          ...(issuedTokenType === undefined
            ? {}
            : { issued_token_type: issuedTokenType }),
          expires_in: 43_200,
        }),
      );
      expect(
        await manager.createRobotSessionProvider("robot").getSession(),
      ).toMatchObject({
        kind: "bearer",
        token: "robot-session-fixture",
      });
    },
  );
  it.each(["urn:ietf:params:oauth:token-type:saml2", "unknown", 123])(
    "rejects unsupported Manager exchange type %s over real HTTP",
    async (issuedTokenType) => {
      const { manager } = await fixture((_req, res) =>
        json(res, {
          access_token: "robot-session-fixture",
          token_type: "Bearer",
          issued_token_type: issuedTokenType,
          expires_in: 43_200,
        }),
      );
      await expect(
        manager.createRobotSessionProvider("robot").getSession(),
      ).rejects.toMatchObject({
        code: "invalid_response",
      });
    },
  );
  it.each([401, 403, 404, 409, 402, 429, 500])(
    "classifies %i without treating failure as empty directory",
    async (status) => {
      const { auth, manager } = await fixture((_req, res) =>
        json(res, { token: "response-secret" }, status),
      );
      await expect(manager.loadPage()).rejects.toMatchObject({ status });
      if (status === 401)
        expect(auth.getSnapshot().status).toBe("auth_required");
      else expect(auth.getSnapshot().status).toBe("authenticated");
      expect(manager.getSnapshot().status).not.toBe("ready");
      expect(JSON.stringify(manager.getDiagnostics())).not.toContain(
        "response-secret",
      );
    },
  );
  it("handles empty pages and preserves explicit pagination", async () => {
    const { manager } = await fixture((_req, res) =>
      json(res, { data: { items: [], total: 0, page: 1, pageSize: 20 } }),
    );
    expect(await manager.refresh()).toMatchObject({
      items: [],
      hasMore: false,
      total: 0,
    });
  });
  it.each(["switch", "logout", "dispose", "cancel"] as const)(
    "cancels in-flight directory on %s",
    async (mode) => {
      let start!: () => void;
      const started = new Promise<void>((resolve) => {
        start = resolve;
      });
      let response!: ServerResponse;
      const { auth, manager } = await fixture((_req, res) => {
        response = res;
        start();
      });
      const work = manager.loadPage();
      const assertion = expect(work).rejects.toMatchObject({
        code: "cancelled",
      });
      await started;
      if (mode === "switch") await auth.switchAccount("b");
      else if (mode === "logout") await auth.logout();
      else if (mode === "dispose") await manager.dispose();
      else manager.cancel();
      json(response, { data: { items: [], total: 0, page: 1, pageSize: 20 } });
      await assertion;
      expect(manager.getSnapshot().items).toEqual([]);
    },
  );
  it.each(["logout", "dispose", "auth-dispose"] as const)(
    "revokes in-flight token delivery on %s",
    async (mode) => {
      let start!: () => void;
      const started = new Promise<void>((r) => {
        start = r;
      });
      let response!: ServerResponse;
      const { auth, manager } = await fixture((_req, res, body) => {
        expect(new URLSearchParams(body).get("audience")).toBe(
          "robot:account-a",
        );
        response = res;
        start();
      });
      const source = manager.createRobotSessionProvider("account-a");
      const work = source.getSession();
      const assertion = expect(work).rejects.toMatchObject({
        code: "cancelled",
      });
      await started;
      if (mode === "logout") await auth.logout();
      else if (mode === "auth-dispose") await auth.dispose();
      else await manager.dispose();
      json(response, { access_token: "late", expires_in: 3600 });
      await assertion;
    },
  );
  it("honors native abort and caller deadline, retaining bounded safe diagnostics", async () => {
    const { manager } = await fixture(() => {});
    const signal = new AbortController();
    const source = manager.createRobotSessionProvider("robot");
    const work = source.getSession({ signal: signal.signal });
    const assertion = expect(work).rejects.toMatchObject({ code: "cancelled" });
    signal.abort();
    await assertion;
    await expect(
      source.getSession({ deadlineAt: Date.now() + 20 }),
    ).rejects.toMatchObject({ code: "timeout" });
  });
  it("forbidden Robot sessions stay terminal until provider replacement", async () => {
    let calls = 0;
    const { manager } = await fixture((_req, res) => {
      calls++;
      json(res, { access_token: "robot", expires_in: 3600 });
    });
    const source = manager.createRobotSessionProvider("robot");
    await source.getSession();
    source.onSessionInvalid({ reason: "forbidden", error: {} });
    await expect(source.getSession()).rejects.toMatchObject({
      code: "authorization",
    });
    source.invalidate();
    await expect(source.getSession()).rejects.toMatchObject({
      code: "authorization",
    });
    expect(calls).toBe(1);
    await manager.createRobotSessionProvider("robot").getSession();
    expect(calls).toBe(2);
  });
  it("isolates concurrent Manager clients and robot audiences", async () => {
    const { auth, manager, baseUrl } = await fixture((_req, res, body) =>
      json(res, {
        access_token: new URLSearchParams(body).get("audience"),
        expires_in: 3600,
      }),
    );
    const second = createManagerClient({
      auth,
      baseUrl,
      routing: { allowedOrigins: [], http: { kind: "direct" } },
    });
    try {
      const a = manager.createRobotSessionProvider("a"),
        b = second.createRobotSessionProvider("b");
      const values = await Promise.all([a.getSession(), b.getSession()]);
      expect(values.map((value) => value.token)).toEqual([
        "robot:a",
        "robot:b",
      ]);
      await manager.dispose();
      expect((await b.getSession()).token).toBe("robot:b");
      expect(auth.getSnapshot().status).toBe("authenticated");
    } finally {
      await second.dispose();
    }
  });
  it("AuthClient disposal immediately revokes cached tokens", async () => {
    const { auth, manager } = await fixture((_req, res) =>
      json(res, { access_token: "cached", expires_in: 3600 }),
    );
    const source = manager.createRobotSessionProvider("robot");
    await source.getSession();
    await auth.dispose();
    expect(manager.getSnapshot().status).toBe("auth_required");
    await expect(source.getSession()).rejects.toMatchObject({
      code: "cancelled",
    });
  });
  it.each(["directory", "connection-info", "exchange"])(
    "records safe diagnostics for malformed %s HTTP success",
    async (operation) => {
      const { manager } = await fixture((_req, res) =>
        json(res, { code: 200, data: { token: "raw-secret" } }),
      );
      const work =
        operation === "directory"
          ? manager.loadPage()
          : operation === "connection-info"
            ? manager.getConnectionInfo("employee")
            : manager.createRobotSessionProvider("robot").getSession();
      await expect(work).rejects.toMatchObject({ code: "invalid_response" });
      expect(manager.getDiagnostics()).toHaveLength(1);
      expect(manager.getDiagnostics()[0]).toMatchObject({
        operation,
        code: "invalid_response",
      });
      expect(JSON.stringify(manager.getDiagnostics())).not.toContain(
        "raw-secret",
      );
    },
  );
  it("bridges allowlisted Manager failures into existing Chat diagnostics", () => {
    expect(
      managerDiagnosticToChatError({
        operation: "exchange",
        code: "authorization",
        status: 403,
        requestId: "a1223344-1122-3344-5566-112233445566",
      }),
    ).toMatchObject({
      code: "authorization",
      diagnostic: {
        phase: "manager.exchange",
        httpStatus: 403,
        requestId: "a1223344-1122-3344-5566-112233445566",
      },
    });
    expect(
      JSON.stringify(
        managerDiagnosticToChatError({
          operation: "directory",
          code: "untrusted-secret",
          path: "/secret-token",
          requestId: "secret-token",
        }),
      ),
    ).not.toMatch(/secret-token|untrusted-secret/u);
  });
  it("does not retain credentials or raw payloads in observer projections", async () => {
    const f = await fixture((_req, res) =>
      json(res, {
        data: {
          items: [],
          total: 0,
          page: 1,
          pageSize: 20,
          token: "raw-token",
        },
      }),
    );
    const manager = f.manager;
    await manager.loadPage();
    expect(JSON.stringify(manager.getSnapshot())).not.toMatch(
      /raw-token|manager-secret/u,
    );
  });
});
