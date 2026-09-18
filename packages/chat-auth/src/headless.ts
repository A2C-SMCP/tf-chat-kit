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

export interface AccountContext {
  readonly userId: string;
  readonly accountId: string;
  readonly organizationId?: string;
  readonly displayName?: string;
}

export interface AuthSnapshot {
  readonly environment: AuthEnvironment;
  readonly status: AuthStatus;
  readonly account?: AccountContext | undefined;
  readonly accounts: readonly AccountContext[];
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
  | "unknown";

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
      readonly accounts: readonly AccountContext[];
    }
  | { readonly kind: "onboarding-required"; readonly account: AccountContext };

export interface AuthSession {
  readonly kind: "bearer";
  readonly token: string;
  readonly expiresAt?: number;
}

export interface AuthTransport {
  login(input: LoginInput): Promise<LoginResult>;
  selectAccount(accountId: string): Promise<LoginResult>;
  getCurrentAccount(): Promise<AccountContext>;
  listAccounts(): Promise<readonly AccountContext[]>;
  switchAccount(accountId: string): Promise<AccountContext>;
  getSession(): Promise<AuthSession | null>;
  restoreSession?(session: AuthSession): void;
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
  }): Promise<AuthSession>;
  withAuthRetry<T>(operation: (session: AuthSession) => Promise<T>): Promise<T>;
  invalidate?(reason?: "expired" | "revoked" | "logout"): void;
}

export interface AuthClient {
  readonly environment: AuthEnvironment;
  getSnapshot(): AuthSnapshot;
  subscribe(listener: (snapshot: AuthSnapshot) => void): () => void;
  login(input: LoginInput): Promise<LoginResult>;
  selectAccount(accountId: string): Promise<LoginResult>;
  listAccounts(): Promise<readonly AccountContext[]>;
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
  if (error instanceof Error) {
    return {
      code: "unknown",
      message: "Authentication operation failed",
      retryable: true,
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

class AuthClientImpl implements AuthClient {
  readonly environment: AuthEnvironment;
  readonly #transport: AuthTransport;
  readonly #store: CredentialStore | undefined;
  readonly #scope: CredentialScope | undefined;
  readonly #listeners = new Set<(snapshot: AuthSnapshot) => void>();
  #generation = 0;
  #refreshPromise: Promise<AuthSession> | undefined;
  #disposed = false;
  #snapshot: AuthSnapshot;

  constructor(options: CreateAuthClientOptions) {
    this.environment = options.environment;
    this.#transport = options.transport;
    this.#store = options.credentialStore;
    this.#scope = options.credentialScope;
    if (
      this.#scope !== undefined &&
      this.#scope.environment !== this.environment
    ) {
      throw new TypeError(
        "Credential scope environment must match the AuthClient environment",
      );
    }
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
    const generation = ++this.#generation;
    this.update({ status: "authenticating", error: undefined });
    try {
      const result = await this.#transport.login(input);
      if (!this.isCurrent(generation)) return result;
      await this.applyLoginResult(result, generation);
      return result;
    } catch (error) {
      if (!this.isCurrent(generation)) throw error;
      this.fail(error);
      throw error;
    }
  }

  async selectAccount(accountId: string): Promise<LoginResult> {
    this.assertUsable();
    const generation = ++this.#generation;
    this.update({ status: "authenticating", error: undefined });
    try {
      const result = await this.#transport.selectAccount(accountId);
      if (!this.isCurrent(generation)) return result;
      await this.applyLoginResult(result, generation);
      return result;
    } catch (error) {
      if (!this.isCurrent(generation)) throw error;
      this.fail(error);
      throw error;
    }
  }

  async restore(): Promise<void> {
    this.assertUsable();
    const generation = ++this.#generation;
    if (this.#store !== undefined && this.#scope !== undefined) {
      const record = await this.#store.read(this.#scope);
      if (!this.isCurrent(generation)) return;
      if (record === null || !this.matchesScope(record)) {
        if (record !== null) await this.#store.clear(this.#scope);
        this.update({
          status: "signed_out",
          account: undefined,
          accounts: [],
          error: undefined,
        });
        return;
      }
      this.#transport.restoreSession?.(record.session);
    }
    try {
      const account = await this.#transport.getCurrentAccount();
      if (!this.isCurrent(generation)) return;
      this.update({
        status: "authenticated",
        account,
        accounts: [account],
        error: undefined,
      });
    } catch (error) {
      if (!this.isCurrent(generation)) return;
      this.update({
        status: "auth_required",
        account: undefined,
        accounts: [],
        error: errorFromUnknown(error),
      });
    }
  }

  async switchAccount(accountId: string): Promise<AccountContext> {
    this.assertUsable();
    const generation = ++this.#generation;
    this.update({ status: "switching", error: undefined });
    try {
      const account = await this.#transport.switchAccount(accountId);
      if (!this.isCurrent(generation)) return account;
      this.update({
        status: "authenticated",
        account,
        accounts: [account],
        error: undefined,
      });
      await this.persist(account);
      return account;
    } catch (error) {
      if (this.isCurrent(generation)) this.fail(error);
      throw error;
    }
  }

  async listAccounts(): Promise<readonly AccountContext[]> {
    this.assertUsable();
    const accounts = await this.#transport.listAccounts();
    this.update({ accounts });
    return accounts;
  }

  async logout(): Promise<void> {
    this.assertUsable();
    const generation = ++this.#generation;
    try {
      await this.#transport.logout();
      this.#transport.clearSession?.();
      if (!this.isCurrent(generation)) return;
      if (this.#store !== undefined && this.#scope !== undefined)
        await this.#store.clear(this.#scope);
      this.update({
        status: "signed_out",
        account: undefined,
        accounts: [],
        error: undefined,
      });
    } catch (error) {
      if (this.isCurrent(generation)) this.fail(error);
      throw error;
    }
  }

  async refresh(): Promise<AuthSession> {
    this.assertUsable();
    if (this.#refreshPromise !== undefined) return this.#refreshPromise;
    const generation = ++this.#generation;
    this.update({ status: "refreshing", error: undefined });
    const refresh = this.#transport.refresh;
    if (refresh === undefined) {
      const error = operationError(
        "authentication_required",
        "Token refresh is unavailable",
      );
      this.#transport.clearSession?.();
      if (this.#store !== undefined && this.#scope !== undefined)
        void this.#store.clear(this.#scope).catch(() => undefined);
      this.update({ status: "auth_required", error: error.authError });
      return Promise.reject(error);
    }
    this.#refreshPromise = refresh()
      .then(async (session) => {
        if (!this.isCurrent(generation)) return session;
        this.#transport.restoreSession?.(session);
        const account = this.#snapshot.account;
        if (account !== undefined) await this.persist(account);
        this.update({ status: "authenticated", error: undefined });
        return session;
      })
      .catch(async (error: unknown) => {
        if (this.isCurrent(generation)) {
          if (this.#store !== undefined && this.#scope !== undefined)
            await this.#store.clear(this.#scope);
          this.#transport.clearSession?.();
          this.update({
            status: "auth_required",
            account: undefined,
            accounts: [],
            error: errorFromUnknown(error),
          });
        }
        throw error;
      })
      .finally(() => {
        this.#refreshPromise = undefined;
      });
    return this.#refreshPromise;
  }

  createSessionProvider(): SessionProvider {
    return {
      getSession: async () => {
        this.assertUsable();
        const session = await this.#transport.getSession();
        if (session === null) {
          this.update({
            status: "auth_required",
            error: {
              code: "authentication_required",
              message: "Authentication is required",
              retryable: false,
            },
          });
          throw operationError(
            "authentication_required",
            "Authentication is required",
          );
        }
        return session;
      },
      withAuthRetry: async <T>(operation: (session: AuthSession) => Promise<T>) => {
        const first = await this.createSessionProvider().getSession();
        try {
          return await operation(first);
        } catch (error) {
          const status = error instanceof Error && "status" in error
            ? (error as { status?: unknown }).status
            : undefined;
          const authRequired = error instanceof AuthClientError &&
            error.authError.code === "authentication_required";
          if (status !== 401 && !authRequired) throw error;
          const refreshed = await this.refresh();
          try {
            return await operation(refreshed);
          } catch (retryError) {
            const retryStatus = retryError instanceof Error && "status" in retryError
              ? (retryError as { status?: unknown }).status
              : undefined;
            if (
              retryStatus === 401 ||
              (retryError instanceof AuthClientError &&
                retryError.authError.code === "authentication_required")
            ) {
              this.#transport.clearSession?.();
              if (this.#store !== undefined && this.#scope !== undefined)
                void this.#store.clear(this.#scope).catch(() => undefined);
              this.update({
                status: "auth_required",
                account: undefined,
                accounts: [],
                error: {
                  code: "authentication_required",
                  message: "Authentication is required",
                  retryable: false,
                },
              });
            }
            throw retryError;
          }
        }
      },
      invalidate: (reason = "expired") => {
        if (!this.#disposed) {
          this.#transport.clearSession?.();
          if (this.#store !== undefined && this.#scope !== undefined)
            void this.#store.clear(this.#scope).catch(() => undefined);
          this.update({
            status: "auth_required",
            error: {
              code: "authentication_required",
              message: `Authentication ${reason}`,
              retryable: false,
            },
          });
        }
      },
    };
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    ++this.#generation;
    this.#transport.clearSession?.();
    if (this.#store !== undefined && this.#scope !== undefined) {
      try {
        await this.#store.clear(this.#scope);
      } catch {
        // Disposal must not resurrect a usable client or leak the session.
      }
    }
    this.#listeners.clear();
    this.#snapshot = {
      environment: this.environment,
      status: "disposed",
      accounts: [],
    };
    await Promise.resolve();
  }

  private assertUsable(): void {
    if (this.#disposed)
      throw operationError("disposed", "AuthClient has been disposed");
  }

  private isCurrent(generation: number): boolean {
    return !this.#disposed && generation === this.#generation;
  }

  private update(patch: {
    readonly status?: AuthStatus;
    readonly account?: AccountContext | undefined;
    readonly accounts?: readonly AccountContext[];
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
    this.update({ status: "error", error: errorFromUnknown(error) });
  }

  private async applyLoginResult(
    result: LoginResult,
    generation: number,
  ): Promise<void> {
    if (!this.isCurrent(generation)) return;
    if (result.kind === "account-selection-required") {
      this.update({
        status: "account_selection_required",
        accounts: result.accounts,
        account: undefined,
        error: undefined,
      });
      return;
    }
    if (result.kind === "onboarding-required") {
      this.update({
        status: "onboarding_required",
        account: result.account,
        accounts: [result.account],
        error: undefined,
      });
      return;
    }
    this.update({
      status: "authenticated",
      account: result.account,
      accounts: [result.account],
      error: undefined,
    });
    await this.persist(result.account);
  }

  private async persist(account: AccountContext): Promise<void> {
    if (this.#store === undefined || this.#scope === undefined) return;
    if (
      this.#scope.userId !== account.userId ||
      this.#scope.accountId !== account.accountId ||
      this.#scope.organizationId !== account.organizationId
    )
      return;
    const session = await this.#transport.getSession();
    if (session === null) return;
    await this.#store.write(this.#scope, {
      version: 1,
      environment: this.environment,
      userId: account.userId,
      accountId: account.accountId,
      ...(account.organizationId === undefined
        ? {}
        : { organizationId: account.organizationId }),
      session,
    });
  }

  private matchesScope(record: CredentialRecord): boolean {
    return (
      record.version === 1 &&
      record.environment === this.environment &&
      this.#scope !== undefined &&
      record.userId === this.#scope.userId &&
      record.accountId === this.#scope.accountId &&
      record.organizationId === this.#scope.organizationId
    );
  }
}

export const createAuthClient = (
  options: CreateAuthClientOptions,
): AuthClient => new AuthClientImpl(options);
