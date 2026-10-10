import {
  createAuthClient,
  type AccountContext,
  type AuthEnvironment,
  type AuthSession,
  type AuthTransport,
  type CredentialRecord,
  type CredentialScope,
  type CredentialStore,
} from "@turingfocus/chat-auth/headless";
import { createTfRobotAuthTransport } from "@turingfocus/chat-auth/tfrobot";

const check = (condition: unknown, message: string): void => {
  if (!condition) throw new Error(message);
};
const account = (id: string): AccountContext => ({
  userId: "consumer-user",
  accountId: id,
  organizationId: `organization-${id}`,
});
const scope = (environment: AuthEnvironment): CredentialScope => ({
  environment,
  ...account("a"),
});
const key = (value: CredentialScope): string =>
  JSON.stringify([
    value.environment,
    value.userId,
    value.accountId,
    value.organizationId,
  ]);

export const runAuthHeadlessConsumerVerification = async (): Promise<void> => {
  check(
    typeof createTfRobotAuthTransport === "function",
    "TFRobot subpath missing",
  );
  const records = new Map<string, CredentialRecord>();
  const store: CredentialStore = {
    read: async (value) => records.get(key(value)) ?? null,
    write: async (value, record) => {
      records.set(key(value), record);
    },
    clear: async (value) => {
      records.delete(key(value));
    },
  };
  const fixture = (environment: AuthEnvironment) => {
    let current: AuthSession | null = null;
    let identity = account("a");
    let refreshes = 0;
    let verifications = 0;
    const session = (): AuthSession => ({
      kind: "bearer",
      token: `${environment}-fixture-credential-${refreshes}`,
      expiresAt: 200_000,
    });
    const transport: AuthTransport = {
      login: async () => ({
        kind: "account-selection-required",
        accounts: [account("a"), account("b")],
      }),
      selectAccount: async (id) => {
        identity = account(id);
        current = session();
        return { kind: "authenticated", account: identity };
      },
      getCurrentAccount: async () => {
        check(current !== null, "Identity verification needs a session");
        ++verifications;
        return identity;
      },
      listAccounts: async () => [account("a"), account("b")],
      switchAccount: async (id) => {
        identity = account(id);
        current = session();
        return identity;
      },
      getSession: async () => current,
      restoreSession: (value) => {
        current = value;
      },
      clearSession: () => {
        current = null;
      },
      logout: async () => {
        current = null;
      },
      refresh: async () => {
        ++refreshes;
        return session();
      },
    };
    return {
      client: createAuthClient({
        environment,
        transport,
        credentialStore: store,
        credentialScope: scope(environment),
        now: () => 100_000,
      }),
      refreshes: () => refreshes,
      verifications: () => verifications,
    };
  };
  const first = fixture("staging");
  const restored = fixture("staging");
  const production = fixture("production");
  try {
    await first.client.login({
      identifier: "fixture",
      password: "transient-fixture",
    });
    check(
      first.client.getSnapshot().status === "account_selection_required",
      "Multi-account login missing",
    );
    await first.client.selectAccount("a");
    check(
      (await first.client.listAccounts()).length === 2,
      "Account options missing",
    );
    await Promise.all([first.client.refresh(), first.client.refresh()]);
    check(first.refreshes() === 1, "Concurrent refresh was not single-flight");
    check(first.verifications() === 1, "Renewed identity was not verified");
    let attempts = 0;
    await first.client.createSessionProvider().withAuthRetry(async () => {
      if (++attempts === 1) {
        const rejected = new Error("Fixture unauthorized request");
        Object.assign(rejected, { status: 401 });
        throw rejected;
      }
      return "recovered";
    });
    check(
      attempts === 2 && first.refreshes() === 2,
      "401 retry was not bounded",
    );
    await restored.client.restore();
    check(
      restored.client.getSnapshot().account?.accountId === "a",
      "Stored identity did not restore",
    );
    check(
      restored.verifications() === 1,
      "Restore skipped server identity verification",
    );
    await production.client.restore();
    check(
      production.client.getSnapshot().status === "signed_out",
      "Staging credential crossed environment",
    );
    await first.client.switchAccount("b");
    check(
      first.client.getSnapshot().account?.accountId === "b",
      "Account switch failed",
    );
    check(
      records.size === 0,
      "Previous trusted storage scope survived account switch",
    );
    for (const { client } of [first, restored, production]) {
      check(
        !JSON.stringify(client.getSnapshot()).includes("fixture-credential"),
        "Credential leaked into snapshot",
      );
    }
    await first.client.logout();
    check(
      first.client.getSnapshot().status === "signed_out",
      "Logout did not revoke identity",
    );
    let denied = false;
    try {
      await first.client.createSessionProvider().getSession();
    } catch {
      denied = true;
    }
    check(denied, "Signed-out client supplied credentials");
  } finally {
    await Promise.all([
      first.client.dispose(),
      restored.client.dispose(),
      production.client.dispose(),
    ]);
  }
};
