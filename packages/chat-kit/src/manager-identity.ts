/** Chat identity that owns an injected Interaction client. */
export interface ManagerChatIdentity {
  readonly accountId?: string | undefined;
  readonly environment?: string | undefined;
  readonly organizationId?: string | undefined;
  readonly platformId?: number | undefined;
  readonly robotId: string;
  readonly userId?: string | undefined;
}

/**
 * Compares the identity asserted by the host with the identity currently
 * selected by ManagerChatApp. Omitted expected fields act as wildcards.
 */
export const managerChatIdentityMatches = (
  expected: ManagerChatIdentity,
  actual: ManagerChatIdentity,
): boolean =>
  expected.robotId === actual.robotId &&
  (expected.platformId === undefined ||
    expected.platformId === actual.platformId) &&
  (expected.accountId === undefined ||
    expected.accountId === actual.accountId) &&
  (expected.organizationId === undefined ||
    expected.organizationId === actual.organizationId) &&
  (expected.environment === undefined ||
    expected.environment === actual.environment) &&
  (expected.userId === undefined || expected.userId === actual.userId);

/** Resolves the host-owned Interaction client against the current identity. */
export const resolveManagerInteractionClient = <Client>(
  client: Client | null | undefined,
  expected: ManagerChatIdentity | undefined,
  actual: ManagerChatIdentity | undefined,
): Client | null | undefined => {
  if (expected === undefined) return client;
  if (actual === undefined) return null;
  return managerChatIdentityMatches(expected, actual) ? client : null;
};

/** The conversation surface is inline-capable only while the chat screen is visible. */
export const managerChatInlineVisible = (
  screen: string,
  staleIdentity: boolean,
): boolean => screen === "chat" && !staleIdentity;
