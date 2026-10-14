import type {
  AccountContext,
  AccountOption,
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
  return globalThis.fetch(input, init) as unknown as AuthResponse;
};

const invalidResponse = (): never => {
  throw new TfRobotAuthError(
    "invalid_response",
    "TFRobot authentication response is invalid",
  );
};

const objectOf = (value: unknown): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return invalidResponse();
  return value as Record<string, unknown>;
};

const stringField = (
  record: Record<string, unknown>,
  ...names: string[]
): string | undefined => {
  let result: string | undefined;
  for (const name of names) {
    const value = record[name];
    if (value == null) continue;
    if (typeof value !== "string" || value.trim().length === 0)
      return invalidResponse();
    if (result !== undefined && result !== value) return invalidResponse();
    result = value;
  }
  return result;
};

const identifierField = (
  record: Record<string, unknown>,
  ...names: string[]
): string | undefined => {
  let result: string | undefined;
  for (const name of names) {
    const value = record[name];
    if (value == null) continue;
    if (
      !(typeof value === "string" && value.trim().length > 0) &&
      !(typeof value === "number" && Number.isSafeInteger(value) && value > 0)
    )
      return invalidResponse();
    const identifier = String(value);
    if (result !== undefined && result !== identifier) return invalidResponse();
    result = identifier;
  }
  return result;
};

const dataFrom = (value: unknown): unknown => {
  const record = objectOf(value);
  if (!("code" in record)) return value;
  if (record["code"] !== 200 || !("data" in record)) return invalidResponse();
  return record["data"];
};

const accountOptionFrom = (value: unknown): AccountOption => {
  const record = objectOf(value);
  const accountId =
    identifierField(record, "accountId", "account_id") ?? invalidResponse();
  const userId = identifierField(record, "userId", "uid", "user_id");
  const organizationId = identifierField(
    Object.fromEntries(
      Object.entries(record).filter(
        ([key, value]) =>
          !["organizationId", "organization_id", "orgId", "org_id"].includes(
            key,
          ) ||
          (value !== "" && value !== 0),
      ),
    ),
    "organizationId",
    "organization_id",
    "orgId",
    "org_id",
  );
  const name = record["organizationName"];
  if (name != null && typeof name !== "string") return invalidResponse();
  const organizationName =
    typeof name === "string" ? name.trim() || undefined : undefined;
  // These are alternative presentation fields, not aliases of one ID.
  const displayName = ["displayName", "accountName", "name", "username"]
    .map((name) => {
      const value = record[name];
      if (value == null || value === "") return undefined;
      if (typeof value !== "string") return invalidResponse();
      return value;
    })
    .find((value) => value !== undefined);
  return {
    accountId,
    ...(userId === undefined ? {} : { userId }),
    ...(organizationId === undefined ? {} : { organizationId }),
    ...(organizationName === undefined ? {} : { organizationName }),
    ...(displayName === undefined ? {} : { displayName }),
  };
};

const accountFrom = (value: unknown): AccountContext => {
  const record = objectOf(value);
  const option = accountOptionFrom(record);
  const userId =
    identifierField(record, "userId", "uid", "user_id", "id") ??
    invalidResponse();
  return { ...option, userId };
};

const tokenFrom = (value: unknown): AuthSession | null => {
  const record = objectOf(value);
  const token = stringField(record, "token", "access_token", "accessToken");
  if (token === undefined) return null;
  const expiresAt = record["expiresAt"];
  if (
    expiresAt !== undefined &&
    !(
      typeof expiresAt === "number" &&
      Number.isFinite(expiresAt) &&
      expiresAt > 0
    )
  )
    return invalidResponse();
  return {
    kind: "bearer",
    token,
    ...(expiresAt === undefined ? {} : { expiresAt: expiresAt as number }),
  };
};

const accountsFrom = (value: unknown): AccountOption[] => {
  const source = Array.isArray(value) ? value : objectOf(value)["accounts"];
  if (!Array.isArray(source)) return invalidResponse();
  const accounts = source.map(accountOptionFrom);
  if (
    new Set(accounts.map((account) => account.accountId)).size !==
    accounts.length
  )
    return invalidResponse();
  return accounts;
};

const resultFrom = (
  data: unknown,
  session: AuthSession | null,
): LoginResult => {
  const record = objectOf(data);
  const onboarding = [
    "needsOnboarding",
    "onboardingRequired",
    "requiresOnboarding",
  ];
  const selection = ["accountSelectionRequired", "requiresAccountSelection"];
  for (const key of [...onboarding, ...selection]) {
    if (record[key] !== undefined && typeof record[key] !== "boolean")
      return invalidResponse();
  }
  const needsOnboarding = onboarding.some((key) => record[key] === true);
  const tempToken = stringField(record, "tempToken", "temp_token");
  const needsSelection =
    tempToken !== undefined || selection.some((key) => record[key] === true);
  if (needsOnboarding && needsSelection) return invalidResponse();
  if (needsSelection) {
    if (tempToken === undefined || session !== null) return invalidResponse();
    const accounts = accountsFrom(data);
    if (accounts.length === 0) return invalidResponse();
    return { kind: "account-selection-required", accounts };
  }
  if (needsOnboarding) {
    if (session === null) return invalidResponse();
    const userId =
      identifierField(record, "userId", "uid", "user_id") ?? invalidResponse();
    return { kind: "onboarding-required", user: { userId } };
  }
  if (session === null) return invalidResponse();
  return {
    kind: "authenticated",
    account: accountFrom(record["account"] ?? record["user"] ?? data),
  };
};

export const createTfRobotAuthTransport = (
  options: TfRobotAuthTransportOptions,
): AuthTransport => {
  const parsedBaseUrl = new URL(options.baseUrl);
  if (
    (parsedBaseUrl.protocol !== "http:" &&
      parsedBaseUrl.protocol !== "https:") ||
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
    const failure = (status: number): never => {
      const code =
        status === 401
          ? "authentication_required"
          : status === 403
            ? "authorization_denied"
            : status === 404
              ? "unsupported"
              : "unknown";
      throw new TfRobotAuthError(
        code,
        status === 401
          ? "Authentication is required"
          : status === 403
            ? "Authentication is not authorized"
            : status === 404
              ? "TFRobot authentication endpoint is unavailable"
              : "TFRobot authentication request failed",
        status,
      );
    };
    if (response.status < 200 || response.status >= 300)
      return failure(response.status);
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      return invalidResponse();
    }
    const envelope = objectOf(payload);
    if ("code" in envelope && envelope["code"] !== 200) {
      if (
        typeof envelope["code"] !== "number" ||
        !Number.isInteger(envelope["code"]) ||
        envelope["code"] < 400 ||
        envelope["code"] > 599
      )
        return invalidResponse();
      return failure(envelope["code"]);
    }
    return dataFrom(payload);
  };

  let currentSession: AuthSession | null = null;
  let pendingTempToken: string | undefined;
  let generation = 0;
  const clearSession = () => {
    ++generation;
    currentSession = null;
    pendingTempToken = undefined;
  };
  const authHeaders = () =>
    currentSession === null
      ? {}
      : { Authorization: `Bearer ${currentSession.token}` };
  const json = (body: unknown) => ({
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(body),
  });

  const verifyAccount = async (
    account: AccountContext,
    session: AuthSession,
  ): Promise<AccountContext> => {
    const verified = accountFrom(
      await request("/api/v1/auth/me", {
        headers: { Authorization: `Bearer ${session.token}` },
      }),
    );
    if (
      verified.userId !== account.userId ||
      verified.accountId !== account.accountId ||
      (account.organizationId !== undefined &&
        verified.organizationId !== account.organizationId)
    )
      return invalidResponse();
    return verified;
  };

  const complete = async (
    data: unknown,
    requestGeneration: number,
    selectedId?: string,
  ): Promise<LoginResult> => {
    const session = tokenFrom(data);
    let result = resultFrom(data, session);
    if (selectedId !== undefined) {
      if (
        result.kind !== "authenticated" ||
        result.account.accountId !== selectedId
      )
        return invalidResponse();
      if (requestGeneration === generation) {
        result = {
          kind: "authenticated",
          account: await verifyAccount(result.account, session!),
        };
      }
    }
    if (requestGeneration === generation) {
      // Parse and verify first; only a complete, current result owns credentials.
      currentSession = result.kind === "authenticated" ? session : null;
      pendingTempToken =
        result.kind === "account-selection-required"
          ? stringField(objectOf(data), "tempToken", "temp_token")
          : undefined;
    }
    return result;
  };

  return {
    async login(input: LoginInput) {
      const requestGeneration = ++generation;
      currentSession = null;
      pendingTempToken = undefined;
      const identifier = input.identifier.trim();
      const credentials = identifier.includes("@")
        ? { email: identifier, password: input.password }
        : { phone: identifier, password: input.password };
      return complete(
        await request("/auth/login-by-password", json(credentials)),
        requestGeneration,
      );
    },
    async selectAccount(accountId: string) {
      const requestGeneration = ++generation;
      const body =
        pendingTempToken === undefined
          ? { accountId }
          : { tempToken: pendingTempToken, accountId };
      return complete(
        await request("/auth/select-account", json(body)),
        requestGeneration,
        accountId,
      );
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
      const requestGeneration = ++generation;
      const data = await request(
        "/api/v1/auth/switch-account",
        json({ accountId }),
      );
      const record = objectOf(data);
      const result = await complete(
        {
          ...record,
          account:
            record["identity"] ?? record["account"] ?? record["user"] ?? data,
        },
        requestGeneration,
        accountId,
      );
      if (result.kind !== "authenticated") return invalidResponse();
      return result.account;
    },
    async getSession() {
      return currentSession;
    },
    restoreSession(session: AuthSession) {
      ++generation;
      currentSession = session;
      pendingTempToken = undefined;
    },
    invalidatePending() {
      ++generation;
    },
    clearSession,
    async logout() {
      clearSession();
    },
  };
};
