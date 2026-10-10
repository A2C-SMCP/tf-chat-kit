# Issue 94: credential restoration and expiry strategy

Baseline: `dev-0.8.3@6e10d6d06426d3cc2d0b19e4e829d007cd4ca17d`.

## Scope and decisions

ADR-012 authorizes optional Headless credential lifetime management; Host owns
storage implementation, trusted startup scope and fixed environment selection.
No browser storage, timers, polling, password replay or production refresh endpoint
is added. Manager JWT refresh/rotation/TTL/revocation remains an external contract
blocker. The supported injected strategy and safe unavailable-refresh path are
implemented and tested without claiming this production contract is verified.

Reuse AuthClient's serialized CredentialStore queue, generation guards, private
committed session and optional AuthTransport strategy. Scope is copied/projected
at construction and stays fixed. Stores receive a separate credential copy so
mutating a record cannot change the client's committed session. Versioned records
must match environment/user/account/organization before installation. Credential
shape is validated and projected; incompatible metadata is discarded, malformed
credentials revoke to `auth_required`. Restoring stored material requires the
transport's optional `restoreSession` capability; otherwise fail safely.

Restoration verifies actual server identity via `getCurrentAccount` (`/auth/me` in
TFRobot Transport) against all scope components, including absence of an
organization. Fresh and unexpired stored credentials are never trusted solely
because their local metadata matches. An expired/near-expiry record is renewed
once when a strategy exists and the candidate identity is then verified.

`AuthSession.expiresAt` is Unix epoch milliseconds; absent expiry means unknown TTL
and is not inferred by decoding JWTs. `CreateAuthClientOptions.now` and
`refreshSkewMs` (default 30,000 ms) drive request-time decisions. Within the skew
window, SessionProvider joins one refresh before returning a credential. There is
no background timer. A candidate must remain outside that window through identity
checking and persistence; expired/invalid results fail without refresh loops.

Refresh installs a candidate only into the transport for verification, then
checks user/account and any known organization against the committed identity
before AuthClient commit/persistence. Stateful injected strategies must fence their
own side effects; AuthClient fences installation, identity requests and commits.
The single-flight promise is installed before notifying refreshing subscribers,
so concurrent providers and reentrant subscribers join it. Cancellation does not
return a credential or cancel unrelated consumers' shared refresh.

Refresh failure, identity mismatch or unsupported renewal revokes local authority
and clears the scoped record. Cleanup failure cannot restore local authority or
replace sanitized errors. A second 401 from the one allowed operation retry
revokes authority and returns a sanitized authentication error. Host cannot change
an AuthClient environment: switching environment means disposing the old client
and creating an independent one. Host still owns identity-dependent Gateway/cache
replacement as tracked in #96.

## Verification and remaining gates

The focused auth/transport/lifecycle/React/directory tests cover scoped memory
storage, serialized Host storage, read/write/clear failures, malformed records,
server identity differences, request-time expiry boundaries and custom skew,
unknown TTL, cancellation, single-flight reentry and old-generation fencing.
Real TCP HTTP tests verify actual `/auth/me` Authorization, candidate verification,
fixture-only injected renewal, one 401 retry, unavailable/failed renewal, second
401 sanitization, and logout/dispose before a delayed renewal finishes. No Server
contract layer is mocked in those tests. Existing Gateway invalidation tests now
also answer the renewed candidate identity request.

Eight focused test files passed 134 tests. Build/test/Playground type checks,
targeted lint, dependency boundaries, changeset coverage and diff checks passed.
Headless also compiled with ES2022 and no ambient DOM, React or Node types.
A baseline/current probe confirmed that the original implementation accepted a
restored identity mismatch and did not trigger expiry refresh, while the current
implementation rejects the mismatch and refreshes on demand. Complete isolated
review approved the final working-tree contents with no blockers; an optional
invalid-clock test was suggested. Packed consumers and full integration have
since passed in #96; see `integration-acceptance.md` for the final 1,415-test
whole-project and packed-consumer evidence. Production refresh remains an
unprovided external contract, with the tested `auth_required` fallback retained.
The current BFF #46/#97 regression subsequently passed, as recorded in
`integration-acceptance.md`; full verified Server #46 and remote delivery remain
separate.
No commit/push/PR/issue closure is implied by local evidence.
