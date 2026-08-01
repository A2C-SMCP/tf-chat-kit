import {
  createServer as createHttpServer,
  request as createHttpRequest,
  type Server,
} from "node:http";

import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer as createViteServer, type ViteDevServer } from "vite";

import { createRobotServerProxyPlugin } from "../playground/robotserver-proxy.js";

const listen = async (server: Server): Promise<string> =>
  new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("Server did not expose a TCP address."));
        return;
      }
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });

const close = async (server: Server): Promise<void> =>
  new Promise((resolve, reject) =>
    server.close((error) => (error === undefined ? resolve() : reject(error))),
  );

const rawGet = async (
  origin: string,
  path: string,
  headers: Readonly<Record<string, string>>,
): Promise<number> => {
  const target = new URL(origin);
  return new Promise((resolve, reject) => {
    const request = createHttpRequest(
      {
        headers,
        hostname: target.hostname,
        method: "GET",
        path,
        port: target.port,
      },
      (response) => {
        response.resume();
        response.once("end", () => resolve(response.statusCode ?? 0));
      },
    );
    request.once("error", reject);
    request.end();
  });
};

describe("Playground RobotServer proxy", () => {
  let vite: ViteDevServer | undefined;
  let playgroundServer: Server | undefined;
  let upstreamServer: Server | undefined;
  const previousAllowedOrigins =
    process.env["TF_CHAT_PLAYGROUND_ALLOWED_API_ORIGINS"];

  afterEach(async () => {
    if (playgroundServer !== undefined) await close(playgroundServer);
    if (vite !== undefined) await vite.close();
    if (upstreamServer !== undefined) await close(upstreamServer);
    playgroundServer = undefined;
    upstreamServer = undefined;
    vite = undefined;
    if (previousAllowedOrigins === undefined) {
      delete process.env["TF_CHAT_PLAYGROUND_ALLOWED_API_ORIGINS"];
    } else {
      process.env["TF_CHAT_PLAYGROUND_ALLOWED_API_ORIGINS"] =
        previousAllowedOrigins;
    }
    vi.restoreAllMocks();
  });

  it("injects routing headers and rejects cross-origin or ambiguous credentials", async () => {
    const upstreamRequests: Array<{
      readonly authorization?: string | undefined;
      readonly cookie?: string | undefined;
      readonly namespace?: string | undefined;
      readonly robotId?: string | undefined;
      readonly robotType?: string | undefined;
      readonly url: string;
    }> = [];
    upstreamServer = createHttpServer((request, response) => {
      upstreamRequests.push({
        authorization: request.headers.authorization,
        cookie: request.headers.cookie,
        namespace: request.headers["x-tf-namespace"] as string | undefined,
        robotId: request.headers["x-tf-robotid"] as string | undefined,
        robotType: request.headers["x-tf-robottype"] as string | undefined,
        url: request.url ?? "",
      });
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ code: 200, data: { conversations: [] } }));
    });
    const upstreamOrigin = await listen(upstreamServer);
    process.env["TF_CHAT_PLAYGROUND_ALLOWED_API_ORIGINS"] = upstreamOrigin;

    vite = await createViteServer({
      appType: "custom",
      plugins: [createRobotServerProxyPlugin()],
      server: { middlewareMode: true },
    });
    playgroundServer = createHttpServer(vite.middlewares);
    const playgroundOrigin = await listen(playgroundServer);
    const proxyPath = `/__tfrobot_proxy/${encodeURIComponent(
      upstreamOrigin,
    )}/tfrobot/example-ns/example-robot/v1/chat/conversations?platformId=1`;

    const accepted = await fetch(`${playgroundOrigin}${proxyPath}`, {
      headers: {
        Authorization: "Bearer memory-only-secret",
        Cookie: "must-not-reach-robotserver=true",
        Origin: playgroundOrigin,
      },
    });
    expect(accepted.status).toBe(200);
    expect(upstreamRequests).toEqual([
      {
        authorization: "Bearer memory-only-secret",
        cookie: undefined,
        namespace: "example-ns",
        robotId: "example-robot",
        robotType: "tfrobot",
        url: "/v1/chat/conversations?platformId=1",
      },
    ]);

    const crossOrigin = await fetch(`${playgroundOrigin}${proxyPath}`, {
      headers: {
        Authorization: "Bearer memory-only-secret",
        Origin: "https://attacker.example",
      },
    });
    expect(crossOrigin.status).toBe(403);

    const ambiguous = await fetch(`${playgroundOrigin}${proxyPath}`, {
      headers: {
        admin_key: "admin-secret",
        Authorization: "Bearer memory-only-secret",
        Origin: playgroundOrigin,
      },
    });
    expect(ambiguous.status).toBe(401);
    const traversalStatus = await rawGet(
      playgroundOrigin,
      proxyPath.replace(
        "/v1/chat/conversations?platformId=1",
        "/v1/chat/%2e%2e/admin",
      ),
      {
        Authorization: "Bearer memory-only-secret",
        Host: new URL(playgroundOrigin).host,
        Origin: playgroundOrigin,
      },
    );
    expect(traversalStatus).toBe(400);
    expect(upstreamRequests).toHaveLength(1);
    expect(JSON.stringify(await ambiguous.json())).not.toContain(
      "memory-only-secret",
    );
  });

  it("forwards only a validated administrator-password login body", async () => {
    const received: Array<{
      readonly authorization?: string | undefined;
      readonly body: string;
      readonly namespace?: string | undefined;
      readonly robotId?: string | undefined;
      readonly url: string;
    }> = [];
    upstreamServer = createHttpServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      received.push({
        authorization: request.headers.authorization,
        body: Buffer.concat(chunks).toString("utf8"),
        namespace: request.headers["x-tf-namespace"] as string | undefined,
        robotId: request.headers["x-tf-robotid"] as string | undefined,
        url: request.url ?? "",
      });
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          code: 200,
          data: { accessToken: "short-lived-token", expiresAt: "later" },
        }),
      );
    });
    const upstreamOrigin = await listen(upstreamServer);
    process.env["TF_CHAT_PLAYGROUND_ALLOWED_API_ORIGINS"] = upstreamOrigin;
    vite = await createViteServer({
      appType: "custom",
      plugins: [createRobotServerProxyPlugin()],
      server: { middlewareMode: true },
    });
    playgroundServer = createHttpServer(vite.middlewares);
    const playgroundOrigin = await listen(playgroundServer);
    const proxyPath = `/__tfrobot_proxy/${encodeURIComponent(
      upstreamOrigin,
    )}/tfrobot/example-ns/example-robot/v1/auth/login`;
    const password = "request-memory-only-password";

    const accepted = await fetch(`${playgroundOrigin}${proxyPath}`, {
      body: JSON.stringify({ password }),
      headers: {
        "Content-Type": "application/json",
        Origin: playgroundOrigin,
      },
      method: "POST",
    });
    expect(accepted.status).toBe(200);
    expect(received).toEqual([
      {
        authorization: undefined,
        body: JSON.stringify({ password }),
        namespace: "example-ns",
        robotId: "example-robot",
        url: "/v1/auth/login",
      },
    ]);

    const extraField = await fetch(`${playgroundOrigin}${proxyPath}`, {
      body: JSON.stringify({ password, persist: true }),
      headers: {
        "Content-Type": "application/json",
        Origin: playgroundOrigin,
      },
      method: "POST",
    });
    expect(extraField.status).toBe(400);
    expect(await extraField.text()).not.toContain(password);

    const tokenMixedIn = await fetch(`${playgroundOrigin}${proxyPath}`, {
      body: JSON.stringify({ password }),
      headers: {
        Authorization: "Bearer must-not-be-forwarded",
        "Content-Type": "application/json",
        Origin: playgroundOrigin,
      },
      method: "POST",
    });
    expect(tokenMixedIn.status).toBe(400);
    expect(received).toHaveLength(1);
  });

  it("rejects an oversized upstream response before buffering its body", async () => {
    upstreamServer = createHttpServer((_request, response) => {
      response.writeHead(200, {
        "Content-Length": String(16 * 1024 * 1024 + 1),
        "Content-Type": "application/json",
      });
      response.flushHeaders();
    });
    const upstreamOrigin = await listen(upstreamServer);
    process.env["TF_CHAT_PLAYGROUND_ALLOWED_API_ORIGINS"] = upstreamOrigin;
    vite = await createViteServer({
      appType: "custom",
      plugins: [createRobotServerProxyPlugin()],
      server: { middlewareMode: true },
    });
    playgroundServer = createHttpServer(vite.middlewares);
    const playgroundOrigin = await listen(playgroundServer);
    const proxyPath = `/__tfrobot_proxy/${encodeURIComponent(
      upstreamOrigin,
    )}/tfrobot/example-ns/example-robot/v1/chat/conversations`;

    const response = await fetch(`${playgroundOrigin}${proxyPath}`, {
      headers: {
        Authorization: "Bearer memory-only-secret",
        Origin: playgroundOrigin,
      },
    });
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain("memory-only-secret");
  });

  it("aborts an in-flight upstream request when the browser request is cancelled", async () => {
    let upstreamClosed = false;
    let markUpstreamStarted: (() => void) | undefined;
    const upstreamStarted = new Promise<void>((resolve) => {
      markUpstreamStarted = resolve;
    });
    upstreamServer = createHttpServer((_request, response) => {
      response.once("close", () => {
        upstreamClosed = true;
      });
      response.writeHead(200, { "Content-Type": "application/json" });
      response.write('{"code":200,"data":');
      markUpstreamStarted?.();
    });
    const upstreamOrigin = await listen(upstreamServer);
    process.env["TF_CHAT_PLAYGROUND_ALLOWED_API_ORIGINS"] = upstreamOrigin;
    vite = await createViteServer({
      appType: "custom",
      plugins: [createRobotServerProxyPlugin()],
      server: { middlewareMode: true },
    });
    playgroundServer = createHttpServer(vite.middlewares);
    const playgroundOrigin = await listen(playgroundServer);
    const proxyPath = `/__tfrobot_proxy/${encodeURIComponent(
      upstreamOrigin,
    )}/tfrobot/example-ns/example-robot/v1/chat/conversations`;
    const controller = new AbortController();
    const downstream = fetch(`${playgroundOrigin}${proxyPath}`, {
      headers: {
        Authorization: "Bearer memory-only-secret",
        Origin: playgroundOrigin,
      },
      signal: controller.signal,
    });
    await upstreamStarted;
    controller.abort();
    await expect(downstream).rejects.toThrow();
    await vi.waitFor(() => expect(upstreamClosed).toBe(true));
  });
});
