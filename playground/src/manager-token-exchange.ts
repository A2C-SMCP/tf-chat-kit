import type {
  SessionInvalidation,
  SessionProvider,
  SessionRequest,
} from "@turingfocus/chat-protocol";
import type { TFRobotSession } from "@turingfocus/chat-gateway-tfrobot";

const TOKEN_EXCHANGE_GRANT = "urn:ietf:params:oauth:grant-type:token-exchange";
const JWT_SUBJECT_TYPE = "urn:ietf:params:oauth:token-type:jwt";
const DEFAULT_SCOPE = "chat:read chat:send";
const DEFAULT_TOKEN_PROFILE = "session";
const REFRESH_SKEW_MS = 30_000;

export interface ManagerRobotTokenExchangeOptions {
  readonly tokenUrl: string;
  readonly getManagerUserJwt: () => Promise<string>;
  readonly robotAccountId: string;
  readonly scope?: string | undefined;
  readonly tokenProfile?: string | undefined;
  readonly fetch?: typeof globalThis.fetch | undefined;
  readonly now?: (() => number) | undefined;
}

export type ManagerRobotTokenErrorCode =
  | "authentication"
  | "authorization"
  | "not_found"
  | "rate_limited"
  | "server"
  | "network"
  | "invalid_response";

export class ManagerRobotTokenExchangeError extends Error {
  readonly code: ManagerRobotTokenErrorCode;
  readonly status?: number | undefined;

  constructor(
    code: ManagerRobotTokenErrorCode,
    message: string,
    status?: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ManagerRobotTokenExchangeError";
    this.code = code;
    this.status = status;
  }
}

interface CachedToken {
  readonly token: string;
  readonly expiresAt: number;
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;

const mapStatus = (status: number): ManagerRobotTokenErrorCode => {
  if (status === 401) return "authentication";
  if (status === 403) return "authorization";
  if (status === 404) return "not_found";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "server";
  return "invalid_response";
};

const safeErrorMessage = (status: number): string => {
  switch (mapStatus(status)) {
    case "authentication":
      return "Manager 用户 Token 无效或已过期。";
    case "authorization":
      return "当前用户无权访问该机器人。";
    case "not_found":
      return "Manager 未找到 Token Exchange 接口或目标机器人。";
    case "rate_limited":
      return "Token Exchange 请求过于频繁，请稍后重试。";
    case "server":
      return "Manager Token Exchange 服务暂时不可用。";
    default:
      return "Manager Token Exchange 请求失败。";
  }
};

const normalizeTokenUrl = (value: string): string => {
  try {
    const url = new URL(value);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username.length > 0 ||
      url.password.length > 0 ||
      url.hash.length > 0
    ) {
      throw new Error("invalid-token-url");
    }
    return url.toString();
  } catch {
    throw new TypeError("Manager Token Exchange 地址无效");
  }
};

/**
 * Browser-safe Manager → RobotServer session adapter.
 *
 * The Manager JWT is obtained lazily and is only placed in the RFC 8693 form
 * body. The RobotServer gateway receives only the exchanged short token.
 */
export class ManagerRobotTokenSource implements SessionProvider<TFRobotSession> {
  readonly #fetch: typeof globalThis.fetch;
  readonly #getManagerUserJwt: () => Promise<string>;
  readonly #now: () => number;
  readonly #robotAccountId: string;
  readonly #scope: string;
  readonly #tokenProfile: string;
  readonly #tokenUrl: string;
  #cached: CachedToken | undefined;
  #generation = 0;
  #inFlight:
    | { readonly generation: number; readonly promise: Promise<CachedToken> }
    | undefined;

  constructor(options: ManagerRobotTokenExchangeOptions) {
    const robotAccountId = options.robotAccountId.trim();
    if (robotAccountId.length === 0) {
      throw new TypeError("robotAccountId 不能为空");
    }
    this.#robotAccountId = robotAccountId;
    this.#scope = options.scope?.trim() || DEFAULT_SCOPE;
    this.#tokenProfile = options.tokenProfile?.trim() || DEFAULT_TOKEN_PROFILE;
    if (this.#tokenProfile !== DEFAULT_TOKEN_PROFILE) {
      throw new TypeError("只支持 session Token Profile");
    }
    this.#tokenUrl = normalizeTokenUrl(options.tokenUrl);
    // Browsers brand-check `fetch`: a host-provided reference stored as-is and
    // invoked as an instance method throws "Illegal invocation" before the
    // request leaves the page. Wrapping drops that foreign receiver, while the
    // default transport keeps resolving `globalThis.fetch` lazily per call and
    // an empty `fetch` option keeps falling back to it.
    const injectedFetch = options.fetch;
    this.#fetch =
      injectedFetch == null
        ? (input, init) => globalThis.fetch(input, init)
        : (input, init) => injectedFetch(input, init);
    this.#getManagerUserJwt = options.getManagerUserJwt;
    this.#now = options.now ?? Date.now;
  }

  async getSession(request: SessionRequest): Promise<TFRobotSession> {
    void request;
    const token = await this.getToken();
    return { kind: "bearer", token };
  }

  onSessionInvalid(invalidation: SessionInvalidation): void {
    void invalidation;
    this.invalidate();
  }

  invalidate(): void {
    this.#generation += 1;
    this.#cached = undefined;
  }

  async getToken(): Promise<string> {
    const cached = this.#cached;
    if (
      cached !== undefined &&
      cached.expiresAt - REFRESH_SKEW_MS > this.#now()
    ) {
      return cached.token;
    }
    const generation = this.#generation;
    if (this.#inFlight?.generation === generation) {
      return (await this.#inFlight.promise).token;
    }
    const request = this.#exchange(generation);
    this.#inFlight = { generation, promise: request };
    try {
      return (await request).token;
    } finally {
      if (this.#inFlight?.promise === request) this.#inFlight = undefined;
    }
  }

  async #exchange(generation: number): Promise<CachedToken> {
    const managerJwt = (await this.#getManagerUserJwt()).trim();
    if (managerJwt.length === 0) {
      throw new ManagerRobotTokenExchangeError(
        "authentication",
        "Manager 登录已失效，请重新登录。",
      );
    }
    const body = new URLSearchParams({
      grant_type: TOKEN_EXCHANGE_GRANT,
      subject_token: managerJwt,
      subject_token_type: JWT_SUBJECT_TYPE,
      audience: `robot:${this.#robotAccountId}`,
      scope: this.#scope,
      token_profile: this.#tokenProfile,
    });
    let response: Response;
    try {
      response = await this.#fetch(this.#tokenUrl, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body,
      });
    } catch (error) {
      throw new ManagerRobotTokenExchangeError(
        "network",
        "无法连接 Manager Token Exchange 接口。",
        undefined,
        { cause: error },
      );
    }
    if (!response.ok) {
      throw new ManagerRobotTokenExchangeError(
        mapStatus(response.status),
        safeErrorMessage(response.status),
        response.status,
      );
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new ManagerRobotTokenExchangeError(
        "invalid_response",
        "Manager Token Exchange 返回了无效数据。",
        response.status,
      );
    }
    const record = asRecord(payload);
    const accessToken = record?.["access_token"];
    const expiresIn = record?.["expires_in"];
    if (
      typeof accessToken !== "string" ||
      accessToken.trim().length === 0 ||
      (typeof expiresIn !== "number" && typeof expiresIn !== "string")
    ) {
      throw new ManagerRobotTokenExchangeError(
        "invalid_response",
        "Manager Token Exchange 返回缺少有效 access_token。",
        response.status,
      );
    }
    const seconds = Number(expiresIn);
    if (!Number.isFinite(seconds) || seconds <= 0) {
      throw new ManagerRobotTokenExchangeError(
        "invalid_response",
        "Manager Token Exchange 返回了无效有效期。",
        response.status,
      );
    }
    const cached: CachedToken = {
      token: accessToken,
      expiresAt: this.#now() + seconds * 1000,
    };
    if (this.#generation === generation) this.#cached = cached;
    return cached;
  }
}

export const managerTokenExchangeDefaults = {
  scope: DEFAULT_SCOPE,
  tokenProfile: DEFAULT_TOKEN_PROFILE,
} as const;
