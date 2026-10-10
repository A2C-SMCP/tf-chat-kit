/** A deployment selected by the host; it cannot be changed by auth UI. */
export type AuthEnvironment = "staging" | "production";

export type AuthStatus =
  | "signed_out"
  | "authenticating"
  | "account_selection_required"
  | "onboarding_required"
  | "authenticated"
  | "refreshing"
  | "switching"
  | "auth_required"
  | "disposed"
  | "error";

/** An account choice need not identify an authenticated user. */
export interface AccountOption {
  readonly userId?: string;
  readonly accountId: string;
  readonly organizationId?: string;
  readonly displayName?: string;
}

export interface AuthUserContext {
  readonly userId: string;
}

export interface AccountContext extends AccountOption, AuthUserContext {
  readonly userId: string;
}

export interface AuthSnapshot {
  readonly environment: AuthEnvironment;
  readonly status: AuthStatus;
  readonly account?: AccountContext | undefined;
  readonly user?: AuthUserContext | undefined;
  readonly accounts: readonly AccountOption[];
  readonly error?: AuthError | undefined;
}

export type AuthErrorCode =
  | "invalid_credentials"
  | "authentication_required"
  | "authorization_denied"
  | "invalid_response"
  | "network"
  | "unsupported"
  | "disposed"
  | "unknown"
  | "cancelled";

export interface AuthError {
  readonly code: AuthErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly status?: number;
}

export interface LoginInput {
  readonly identifier: string;
  /** Transient password material; implementations must never persist or log it. */
  readonly password: string;
}

export type LoginResult =
  | { readonly kind: "authenticated"; readonly account: AccountContext }
  | {
      readonly kind: "account-selection-required";
      readonly accounts: readonly AccountOption[];
    }
  | {
      readonly kind: "onboarding-required";
      readonly user: AuthUserContext;
      readonly account?: AccountContext;
    }
  | {
      readonly kind: "onboarding-required";
      readonly account: AccountContext;
      readonly user?: AuthUserContext;
    };

export interface AuthSession {
  readonly kind: "bearer";
  readonly token: string;
  /** Unix epoch milliseconds supplied by the transport; absent means unknown TTL. */
  readonly expiresAt?: number;
}

export interface AuthTransport {
  login(input: LoginInput): Promise<LoginResult>;
  selectAccount(accountId: string): Promise<LoginResult>;
  getCurrentAccount(): Promise<AccountContext>;
  listAccounts(): Promise<readonly AccountOption[]>;
  switchAccount(accountId: string): Promise<AccountContext>;
  getSession(): Promise<AuthSession | null>;
  restoreSession?(session: AuthSession): void;
  /** Fence pending credential mutations while retaining the current session. */
  invalidatePending?(): void;
  clearSession?(): void;
  logout(): Promise<void>;
  refresh?(): Promise<AuthSession>;
}

export interface CredentialRecord {
  readonly version: 1;
  readonly environment: AuthEnvironment;
  readonly userId: string;
  readonly accountId: string;
  readonly organizationId?: string;
  readonly session: AuthSession;
}

export interface CredentialScope {
  readonly environment: AuthEnvironment;
  readonly userId: string;
  readonly accountId: string;
  readonly organizationId?: string;
}

export interface CredentialStore {
  read(scope: CredentialScope): Promise<CredentialRecord | null>;
  write(scope: CredentialScope, record: CredentialRecord): Promise<void>;
  clear(scope: CredentialScope): Promise<void>;
}

export interface SessionProvider {
  getSession(input?: {
    readonly signal?: { readonly aborted: boolean };
    readonly purpose?: "connect" | "reconnect" | "request";
    readonly operation?: "read" | "send" | "subscribe" | "remote-tool";
    readonly conversationId?: string | undefined;
  }): Promise<AuthSession>;
  onSessionInvalid(invalidation: {
    readonly reason: "expired" | "forbidden" | "rejected" | "unknown";
    readonly error: unknown;
  }): Promise<void>;
  withAuthRetry<T>(operation: (session: AuthSession) => Promise<T>): Promise<T>;
  invalidate?(reason?: "expired" | "revoked" | "logout"): void;
}

export interface AuthClient {
  readonly environment: AuthEnvironment;
  getSnapshot(): AuthSnapshot;
  subscribe(listener: (snapshot: AuthSnapshot) => void): () => void;
  login(input: LoginInput): Promise<LoginResult>;
  selectAccount(accountId: string): Promise<LoginResult>;
  listAccounts(): Promise<readonly AccountOption[]>;
  restore(): Promise<void>;
  switchAccount(accountId: string): Promise<AccountContext>;
  logout(): Promise<void>;
  createSessionProvider(): SessionProvider;
  refresh(): Promise<AuthSession>;
  dispose(): Promise<void>;
}

export interface CreateAuthClientOptions {
  readonly environment: AuthEnvironment;
  readonly transport: AuthTransport;
  readonly credentialStore?: CredentialStore;
  readonly credentialScope?: CredentialScope;
  readonly now?: () => number;
  /** Refresh on demand when expiry is this close; defaults to 30 seconds. */
  readonly refreshSkewMs?: number;
}

class AuthClientError extends Error {
  readonly authError: AuthError;

  constructor(authError: AuthError) {
    super(authError.message);
    this.name = "AuthClientError";
    this.authError = authError;
  }
}

const errorFromUnknown = (error: unknown): AuthError => {
  if (error instanceof AuthClientError) return error.authError;
  const messages: Readonly<Record<AuthErrorCode, string>> = {
    invalid_credentials: "Credentials were rejected",
    authentication_required: "Authentication is required",
    authorization_denied: "Authentication is not authorized",
    invalid_response: "Authentication response is invalid",
    network: "Authentication request failed",
    unsupported: "Authentication operation is unavailable",
    disposed: "AuthClient has been disposed",
    unknown: "Authentication operation failed",
    cancelled: "Authentication operation was superseded",
  };
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    Object.hasOwn(messages, error.code)
  ) {
    const code = error.code as AuthErrorCode;
    const status =
      "status" in error &&
      typeof error.status === "number" &&
      Number.isInteger(error.status) &&
      error.status >= 100 &&
      error.status <= 599
        ? error.status
        : undefined;
    return {
      code,
      message: messages[code],
      retryable: code === "network" || code === "unknown",
      ...(status === undefined ? {} : { status }),
    };
  }
  return {
    code: "unknown",
    message: "Authentication operation failed",
    retryable: true,
  };
};

const operationError = (
  code: AuthErrorCode,
  message: string,
  retryable = false,
): AuthClientError => new AuthClientError({ code, message, retryable });

const sessionFromUnknown = (value: unknown): AuthSession => {
  if (value === null || value === undefined)
    throw operationError(
      "authentication_required",
      "Authentication is required",
    );
  if (
    typeof value !== "object" ||
    Array.isArray(value) ||
    !("kind" in value) ||
    value.kind !== "bearer" ||
    !("token" in value) ||
    typeof value.token !== "string" ||
    value.token.trim().length === 0
  ) {
    throw operationError(
      "invalid_response",
      "Authentication session is invalid",
    );
  }
  const expiresAt = "expiresAt" in value ? value.expiresAt : undefined;
  if (
    expiresAt !== undefined &&
    !(
      typeof expiresAt === "number" &&
      Number.isFinite(expiresAt) &&
      expiresAt > 0
    )
  ) {
    throw operationError(
      "invalid_response",
      "Authentication session is invalid",
    );
  }
  return {
    kind: "bearer",
    token: value.token,
    ...(expiresAt === undefined ? {} : { expiresAt: expiresAt as number }),
  };
};

class AuthClientImpl implements AuthClient {
  readonly environment: AuthEnvironment;
  readonly #transport: AuthTransport;
  readonly #store: CredentialStore | undefined;
  readonly #scope: CredentialScope | undefined;
  readonly #now: () => number;
  readonly #refreshSkewMs: number;
  readonly #listeners = new Set<(snapshot: AuthSnapshot) => void>();
  #generation = 0;
  #refreshPromise: Promise<AuthSession> | undefined;
  #session: AuthSession | undefined;
  #storageTail: Promise<void> = Promise.resolve();
  #disposed = false;
  #snapshot: AuthSnapshot;

  constructor(options: CreateAuthClientOptions) {
    this.environment = options.environment;
    this.#transport = options.transport;
    this.#store = options.credentialStore;
    const scope = options.credentialScope;
    this.#scope =
      scope === undefined
        ? undefined
        : Object.freeze({
            environment: scope.environment,
            userId: scope.userId,
            accountId: scope.accountId,
            ...(scope.organizationId === undefined
              ? {}
              : { organizationId: scope.organizationId }),
          });
    this.#now = options.now ?? Date.now;
    this.#refreshSkewMs = options.refreshSkewMs ?? 30_000;
    if (!Number.isFinite(this.#refreshSkewMs) || this.#refreshSkewMs < 0)
      throw new TypeError("Refresh skew must be a finite nonnegative duration");
    if (
      this.#scope !== undefined &&
      this.#scope.environment !== this.environment
    )
      throw new TypeError(
        "Credential scope environment must match the AuthClient environment",
      );
    this.#snapshot = {
      environment: this.environment,
      status: "signed_out",
      accounts: [],
    };
  }

  getSnapshot(): AuthSnapshot {
    return this.#snapshot;
  }

  subscribe(listener: (snapshot: AuthSnapshot) => void): () => void {
    if (this.#disposed) return () => undefined;
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async login(input: LoginInput): Promise<LoginResult> {
    this.assertUsable();
    this.#transport.clearSession?.();
    const generation = this.begin("authenticating");
    try {
      this.assertCurrent(generation);
      const result = await this.#transport.login(input);
      await this.applyLoginResult(result, generation);
      return result;
    } catch (error) {
      if (this.isCurrent(generation)) this.fail(error);
      throw new AuthClientError(errorFromUnknown(error));
    }
  }

  async selectAccount(accountId: string): Promise<LoginResult> {
    this.assertUsable();
    const generation = this.begin("authenticating");
    try {
      this.assertCurrent(generation);
      const result = await this.#transport.selectAccount(accountId);
      await this.applyLoginResult(result, generation);
      return result;
    } catch (error) {
      if (this.isCurrent(generation)) this.fail(error);
      throw new AuthClientError(errorFromUnknown(error));
    }
  }

  async restore(): Promise<void> {
    this.assertUsable();
    const generation = this.begin("authenticating", {
      preserveStoredCredential: true,
    });
    try {
      this.assertCurrent(generation);
      let session: AuthSession | undefined;
      if (this.#store !== undefined && this.#scope !== undefined) {
        const record = await this.storage(() =>
          this.#store!.read(this.#scope!),
        );
        if (!this.isCurrent(generation)) return;
        if (record === null || !this.matchesScope(record)) {
          if (record !== null) await this.clearStoredCredential();
          if (!this.isCurrent(generation)) return;
          this.#transport.clearSession?.();
          this.update({
            status: "signed_out",
            account: undefined,
            user: undefined,
            accounts: [],
            error: undefined,
          });
          return;
        }
        session = sessionFromUnknown(record.session);
        if (this.#transport.restoreSession === undefined)
          throw operationError(
            "unsupported",
            "Credential restoration is unavailable",
          );
        this.#transport.restoreSession({ ...session });
        this.assertCurrent(generation);
      }
      let account: AccountContext;
      if (session !== undefined && this.needsRefresh(session)) {
        const renewed = await this.renewSession(generation, this.#scope);
        session = renewed.session;
        account = renewed.account;
      } else {
        account = await this.#transport.getCurrentAccount();
        if (!this.isCurrent(generation)) return;
        if (
          this.#scope !== undefined &&
          !this.accountMatches(account, this.#scope, true)
        )
          throw operationError(
            "invalid_response",
            "Restored authentication identity does not match its scope",
          );
        if (session === undefined) {
          session = sessionFromUnknown(await this.#transport.getSession());
          if (!this.isCurrent(generation)) return;
          if (this.needsRefresh(session)) {
            const renewed = await this.renewSession(generation, account);
            session = renewed.session;
            account = renewed.account;
          }
        }
      }
      if (
        this.#scope !== undefined &&
        !this.accountMatches(account, this.#scope, true)
      )
        throw operationError(
          "invalid_response",
          "Restored authentication identity does not match its scope",
        );
      await this.applyLoginResult(
        { kind: "authenticated", account },
        generation,
        session,
      );
    } catch (error) {
      if (!this.isCurrent(generation)) return;
      await this.revoke("auth_required", errorFromUnknown(error)).clear.catch(
        () => undefined,
      );
    }
  }

  async switchAccount(accountId: string): Promise<AccountContext> {
    this.assertUsable();
    const generation = this.begin("switching");
    try {
      this.assertCurrent(generation);
      const account = await this.#transport.switchAccount(accountId);
      await this.applyLoginResult(
        { kind: "authenticated", account },
        generation,
      );
      return account;
    } catch (error) {
      if (this.isCurrent(generation)) this.fail(error);
      throw new AuthClientError(errorFromUnknown(error));
    }
  }

  async listAccounts(): Promise<readonly AccountOption[]> {
    this.assertUsable();
    const generation = this.#generation;
    try {
      const accounts = await this.#transport.listAccounts();
      if (this.isCurrent(generation)) this.update({ accounts });
      return accounts;
    } catch (error) {
      const authError = errorFromUnknown(error);
      if (this.isCurrent(generation)) this.update({ error: authError });
      throw new AuthClientError(authError);
    }
  }

  async logout(): Promise<void> {
    this.assertUsable();
    let transportLogout: Promise<void>;
    try {
      transportLogout = this.#transport.logout();
    } catch (error) {
      transportLogout = Promise.reject(error);
    }
    const { generation, clear } = this.revoke("signed_out");
    try {
      await Promise.all([transportLogout, clear]);
    } catch (error) {
      if (this.isCurrent(generation)) this.fail(error);
      throw new AuthClientError(errorFromUnknown(error));
    }
  }

  async refresh(): Promise<AuthSession> {
    this.assertUsable();
    if (this.#refreshPromise !== undefined) return this.#refreshPromise;
    if (
      this.#session === undefined ||
      this.#snapshot.status !== "authenticated"
    ) {
      throw operationError(
        "authentication_required",
        "Authentication is required",
      );
    }
    const generation = this.#generation;
    const account = this.#snapshot.account;
    const promise = Promise.resolve()
      .then(() => {
        this.assertCurrent(generation);
        return this.renewSession(generation, account);
      })
      .then(async ({ session, account: verifiedAccount }) => {
        this.assertCurrent(generation);
        this.#session = { ...session };
        await this.persist(verifiedAccount, generation);
        this.assertCurrent(generation);
        if (this.needsRefresh(session))
          throw operationError(
            "authentication_required",
            "Refreshed session is already expiring",
          );
        this.update({
          status: "authenticated",
          account: verifiedAccount,
          user: { userId: verifiedAccount.userId },
          accounts: this.#snapshot.accounts.map((option) =>
            option.accountId === verifiedAccount.accountId
              ? verifiedAccount
              : option,
          ),
          error: undefined,
        });
        this.assertCurrent(generation);
        return { ...session };
      })
      .catch(async (error: unknown) => {
        if (this.isCurrent(generation)) {
          await this.revoke(
            "auth_required",
            errorFromUnknown(error),
          ).clear.catch(() => undefined);
        }
        throw new AuthClientError(errorFromUnknown(error));
      })
      .finally(() => {
        if (this.#refreshPromise === promise) this.#refreshPromise = undefined;
      });
    this.#refreshPromise = promise;
    this.update({ status: "refreshing", error: undefined });
    return promise;
  }

  createSessionProvider(): SessionProvider {
    return {
      getSession: async (input) => {
        this.assertUsable();
        if (input?.signal?.aborted)
          throw operationError("cancelled", "Session request was cancelled");
        const generation = this.#generation;
        if (this.#refreshPromise !== undefined) await this.#refreshPromise;
        if (
          this.#session !== undefined &&
          this.#snapshot.status === "authenticated" &&
          this.needsRefresh(this.#session)
        )
          await this.refresh();
        this.assertUsable();
        this.assertCurrent(generation);
        if (input?.signal?.aborted)
          throw operationError("cancelled", "Session request was cancelled");
        if (
          this.#session === undefined ||
          this.#snapshot.status !== "authenticated"
        ) {
          if (this.#snapshot.status === "signed_out")
            this.update({ status: "auth_required" });
          throw operationError(
            "authentication_required",
            "Authentication is required",
          );
        }
        return { ...this.#session };
      },
      onSessionInvalid: async ({ reason }) => {
        if (this.#disposed) return;
        if (reason === "forbidden") {
          this.update({
            error: {
              code: "authorization_denied",
              message: "Authentication is not authorized",
              retryable: false,
              status: 403,
            },
          });
          return;
        }
        try {
          await this.refresh();
        } catch {
          // Refresh handles revocation. Gateway reports the original request
          // error and owns the one permitted operation retry.
        }
      },
      withAuthRetry: async <T>(
        operation: (session: AuthSession) => Promise<T>,
      ) => {
        const generation = this.#generation;
        const first = await this.createSessionProvider().getSession();
        this.assertCurrent(generation);
        try {
          const result = await operation(first);
          this.assertCurrent(generation);
          return result;
        } catch (error) {
          if (!isUnauthorized(error)) throw error;
          this.assertCurrent(generation);
          const refreshed = await this.refresh();
          this.assertCurrent(generation);
          try {
            const result = await operation(refreshed);
            this.assertCurrent(generation);
            return result;
          } catch (retryError) {
            if (this.isCurrent(generation) && isUnauthorized(retryError)) {
              await this.revoke("auth_required", {
                code: "authentication_required",
                message: "Authentication is required",
                retryable: false,
              }).clear.catch(() => undefined);
            }
            if (isUnauthorized(retryError))
              throw operationError(
                "authentication_required",
                "Authentication is required",
              );
            throw retryError;
          }
        }
      },
      invalidate: (reason = "expired") => {
        if (this.#disposed) return;
        void this.revoke("auth_required", {
          code: "authentication_required",
          message: `Authentication ${reason}`,
          retryable: false,
        }).clear.catch(() => undefined);
      },
    };
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    ++this.#generation;
    this.#session = undefined;
    this.#refreshPromise = undefined;
    this.#transport.clearSession?.();
    this.#listeners.clear();
    this.#snapshot = {
      environment: this.environment,
      status: "disposed",
      accounts: [],
    };
    try {
      await this.clearStoredCredential();
    } catch {
      // Storage failure cannot restore a usable disposed instance.
    }
  }

  private assertUsable(): void {
    if (this.#disposed)
      throw operationError("disposed", "AuthClient has been disposed");
  }

  private isCurrent(generation: number): boolean {
    return !this.#disposed && generation === this.#generation;
  }

  private assertCurrent(generation: number): void {
    if (!this.isCurrent(generation))
      throw operationError(
        "cancelled",
        "Authentication operation was superseded",
      );
  }

  private begin(
    status: "authenticating" | "switching",
    options: { readonly preserveStoredCredential?: boolean } = {},
  ): number {
    const generation = ++this.#generation;
    this.#transport.invalidatePending?.();
    this.#session = undefined;
    this.#refreshPromise = undefined;
    if (!options.preserveStoredCredential)
      void this.clearStoredCredential().catch(() => undefined);
    this.update({ status, error: undefined });
    return generation;
  }

  private revoke(
    status: "signed_out" | "auth_required" | "error",
    error?: AuthError,
  ): { readonly generation: number; readonly clear: Promise<void> } {
    const generation = ++this.#generation;
    this.#session = undefined;
    this.#refreshPromise = undefined;
    this.#transport.clearSession?.();
    const clear = this.clearStoredCredential();
    this.update({
      status,
      account: undefined,
      user: undefined,
      accounts: [],
      error,
    });
    return { generation, clear };
  }

  private storage<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.#storageTail.then(operation);
    this.#storageTail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private clearStoredCredential(): Promise<void> {
    if (this.#store === undefined || this.#scope === undefined)
      return Promise.resolve();
    return this.storage(() => this.#store!.clear(this.#scope!));
  }

  private update(patch: {
    readonly status?: AuthStatus;
    readonly account?: AccountContext | undefined;
    readonly user?: AuthUserContext | undefined;
    readonly accounts?: readonly AccountOption[];
    readonly error?: AuthError | undefined;
  }): void {
    if (this.#disposed) return;
    this.#snapshot = {
      ...this.#snapshot,
      ...patch,
      environment: this.environment,
    };
    for (const listener of this.#listeners) listener(this.#snapshot);
  }

  private fail(error: unknown): void {
    void this.revoke("error", errorFromUnknown(error)).clear.catch(
      () => undefined,
    );
  }

  private async applyLoginResult(
    result: LoginResult,
    generation: number,
    verifiedSession?: AuthSession,
  ): Promise<void> {
    if (!this.isCurrent(generation)) return;
    if (result.kind === "account-selection-required") {
      this.update({
        status: "account_selection_required",
        accounts: result.accounts,
        account: undefined,
        user: undefined,
        error: undefined,
      });
      return;
    }
    if (result.kind === "onboarding-required") {
      this.update({
        status: "onboarding_required",
        account: result.account,
        user: result.user ?? { userId: result.account!.userId },
        accounts: result.account === undefined ? [] : [result.account],
        error: undefined,
      });
      return;
    }
    const value = verifiedSession ?? (await this.#transport.getSession());
    if (!this.isCurrent(generation)) return;
    const session = sessionFromUnknown(value);
    this.#session = { ...session };
    await this.persist(result.account, generation);
    if (!this.isCurrent(generation)) return;
    if (verifiedSession !== undefined && this.needsRefresh(session))
      throw operationError(
        "authentication_required",
        "Restored session expired during verification",
      );
    this.update({
      status: "authenticated",
      account: result.account,
      user: { userId: result.account.userId },
      accounts: [result.account],
      error: undefined,
    });
  }

  private async persist(
    account: AccountContext,
    generation: number,
  ): Promise<void> {
    if (this.#store === undefined || this.#scope === undefined) return;
    if (!this.isCurrent(generation)) return;
    if (
      this.#scope.userId !== account.userId ||
      this.#scope.accountId !== account.accountId ||
      this.#scope.organizationId !== account.organizationId
    ) {
      await this.storage(async () => {
        if (this.isCurrent(generation)) await this.#store!.clear(this.#scope!);
      });
      return;
    }
    const session = this.#session;
    if (session === undefined || !this.isCurrent(generation)) return;
    await this.storage(async () => {
      if (!this.isCurrent(generation)) return;
      await this.#store!.write(this.#scope!, {
        version: 1,
        environment: this.environment,
        userId: account.userId,
        accountId: account.accountId,
        ...(account.organizationId === undefined
          ? {}
          : { organizationId: account.organizationId }),
        session: { ...session },
      });
    });
  }

  private matchesScope(record: CredentialRecord): boolean {
    return (
      record !== null &&
      typeof record === "object" &&
      !Array.isArray(record) &&
      record.version === 1 &&
      record.environment === this.environment &&
      this.#scope !== undefined &&
      record.userId === this.#scope.userId &&
      record.accountId === this.#scope.accountId &&
      record.organizationId === this.#scope.organizationId
    );
  }

  private needsRefresh(session: AuthSession): boolean {
    const now = this.#now();
    if (!Number.isFinite(now) || now < 0)
      throw operationError(
        "invalid_response",
        "Authentication clock is invalid",
      );
    return (
      session.expiresAt !== undefined &&
      session.expiresAt <= now + this.#refreshSkewMs
    );
  }

  private accountMatches(
    account: AccountContext,
    expected: Pick<CredentialScope, "userId" | "accountId" | "organizationId">,
    exactOrganization = false,
  ): boolean {
    return (
      account.userId === expected.userId &&
      account.accountId === expected.accountId &&
      ((!exactOrganization && expected.organizationId === undefined) ||
        account.organizationId === expected.organizationId)
    );
  }

  private async renewSession(
    generation: number,
    expected?: Pick<CredentialScope, "userId" | "accountId" | "organizationId">,
  ): Promise<{ session: AuthSession; account: AccountContext }> {
    this.assertCurrent(generation);
    if (this.#transport.refresh === undefined)
      throw operationError(
        "authentication_required",
        "Token refresh is unavailable",
      );
    if (this.#transport.restoreSession === undefined)
      throw operationError(
        "unsupported",
        "Credential restoration is unavailable",
      );
    const value = await this.#transport.refresh();
    this.assertCurrent(generation);
    const session = sessionFromUnknown(value);
    if (this.needsRefresh(session))
      throw operationError(
        "authentication_required",
        "Refreshed session is already expiring",
      );
    this.#transport.restoreSession({ ...session });
    this.assertCurrent(generation);
    const account = await this.#transport.getCurrentAccount();
    this.assertCurrent(generation);
    if (expected !== undefined && !this.accountMatches(account, expected))
      throw operationError(
        "invalid_response",
        "Refreshed authentication identity changed",
      );
    if (this.needsRefresh(session))
      throw operationError(
        "authentication_required",
        "Refreshed session is already expiring",
      );
    return { session, account };
  }
}

const isUnauthorized = (error: unknown): boolean =>
  (error instanceof Error && "status" in error && error.status === 401) ||
  (error instanceof AuthClientError &&
    error.authError.code === "authentication_required");

export const createAuthClient = (
  options: CreateAuthClientOptions,
): AuthClient => new AuthClientImpl(options);
