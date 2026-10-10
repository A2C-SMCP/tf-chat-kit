# Issue 93: Manager authentication contract

Baseline: `dev-0.8.3@6e10d6d06426d3cc2d0b19e4e829d007cd4ca17d`.

## Scope and implementation

ADR-012 permits this optional adapter in `@turingfocus/chat-auth/tfrobot`, with
Headless stable models and no Host, DOM, React, or Ant Design dependency. The
existing transport and generation fencing are reused. Host owns backend selection,
storage, ChatClient identity/cache replacement, and robot-specific Token Exchange.
The generic auth session is opaque; it does not replace robot audience/scope
exchange in the existing Playground directory integration.

Read-only Manager contract sources: `internal/user/api/dto/auth_dto.go`,
`account_dto.go`, `user_dto.go` and `handlers/auth_handler.go`. No external
repository is modified. These define the five routes listed in #93. Account
options have an account and optional organization but no user ID; onboarding
has a user ID and restricted token but no account. The public `AccountOption`
model therefore permits absent user IDs. Authenticated `AccountContext` still
requires one. `AuthUserContext` and optional `AuthSnapshot.user` express onboarding
without constructing a fake account. The legacy account-bearing onboarding
result remains accepted by Headless; consumers should use its user context when
no account exists. This public model expansion is recorded as a minor changeset.

Transport projects only stable identity/display fields, validates objects,
identifiers, conflicting aliases, credential fields, flags, envelopes and lists,
and rejects invalid payloads before credential commit. Phone/email requests use
Manager field names. Selection preserves its temporary token privately, then
selected and switched credentials are verified by `/api/v1/auth/me` using the
candidate bearer. Requested account, response user/account and supplied
organization must match. Generation guards precede extra requests and credential
commit; logout/dispose/supersession during verification cannot commit a late token.

Onboarding and account-selection do not expose a chat session. HTTP and envelope
401/403/404/other failures, invalid JSON/DTOs and fetch failures become structured
errors. Server-provided messages, details and thrown transport texts do not enter
snapshots or AuthClient rejection messages.

`createSessionProvider()` is structurally assignable to Protocol SessionProvider
without adding a Protocol dependency to Headless. Requests resolve a committed
session on demand and honor optional cancellation. `onSessionInvalid` joins the
optional single-flight refresh for rejected/expired credentials; unsupported
refresh safely revokes to `auth_required`. Forbidden requests preserve the valid
identity and report authorization denial. Gateway owns its one operation retry;
Host must replace/dispose old identity-dependent Gateway instances when identity
changes. Production Manager JWT refresh is unconfirmed, so no endpoint is invented.

## Verification

Six focused AuthClient, transport, lifecycle, React and Manager-directory test files
pass 81 tests. The new local TCP HTTP fixture verifies actual routes, request bodies,
Authorization, real Manager account-selection/onboarding DTOs, candidate `/me`,
identity mismatches, logout during verification, credential projection and HTTP,
envelope, JSON and network errors. Gateway reads through the same real fixture
verify 401 refresh/retry, unsupported-refresh fallback and 403 without login replay.
Existing lifecycle fixtures now answer the required candidate verification request.

Build, test and Playground type checks, targeted lint, dependency boundaries,
changeset coverage and diff checks passed. Headless compiled separately with
ES2022 only and no ambient DOM, Node or React types. A real HTTP baseline/current
probe rejects the old implementation's handling of missing-user-ID options and
identity mismatches, confirming the coverage distinguishes the repaired behavior.
Playground RobotServer passed another 42 tests. Full isolated review approved the
current working-tree contents with no blockers; only optional cancellation tests
were suggested. Packed consumers and full integration have since passed in #96;
see `integration-acceptance.md`. Production Manager compatibility remains
unverified separately from controlled local contract tests. No commit, push, PR or issue
closure has occurred. This baseline is local contract evidence, not a production
compatibility pass.
