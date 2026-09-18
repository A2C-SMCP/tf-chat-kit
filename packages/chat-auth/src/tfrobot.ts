import type {
  AccountContext,
  AuthErrorCode,
  AuthSession,
  AuthTransport,
  LoginInput,
  LoginResult,
} from "./headless.js";

export interface TfRobotRequestInit {
  readonly method?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
}

export type TfRobotFetch = (
  input: string,
  init?: TfRobotRequestInit,
) => Promise<{ readonly status: number; json(): Promise<unknown> }>;

/** Transport factory implemented in the TFRobot adapter task. */
export interface TfRobotAuthTransportOptions {
  readonly baseUrl: string;
  readonly fetch?: TfRobotFetch;
}

export class TfRobotAuthError extends Error {
  readonly code: AuthErrorCode;
  readonly status: number | undefined;
  readonly retryable: boolean;

  constructor(code: AuthErrorCode, message: string, status?: number) {
    super(message);
    this.name = "TfRobotAuthError";
    this.code = code;
    this.status = status;
    this.retryable = code === "network" || code === "unknown";
  }
}

type AuthResponse = {
  readonly status: number;
  json(): Promise<unknown>;
};

const defaultFetch: TfRobotFetch = async (input, init) => {
  if (typeof globalThis.fetch !== "function")
    throw new TfRobotAuthError("network", "Fetch is unavailable");
  return (globalThis.fetch(input, init) as unknown) as AuthResponse;
};

const objectOf = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};

const stringField = (
  value: Record<string, unknown>,
  ...names: string[]
): string | undefined => {
  for (const name of names) {
    const candidate = value[name];
    if (typeof candidate === "string" && candidate.length > 0) return candidate;
  }
  return undefined;
};

const accountFrom = (value: unknown): AccountContext => {
  const record = objectOf(value);
  const userId = stringField(record, "userId", "uid", "user_id");
  const accountId = stringField(record, "accountId", "id", "account_id");
  if (userId === undefined || accountId === undefined) {
    throw new TfRobotAuthError(
      "invalid_response",
      "TFRobot auth response did not contain an account",
    );
  }
  const organizationId = stringField(
    record,
    "organizationId",
    "organization_id",
    "orgId",
    "org_id",
  );
  const displayName = stringField(record, "displayName", "name", "username");
  return {
    userId,
    accountId,
    ...(organizationId === undefined ? {} : { organizationId }),
    ...(displayName === undefined ? {} : { displayName }),
  };
};

const tokenFrom = (value: unknown): AuthSession | null => {
  const record = objectOf(value);
  const credentialValue = stringField(
    record,
    "token",
    "access_token",
    "accessToken",
  );
  if (credentialValue === undefined) return null;
  const expiresAt =
    typeof record["expiresAt"] === "number" ? record["expiresAt"] : undefined;
  return {
    kind: "bearer",
    ["token"]: credentialValue,
    ...(expiresAt === undefined ? {} : { expiresAt }),
  };
};

const accountsFrom = (value: unknown): AccountContext[] => {
  const record = objectOf(value);
  const source = Array.isArray(record["accounts"])
    ? record["accounts"]
    : Array.isArray(value)
      ? value
      : [];
  return source.map(accountFrom);
};

const resultFrom = (
  payload: unknown,
  session: AuthSession | null,
): LoginResult => {
  const record = objectOf(payload);
  const accounts = accountsFrom(payload);
  if (
    accounts.length > 1 ||
    record["accountSelectionRequired"] === true ||
    record["requiresAccountSelection"] === true
  ) {
    return { kind: "account-selection-required", accounts };
  }
  const accountValue = record["account"] ?? record["user"] ?? payload;
  const account = accountFrom(accountValue);
  if (
    record["onboardingRequired"] === true ||
    record["requiresOnboarding"] === true
  ) {
    return { kind: "onboarding-required", account };
  }
  if (session === null) {
    throw new TfRobotAuthError(
      "invalid_response",
      "TFRobot login response did not contain a session",
    );
  }
  return { kind: "authenticated", account };
};

export const createTfRobotAuthTransport = (
  options: TfRobotAuthTransportOptions,
): AuthTransport => {
  const parsedBaseUrl = new URL(options.baseUrl);
  if (
    (parsedBaseUrl.protocol !== "http:" && parsedBaseUrl.protocol !== "https:") ||
    parsedBaseUrl.username !== "" ||
    parsedBaseUrl.password !== "" ||
    parsedBaseUrl.search !== "" ||
    parsedBaseUrl.hash !== ""
  ) {
    throw new TypeError(
      "TFRobot auth baseUrl must be an http(s) origin without credentials or query parameters",
    );
  }
  const baseUrl = parsedBaseUrl.toString().replace(/\/$/u, "");
  const request = async (
    path: string,
    init: TfRobotRequestInit = {},
  ): Promise<unknown> => {
    const fetcher = options.fetch ?? defaultFetch;
    let response: AuthResponse;
    try {
      response = await fetcher(`${baseUrl}${path}`, init);
    } catch {
      throw new TfRobotAuthError(
        "network",
        "TFRobot authentication request failed",
      );
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      payload = undefined;
    }
    if (response.status === 401)
      throw new TfRobotAuthError(
        "authentication_required",
        "Authentication is required",
        401,
      );
    if (response.status === 403)
      throw new TfRobotAuthError(
        "authorization_denied",
        "Authentication is not authorized",
        403,
      );
    if (response.status === 404)
      throw new TfRobotAuthError(
        "unsupported",
        "TFRobot authentication endpoint is unavailable",
        404,
      );
    if (response.status < 200 || response.status >= 300)
      throw new TfRobotAuthError(
        "unknown",
        "TFRobot authentication request failed",
        response.status,
      );
    return payload;
  };

  let currentSession: AuthSession | null = null;
  const authHeaders = () =>
    currentSession === null
      ? {}
      : { Authorization: `Bearer ${currentSession.token}` };
  const json = (body: unknown) => ({
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(body),
  });

  return {
    async login(input: LoginInput) {
      const payload = await request(
        "/auth/login-by-password",
        json({
          identifier: input.identifier,
          ["password"]: input.password,
        }),
      );
      const session = tokenFrom(payload);
      if (session !== null) currentSession = session;
      return resultFrom(payload, session);
    },
    async selectAccount(accountId: string) {
      const payload = await request(
        "/auth/select-account",
        json({ accountId }),
      );
      const session = tokenFrom(payload);
      if (session !== null) currentSession = session;
      return resultFrom(payload, session ?? currentSession);
    },
    async getCurrentAccount() {
      return accountFrom(
        await request("/api/v1/auth/me", { headers: authHeaders() }),
      );
    },
    async listAccounts() {
      return accountsFrom(
        await request("/api/v1/accounts/my", { headers: authHeaders() }),
      );
    },
    async switchAccount(accountId: string) {
      const payload = await request(
        "/api/v1/auth/switch-account",
        json({ accountId }),
      );
      const session = tokenFrom(payload);
      if (session !== null) currentSession = session;
      const accountValue =
        objectOf(payload)["account"] ?? objectOf(payload)["user"] ?? payload;
      return accountFrom(accountValue);
    },
    async getSession() {
      return currentSession;
    },
    restoreSession(session: AuthSession) {
      currentSession = session;
    },
    clearSession() {
      currentSession = null;
    },
    async logout() {
      currentSession = null;
    },
  };
};
