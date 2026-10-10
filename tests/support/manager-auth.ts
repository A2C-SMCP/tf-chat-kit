import {
  createAuthClient,
  type AuthSession,
} from "../../packages/chat-auth/src/headless.js";
export const managerAuthFixture = async () => {
  let account = { userId: "user", accountId: "a", organizationId: "org-a" };
  let session: AuthSession | null = { kind: "bearer", token: "manager-secret" };
  const auth = createAuthClient({
    environment: "staging",
    transport: {
      login: async () => {
        session = { kind: "bearer", token: "manager-secret" };
        return { kind: "authenticated", account };
      },
      selectAccount: async () => ({ kind: "authenticated", account }),
      switchAccount: async (id) => {
        account = { ...account, accountId: id, organizationId: `org-${id}` };
        return account;
      },
      getCurrentAccount: async () => account,
      listAccounts: async () => [account],
      getSession: async () => session,
      logout: async () => {
        session = null;
      },
      clearSession: () => {
        session = null;
      },
    },
  });
  await auth.login({ identifier: "fixture", password: "fixture" });
  return auth;
};
