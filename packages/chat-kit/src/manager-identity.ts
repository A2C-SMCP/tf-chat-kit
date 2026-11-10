/** Chat identity that owns an injected Interaction client. */
export interface ManagerChatIdentity {
  readonly accountId?: string | undefined;
  readonly environment?: string | undefined;
  readonly organizationId?: string | undefined;
  readonly platformId?: number | undefined;
  readonly robotId: string;
  readonly userId?: string | undefined;
}

export interface ManagerChatIdentityMatchOptions {
  /** Explicitly treat omitted expected fields as wildcards. Defaults to false. */
  readonly allowWildcards?: boolean | undefined;
}

/**
 * Compares the identity asserted by the host with the identity currently
 * selected by ManagerChatApp. By default every field must match exactly;
 * wildcards require an explicit opt-in.
 */
export const managerChatIdentityMatches = (
  expected: ManagerChatIdentity,
  actual: ManagerChatIdentity,
  options: ManagerChatIdentityMatchOptions = {},
): boolean => {
  const wildcard = options.allowWildcards === true;
  return (
    expected.robotId === actual.robotId &&
    (expected.platformId === actual.platformId ||
      (wildcard && expected.platformId === undefined)) &&
    (expected.accountId === actual.accountId ||
      (wildcard && expected.accountId === undefined)) &&
    (expected.organizationId === actual.organizationId ||
      (wildcard && expected.organizationId === undefined)) &&
    (expected.environment === actual.environment ||
      (wildcard && expected.environment === undefined)) &&
    (expected.userId === actual.userId ||
      (wildcard && expected.userId === undefined))
  );
};

export interface ManagerInteractionClientResolutionOptions {
  /** Explicit opt-in to use a non-null client without an asserted identity. */
  readonly allowUnscoped?: boolean | undefined;
  readonly allowWildcards?: boolean | undefined;
}

/**
 * Resolves the host-owned Interaction client against the current identity.
 * A non-null client without an asserted identity fails closed unless the host
 * explicitly opts into an unscoped client.
 */
export const resolveManagerInteractionClient = <Client>(
  client: Client | null | undefined,
  expected: ManagerChatIdentity | undefined,
  actual: ManagerChatIdentity | undefined,
  options: ManagerInteractionClientResolutionOptions = {},
): Client | null | undefined => {
  if (client === null || client === undefined) return client;
  if (expected === undefined)
    return options.allowUnscoped === true ? client : null;
  if (actual === undefined) return null;
  return managerChatIdentityMatches(expected, actual, {
    allowWildcards: options.allowWildcards,
  })
    ? client
    : null;
};

/** Stable host-scope string used to retain drafts across same-identity client rebuilds. */
export const managerChatIdentityScope = (
  identity: ManagerChatIdentity,
): string =>
  // JSON avoids delimiter collisions inside identifiers.
  JSON.stringify([
    identity.environment ?? null,
    identity.userId ?? null,
    identity.accountId ?? null,
    identity.organizationId ?? null,
    identity.platformId ?? null,
    identity.robotId,
  ]);

/** The conversation surface is inline-capable only while the chat screen is visible. */
export const managerChatInlineVisible = (
  screen: string,
  staleIdentity: boolean,
): boolean => screen === "chat" && !staleIdentity;
