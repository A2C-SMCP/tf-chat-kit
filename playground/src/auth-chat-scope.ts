import type {
  AuthClient,
  AuthSnapshot,
} from "../../packages/chat-auth/src/headless.js";

/** Refresh retains chat ownership; an unavailable or changing identity does not. */
export const authChatScope = (snapshot: AuthSnapshot): string | undefined =>
  (snapshot.status === "authenticated" || snapshot.status === "refreshing") &&
  snapshot.account !== undefined
    ? JSON.stringify([
        snapshot.environment,
        snapshot.account.userId,
        snapshot.account.accountId,
        snapshot.account.organizationId ?? null,
      ])
    : undefined;

export const observeAuthChatScope = (
  client: AuthClient,
  onChange: (scope: string | undefined) => void,
): (() => void) => {
  let current = authChatScope(client.getSnapshot());
  return client.subscribe((snapshot) => {
    const next = authChatScope(snapshot);
    if (next === current) return;
    current = next;
    onChange(next);
  });
};
