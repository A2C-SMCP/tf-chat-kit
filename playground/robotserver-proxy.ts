import type { IncomingMessage, ServerResponse } from "node:http";

import type { Plugin } from "vite";

import { ROBOTSERVER_PROXY_PREFIX } from "./src/robotserver-target.js";

const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
const MAX_LOGIN_REQUEST_BYTES = 8 * 1024;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = 15_000;
const ROUTING_SEGMENT = /^[a-z0-9-]+$/u;
const CHAT_PATH = /^\/v1\/chat(?:\/|$)/u;
const LOGIN_PATH = "/v1/auth/login";

interface ProxyTarget {
  readonly kind: "chat" | "login";
  readonly namespace: string;
  readonly robotId: string;
  readonly robotType: "tfrobot";
  readonly upstreamUrl: URL;
}

const sendJson = (
  response: ServerResponse,
  status: number,
  message: string,
): void => {
  response.statusCode = status;
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify({ code: status, message }));
};

const allowedOrigins = (): ReadonlySet<string> =>
  new Set(
    (process.env["TF_CHAT_PLAYGROUND_ALLOWED_API_ORIGINS"] ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
      .flatMap((value) => {
        try {
          return [new URL(value).origin];
        } catch {
          return [];
        }
      }),
  );

const isAllowedUpstream = (url: URL): boolean => {
  if (allowedOrigins().has(url.origin)) return true;
  return (
    url.protocol === "https:" &&
    (url.hostname === "api.turingfocus.cn" ||
      (url.hostname.startsWith("api.") &&
        url.hostname.endsWith(".turingfocus.cn")))
  );
};

const parseTarget = (requestUrl: string): ProxyTarget | undefined => {
  const queryIndex = requestUrl.indexOf("?");
  const rawPathname =
    queryIndex === -1 ? requestUrl : requestUrl.slice(0, queryIndex);
  const prefix = `${ROBOTSERVER_PROXY_PREFIX}/`;
  if (!rawPathname.startsWith(prefix)) return undefined;
  const rawParts = rawPathname.slice(prefix.length).split("/");
  if (/%(?:2e|2f|5c)/iu.test(rawParts.slice(4).join("/"))) {
    return undefined;
  }
  const url = new URL(requestUrl, "http://playground.invalid");
  if (!url.pathname.startsWith(prefix)) return undefined;
  const parts = url.pathname.slice(prefix.length).split("/");
  const [encodedOrigin, robotType, namespace, robotId, ...rest] = parts;
  if (
    encodedOrigin === undefined ||
    robotType !== "tfrobot" ||
    !ROUTING_SEGMENT.test(namespace ?? "") ||
    !ROUTING_SEGMENT.test(robotId ?? "")
  ) {
    return undefined;
  }

  let upstreamOrigin: URL;
  try {
    upstreamOrigin = new URL(decodeURIComponent(encodedOrigin));
  } catch {
    return undefined;
  }
  if (
    upstreamOrigin.origin !== upstreamOrigin.toString().replace(/\/$/u, "") ||
    !isAllowedUpstream(upstreamOrigin)
  ) {
    return undefined;
  }

  const pathname = `/${rest.join("/")}`;
  const kind =
    pathname === LOGIN_PATH && url.search.length === 0 ? "login" : "chat";
  if (kind === "chat" && !CHAT_PATH.test(pathname)) return undefined;
  const upstreamUrl = new URL(pathname, upstreamOrigin);
  if (
    (kind === "chat" && !CHAT_PATH.test(upstreamUrl.pathname)) ||
    (kind === "login" && upstreamUrl.pathname !== LOGIN_PATH)
  ) {
    return undefined;
  }
  upstreamUrl.search = url.search;
  return {
    kind,
    namespace: namespace!,
    robotId: robotId!,
    robotType,
    upstreamUrl,
  };
};

const isSameOrigin = (request: IncomingMessage): boolean => {
  const origin = request.headers.origin;
  const host = request.headers.host;
  if (host === undefined) return false;
  try {
    const encrypted = Boolean(
      (request.socket as typeof request.socket & { encrypted?: boolean })
        .encrypted,
    );
    const expectedOrigin = `${encrypted ? "https" : "http"}://${host}`;
    if (origin !== undefined) return new URL(origin).origin === expectedOrigin;
    const referer = request.headers.referer;
    return (
      request.headers["sec-fetch-site"] === "same-origin" &&
      referer !== undefined &&
      new URL(referer).origin === expectedOrigin
    );
  } catch {
    return false;
  }
};

const readBody = async (
  request: IncomingMessage,
  maxBytes: number,
): Promise<Uint8Array> => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > maxBytes) throw new Error("request-too-large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
};

const readResponseBody = async (
  upstreamResponse: Response,
  controller: AbortController,
): Promise<Uint8Array> => {
  const contentLength = Number(
    upstreamResponse.headers.get("content-length") ?? "0",
  );
  if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
    controller.abort();
    throw new Error("response-too-large");
  }
  if (upstreamResponse.body === null) return new Uint8Array();

  const reader = upstreamResponse.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        controller.abort();
        throw new Error("response-too-large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
};

const proxyRequest = async (
  request: IncomingMessage,
  response: ServerResponse,
  target: ProxyTarget,
): Promise<void> => {
  const authorization = request.headers.authorization;
  const adminKeyHeader = request.headers["admin_key"];
  const adminKey = Array.isArray(adminKeyHeader)
    ? adminKeyHeader[0]
    : adminKeyHeader;
  if (target.kind === "chat") {
    if ((authorization === undefined) === (adminKey === undefined)) {
      sendJson(response, 401, "必须且只能提供一种 RobotServer 凭据。");
      return;
    }
    if (
      authorization !== undefined &&
      !/^Bearer [^\s].*$/u.test(authorization)
    ) {
      sendJson(response, 401, "请提供有效的 Bearer 凭据。");
      return;
    }
  } else if (authorization !== undefined || adminKey !== undefined) {
    sendJson(response, 400, "管理员密码登录请求不能携带 Token 凭据。");
    return;
  }

  let body: Uint8Array | undefined;
  try {
    body =
      request.method === "POST"
        ? await readBody(
            request,
            target.kind === "login"
              ? MAX_LOGIN_REQUEST_BYTES
              : MAX_REQUEST_BYTES,
          )
        : undefined;
  } catch {
    sendJson(response, 413, "RobotServer 代理请求体过大。");
    return;
  }

  if (target.kind === "login") {
    const contentType = request.headers["content-type"];
    if (
      typeof contentType !== "string" ||
      !contentType.toLowerCase().startsWith("application/json") ||
      body === undefined
    ) {
      sendJson(response, 400, "管理员密码登录请求必须使用 JSON。");
      return;
    }
    try {
      const payload = JSON.parse(Buffer.from(body).toString("utf8")) as unknown;
      if (
        payload === null ||
        typeof payload !== "object" ||
        Array.isArray(payload)
      ) {
        throw new Error("invalid-login-body");
      }
      const record = payload as Record<string, unknown>;
      if (
        Object.keys(record).length !== 1 ||
        typeof record["password"] !== "string" ||
        record["password"].length === 0 ||
        record["password"].length > 4_096
      ) {
        throw new Error("invalid-login-body");
      }
    } catch {
      sendJson(response, 400, "管理员密码登录请求格式无效。");
      return;
    }
  }

  const headers = new Headers({
    Accept: "application/json",
    "X-TF-Namespace": target.namespace,
    "X-TF-RobotId": target.robotId,
    "X-TF-RobotType": target.robotType,
  });
  if (target.kind === "chat" && authorization !== undefined) {
    headers.set("Authorization", authorization);
  }
  if (target.kind === "chat" && adminKey !== undefined) {
    headers.set("admin_key", adminKey);
  }
  const contentType = request.headers["content-type"];
  if (contentType !== undefined) headers.set("Content-Type", contentType);

  const controller = new AbortController();
  const abortUpstream = (): void => controller.abort();
  request.once("aborted", abortUpstream);
  response.once("close", abortUpstream);
  const timeout = setTimeout(abortUpstream, UPSTREAM_TIMEOUT_MS);
  try {
    const upstreamResponse = await fetch(target.upstreamUrl, {
      ...(body === undefined ? {} : { body: Buffer.from(body) }),
      headers,
      method: request.method ?? "GET",
      redirect: "manual",
      signal: controller.signal,
    });
    const responseBody = await readResponseBody(upstreamResponse, controller);
    if (response.destroyed) return;
    response.statusCode = upstreamResponse.status;
    response.setHeader("Cache-Control", "no-store");
    const upstreamContentType = upstreamResponse.headers.get("content-type");
    if (upstreamContentType !== null) {
      response.setHeader("Content-Type", upstreamContentType);
    }
    const retryAfter = upstreamResponse.headers.get("retry-after");
    if (retryAfter !== null) response.setHeader("Retry-After", retryAfter);
    response.end(responseBody);
  } catch {
    if (!response.destroyed) {
      sendJson(response, 502, "本地代理无法连接 RobotServer。");
    }
  } finally {
    clearTimeout(timeout);
    request.off("aborted", abortUpstream);
    response.off("close", abortUpstream);
  }
};

export const createRobotServerProxyPlugin = (): Plugin => ({
  apply: "serve",
  configureServer(server) {
    server.middlewares.use((request, response, next) => {
      if (!request.url?.startsWith(ROBOTSERVER_PROXY_PREFIX)) {
        next();
        return;
      }
      if (!isSameOrigin(request)) {
        sendJson(response, 403, "RobotServer 代理请求已被拒绝。");
        return;
      }
      const target = parseTarget(request.url);
      if (target === undefined) {
        sendJson(response, 400, "RobotServer 代理目标无效。");
        return;
      }
      const methodAllowed =
        target.kind === "login"
          ? request.method === "POST"
          : request.method === "GET" || request.method === "POST";
      if (!methodAllowed) {
        sendJson(response, 405, "该 RobotServer 代理请求方法不受支持。");
        return;
      }
      void proxyRequest(request, response, target);
    });
  },
  name: "tf-chat-playground-robotserver-proxy",
});
