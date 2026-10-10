import type { AuthClient } from "../../packages/chat-auth/src/headless.js";

/** Refresh retains chat ownership; an unavailable or changing identity does not. */
export { managerIdentityScope as authChatScope } from "../../packages/chat-auth/src/manager.js";
import { managerIdentityScope as authChatScope } from "../../packages/chat-auth/src/manager.js";

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
