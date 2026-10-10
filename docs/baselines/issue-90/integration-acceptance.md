# Issue 96: integration acceptance evidence

Baseline: `dev-0.8.3` at `6e10d6d06426d3cc2d0b19e4e829d007cd4ca17d`.
This is an in-progress evidence ledger, not final acceptance or delivery.

## Packed headless authentication consumer

`tests/consumers/auth-headless/consumer.ts` imports only the public `/headless`
and `/tfrobot` entries. The packed verifier copies the consumer into a temporary
project that installs the packed auth artifact and TypeScript, excludes React,
React DOM and Ant Design, compiles with ES2022 and `types: []`, and executes it.
The consumer exercises multi-account selection, account listing and switching,
renewal single-flight, one bounded 401 retry, restoration with server identity
verification, environment storage isolation, trusted-scope cleanup, snapshot
sanitization, logout rejection and disposal. Its injected transport verifies the
public lifecycle boundary; actual Manager HTTP/Socket contracts remain covered
by the existing real local TCP integration tests and final compatibility runs.

The new auth React and AntD consumers use their public package subpaths in
separately installed projects. React exercises subscription updates, a fresh-object
selector, account switching, client/environment replacement, old-client logout,
Strict Mode, unmount and externally owned client reuse without AntD installed.
AntD mounts actual DOM, drives keyboard organization switching and logout, and
checks expired-session presentation and credential absence. The common DOM setup
supplies the browser constructors required by the installed component libraries.

The final packed run passed all three auth consumers and all existing package,
UI, React, Office, Tauri and Front-style consumers. Auth-disabled React, Office
and Tauri consumers explicitly verify that `chat-auth` was not installed.
The headless consumer is additionally bundled with Vite, its module graph is
checked for absence of React/React DOM/AntD, and the generated ESM artifact runs
the same lifecycle verification. Bundling restores the original process
`NODE_ENV`, preserving the subsequent React interaction consumers' environment.

## Artifact scanning

The first packed run rejected dynamic `token`/`password` field projections as
embedded credentials. Source scanning now distinguishes AST-confirmed member
projections and calls receiving references/credential field names from literals.
String/comment/config assignments and embedded credential literals remain subject
to detection. AST inspection additionally detects credential literals nested in
calls, which a short callee name could previously hide from the assignment regex.

The policy suite passes 36 tests, including dynamic field/validator projections,
comment/string/config credentials, credential literals inside calls and ordinary
authorization labels. Consumer/policy/verifier type checks and targeted lint pass.
The latest packed run uses the final scanner revision and passes artifact scanning.

## Host identity and chat lifecycle

The private Playground observes a credential-free identity scope comprising
environment/user/account/organization. `authenticated` and `refreshing` retain
that scope; switching, authentication-required and signed-out revoke it. Scope
changes clear the selected robot, invalidate pending connection generations and
dispose the current chat session. Manager environment/login replacement clears
the prior selection before starting a new login. Authentication-disabled Chat Kit
mode does not subscribe to identity changes. The host retains its own logout and
organization controls so their lifecycle callbacks cannot be bypassed by duplicate
default UI controls.

Two scope tests exercise the real AuthClient and ChatClient/Memory Gateway:
refresh retains the instance, account switching releases it, an old held load is
rejected and cannot populate the replacement snapshot, and environment/user/
account/organization scopes differ without credential content. Existing
Playground and auth UI tests pass another 60 scenarios. An actual Playground DOM
test additionally verifies that auth-disabled Chat Kit retains its active client
and conversation across independent login/logout. Full type checks and targeted
lint pass. The first whole-project run passed 77 files/1,410 tests and Playground
build, then exposed the bundler environment leak. That leak is fixed and the
complete packed run passes. The subsequent whole-project gate passed all 78 files/
1,411 tests, Playground build and packed verification.

## Cross-package review follow-up

The first isolated #96 review requested changes: the auth-only consumers and
existing chat-only consumers did not exercise their combined published boundary.
The passing gate above therefore does not establish complete #96 acceptance.

Two additional independent projects now install both packed `chat-auth` and
`chat-kit`. They pass `AuthClient.createSessionProvider()` through the public
`createTFRobotChatClient()` facade and use real local TCP HTTP/Socket.IO facilities.
The common scenario drives Manager login and verified account switching, lazy
credential reads, authenticated listing/loading/sending, Socket bearer validation
and realtime delivery, identity-owned client disposal, held old-response rejection,
new-instance snapshot isolation and logout cleanup. The UI project additionally
mounts the public AuthProvider/AuthStatus and ChatProvider/ChatConversationView and
checks server content and credential-free rendering. The headless project does
not install React, React DOM or AntD. The new complete packed run passed both
combined consumers and all existing consumers. A fresh full-scope isolated review
approved the final changes with no blockers and confirmed that historical B1 is
resolved. Its optional suggestion is to wrap network-driven UI updates in React
`act`; the existing warning is recorded below. The implementation uses the default
blocking-only review scope.

The headless combined project disables pnpm peer auto-installation and explicitly
allows missing React/React DOM/AntD and React type peers: the facade has transitive UI packages,
whose unused peer dependencies otherwise get installed automatically. This is
consumer configuration, not a change to package metadata. The installed-package
absence check, ES2022-only compilation and real execution still enforce that the
headless public entry can run without those libraries.

Latest follow-up checks: tests/scripts TypeScript, targeted ESLint, Prettier and
`git diff --check` pass. The combined UI scenario emits React `act` warnings for
network-driven updates outside the harness action scope; they were not suppressed
and no command or assertion failed.

## Still required before acceptance

- Confirm the compatibility matrix and its explicit production-service limitations.
- The final repeated whole-project `pnpm check` including the combined consumers
  passed: 78 files / 1,411 tests, Playground build, all packed consumers, artifact
  security checks and static gates. The final isolated review approved #96 with
  no blockers. The package composition checks passed; the complete #96 publication criterion remains open until a protected npm release passes Registry consumer verification.
- Final Playground regression after #97–#99 now passes 15 Chromium scenarios,
  including Manager list/create/send/realtime/logout and manual credential modes.
  The final real BFF follow-ups for #46/#97 are recorded below and remain distinct
  from fixtures; the full verified Server gate for #46 is still external.
- The latest final `pnpm check` after #97–#99 passes all static checks,
  79 files / 1,415 tests, Playground build, packed consumers and artifact security.
  The final isolated #97/#98/#99 reviews each approved with no blockers.

## Latest real-service repair gate

After restarting Playwright and a direct user login, the real BFF flow exposed
provisional/persisted message duplication and a missing conversation title.
The Gateway identity mapper and private BFF proxy repairs are recorded in
`../issue-46-recovery.md` and `../issue-97-quick-create.md`.

The latest full `pnpm check` completed with exit 0: 79 files / 1,424 tests,
static checks, builds, packed consumers and artifact validation. All 15 Chromium
regression cases passed again. The fresh isolated repair review approved with
no blocking findings. Logs: `/tmp/tfck-real-retry-final-check.log` and
`/tmp/tfck-real-retry-browser.log` (temporary local evidence, not published files).

The repaired real BFF regression passed: two single-request injected 401s
recovered through real Token Exchange/status 200, both synthetic messages remained
one persisted fact and one DOM message, and a new assistant reply arrived after
recovery. Creation retained the reserved title prefix. Exact-ID cleanup of owned
27/28 succeeded; UI-created 29 was automatically deleted on logout. Complete
pagination after re-login proved all three absent. The final cleanup repair also
passed seven actual HTTP proxy tests and fresh isolated review. The final serial `pnpm check` completed with exit 0: all 79 files / 1,424 tests,
static gates, build and all packed consumers/artifact validation passed. Log:
`/tmp/tfck-bff-cleanup-sequential-check.log`. The broad local browser run passed 23 cases; four
WebKit cases could not launch on macOS (known engine bus error). Those four
subsequently passed in the existing Playwright v1.62.1 Noble container using the
repository-documented remote browser recipe, without mounting the repository or
credentials. WebKit long-history load measured 218 ms. Together, 23 local and four
container cases cover all 27 collected browser scenarios. The container was
stopped after its test process completed. Logs:
`/tmp/tfck-bff-cleanup-browser-retry.log` and
`/tmp/tfck-bff-webkit-container.log`. These remain distinct from real BFF evidence. Git delivery was explicitly authorized on 2026-10-10 under add-feature Phase 6;
actual PR/SHA and scoped closure evidence will be recorded on the GitHub issues.

## Parent #90 acceptance audit

The seven original criteria map to the evidence above: disabled consumers and
manual SessionProvider compatibility; environment/identity credential and client
isolation; all five Manager auth routes with verified `/me`; React/AntD headless
ownership; reproducible storage/restore/logout/renewal/401 and secret tests;
independent packed Front-style UI and non-Front headless consumers; explicit
external production renewal limitation with tested `auth_required` fallback.
Each has local passing evidence. The missing production refresh contract is an
explicitly allowed external dependency under criterion 7, not a silent-renewal
claim. Parent closure still follows delivery and closure of its child issues.

No external host source is changed. The auth package remains optional and is not
re-exported or automatically initialized by Chat Kit, following ADR-012. The implementation was committed and pushed as PR #103 on 2026-10-10. No merge, publication or issue closure has occurred at this audit point.

## Delivery authorization

On 2026-10-10 the user authorized commit, push and PR creation for this accepted
work. The previously requested closure of completed issues follows verified
remote delivery: #92–#95 and #97–#99. #96 and parent #90 remain open until the required actual protected publication succeeds. Parent #46 remains open
for its complete verified Server recovery contract. No merge, deployment or npm
publication is included in this authorization.

## Protected publication support follow-up

PR #103 CI exposed a missing `chat-auth` lock importer, now synchronized and
verified with `pnpm install --frozen-lockfile` and a full successful `pnpm check`.
A fresh isolated audit also found that protected publishing still required all
eight packages to share one version despite independent Changesets versioning.
The release chain now selects the original fixed group, auth alone, or both,
uses an auth-specific immutable source tag for auth-only batches, records exact
consumer package versions, publishes/uploads only selected artifacts, and derives
incident recovery commands from each package's target version. OIDC/provenance,
immutable artifact integrity and compatibility gates remain required.

The local release tests use a controlled Registry and perform no npm writes.
The literal #96 criterion includes actual publication, which is outside the
current Git delivery authorization. Keep #96 and #90 open; do not treat a passing
release-support test or PR creation as a completed production release.

The final follow-up `pnpm check` completed with exit 0: all 80 files / 1,430
tests, static and type gates, Playground build, all packed consumers and artifact
security checks passed. Log: `/tmp/tfck-pr103-independent-release-check.log`.
The release-specific suite passed 46 tests across five files, including actual
manifest CLI execution and controlled Registry publication of mixed-version,
core-only and auth-only batches. A fresh complete-scope isolated review approved
with zero blocking findings. One optional improvement remains: move reconciliation
of an existing GitHub Release manifest before npm writes; the release handbooks
already forbid changing a completed core batch to all under the same source tag.
No npm write was executed by these tests.
