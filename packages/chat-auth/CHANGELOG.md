# @turingfocus/chat-auth

## 0.10.0

### Minor Changes

- 9dc5b76: Add optional public Manager directory, validated connection resolution and robot token exchange, plus headless and React chat ownership adapters. Share the adapters with Playground and verify independent consumers against local HTTP/Socket.IO and browsers.

## 0.9.0

### Minor Changes

- 0a0be31: Verify persisted and renewed credentials against the server identity before
  committing a session. Add an injectable clock and on-demand refresh skew, validate
  credential records, and fence late refresh work and failed storage cleanup. A
  renewal strategy must support installing candidate sessions for identity checking;
  missing production refresh capability safely requires authentication.
- 0a0be31: Validate Manager authentication DTOs before committing credentials, verify selected
  and switched identities with the candidate session through `/auth/me`, and preserve
  structured errors without server-provided sensitive messages. Account choices can
  omit user IDs; onboarding exposes a user without inventing an account. Provide a
  Protocol-compatible session invalidation callback and cancellation checks.
- 0a0be31: Provide functional optional authentication UI with account and organization
  switching, logout, expired-session actions, loading/error/empty/capability states,
  keyboard interaction and host customization. Environment selection is opt-in and
  limited to host-approved environments; callbacks let the host replace clients.
  Keep subscriptions bound to externally owned clients and suppress callbacks and
  form cleanup from replaced or unmounted bindings.
- a8d22b1: Add the optional host-agnostic authentication package contract and layered
  entrypoints. Stateful transport, React bindings, and Ant Design UI behavior
  land in the follow-up implementation tasks.

### Patch Changes

- 0a0be31: Fence stale authentication credentials and persistence across login, account
  switching, logout, invalidation and disposal. SessionProvider only supplies a
  session committed by the current authentication generation.
