# Remaining issues implementation and acceptance plan

User authorization: implement the remaining issues in dependency order with the
`add-feature` workflow and pass acceptance. Source baseline:
`6e10d6d06426d3cc2d0b19e4e829d007cd4ca17d` on `dev-0.8.3`.

## Scope and ownership

ADR-012 authorizes the independent, optional `chat-auth` package. Authentication
state, transport adaptation and default UI belong there. Host applications own
storage implementations, environment configuration, ChatClient ownership,
identity-dependent cache scope and product navigation. Authentication-disabled
Chat Kit consumers must continue to work. No external host repository is modified.
The private Playground owns its connection UI and repository-local fixtures.

## Order and acceptance

This roadmap includes partially completed and unfinished work only. Completed
#91 is excluded from the execution queue; #100/#101 are tracked under #46 and
#102 under #97, without duplicating their work.

| Issue | Tracked scope                                                                                                                                                        | Acceptance evidence                                                                                                        | Status                                                 |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| #46   | Repair rejected-session subscription preflight and provisional/persisted user message identity                                                                       | Real local HTTP/Socket.IO races, isolated review, real Manager/BFF/RobotServer revalidation                                | Accepted and closed; see final scope below             |
| #92   | Fence late credential commits, asynchronous store writes, logout, invalidation, dispose and account-list results                                                     | Real local HTTP interleavings, injected storage interleavings, headless build, React and host regressions, isolated review | Accepted and closed; see final scope below             |
| #93   | Validate selected/switched identity against `/auth/me`, sanitize structured errors and bridge Gateway invalidation                                                   | Real local HTTP requests for single/multi-account/onboarding, DTO and error boundaries, Gateway-compatible provider        | Accepted and closed; see final scope below             |
| #94   | Validate restored server identity against credential scope, expiry/skew, single-flight refresh and bounded 401 retry, storage failures                               | Deterministic clock and storage tests, real local HTTP refresh/retry path, unavailable-refresh fallback                    | Accepted and closed; refresh contract remains external |
| #95   | Verify packed UI consumers and include locally accepted UI in final integration                                                                                      | DOM interaction and keyboard tests, external provider lifecycle, headless dependency isolation                             | Accepted and closed; see final scope below             |
| #96   | Identity-dependent host ChatClient/cache lifecycle, enabled/disabled authentication, headless and React/Ant Design packed consumers, compatibility and security scan | Real HTTP/Socket.IO integration, all packed consumers and `pnpm check`, isolated review                                    | Accepted and closed; see final scope below             |
| #97   | Connect Manager quick chat to existing conversation creation entry                                                                                                   | Empty-history creation, independent chat, identity/robot switch races, real consumer acceptance                            | Accepted and closed; see final scope below             |
| #98   | Remove unused connection-panel props/branches while retaining the active `.debug` loader                                                                             | Connection-panel tests and focused browser regression                                                                      | Accepted and closed; see final scope below             |
| #99   | Align the approximate RobotServer fixture with the optional `platformId` contract                                                                                    | Browser flow through Manager exchange, conversation list, send and realtime receive; manual credential regressions         | Accepted and closed; see final scope below             |
| #90   | Verify the parent acceptance criteria after #92–#96                                                                                                                  | Requirement-by-requirement audit of the evidence above                                                                     | Accepted and closed; see final scope below             |

#46 recovery repairs precede the final real-consumer acceptance. #92 precedes #93 and #94; their shared provider/identity contract precedes #95 and
#96. #98 and #99 are independent of public authentication behavior and are handled
after the authentication sequence in this implementation run. #97 reuses existing conversation creation; #98/#99 fixture and panel changes precede the final Playground regression.

## Remaining route after local implementation

This is the corrected roadmap for partially complete and unfinished issues.
Locally accepted implementation is not scheduled for duplicate development.

1. Completed prerequisite: the final whole-project gate after #97–#99 passed
   (79 files / 1,415 tests, build and packed consumers). The 15 Chromium cases
   and isolated #97/#98/#99 reviews passed. This step is evidence, not remaining
   development; start remaining execution at the real-service revalidation below.
2. Completed current BFF regression: two single-request injected 401 recoveries,
   unique persisted/DOM user messages, a new live reply after recovery, prefixed
   quick creation and verified exact-ID manual/automatic cleanup of test IDs
   27/28/29. Direct API issuer compatibility and TFRS-336's complete verified
   Server recovery profile remain separate; #46 is accepted for Kit scope.
   Under ADR-009 they do not block independent Kit delivery.
3. Deliver the locally accepted #92–#95 and #98/#99 changes after final gates and
   authorized commit/push/PR. Close each only with delivered implementation and
   its scoped acceptance evidence. Close #97 with its passing real BFF evidence; accept #46 for Kit scope with Server requirements retained in TFRS-336.
4. #96 and parent #90 are accepted and closed under the user-approved
   acceptance-before-publication policy. Protected publication and unauthenticated
   Registry verification follow acceptance under separate release authorization. Its seven acceptance
   criteria have local evidence in `integration-acceptance.md`. The unprovided
   Manager user-JWT renewal contract remains explicitly external; the tested
   `auth_required` fallback satisfies the specified no-refresh behavior.

External contract risk: newer RobotServer HEAD uses a required JSON creation DTO,
whereas the existing gateway/fixture targets the deployed legacy query contract.
Confirm the target server version before real #97 acceptance; do not infer support
for the new endpoint from the fixture. See `../issue-99-fixture-contract.md`.

Current continuation evidence: the direct robot's public discovery metadata now
advertises production Manager, unlike September's staging advertisement. Actual
direct JWT/Socket verification remains unproven. Restarted Playwright restored
real BFF access and revealed message-identity and creation-title defects. Their
repairs passed focused tests, fresh isolated review, 15 Chromium cases and the
full gate (79 files / 1,424 tests, builds and packed consumers); the
repaired current BFF flow and precise test cleanup subsequently passed after
re-login. The final cleanup-method repair passed seven HTTP proxy tests and fresh
isolated review. The final serial full gate passed with exit 0 (79 files /
1,424 tests, build, static gates and all packed consumers). All 27 browser
scenarios have passing evidence: 23 local and four WebKit in the documented
container environment. TFRS-336 is
still `待办`; its complete verified recovery contract remains external and must
not be inferred from the current-server regression tests. Git delivery was authorized on 2026-10-10 and PR #103 was created. The missing auth lock importer and protected independent publishing support were repaired and passed full CI in that PR. No credentials were requested or read. The user removed actual publication as an acceptance prerequisite; #96 and #90 are accepted and closed.

## Implementation decisions

- AuthClient owns a private committed session separately from its public snapshot.
  A transport result cannot supply a session until its generation is current.
- Stateful TFRobot transport operations fence their own credential commits;
  logout and clear discard the temporary multi-account credential as well.
- CredentialStore operations are serialized per instance so a clear follows any
  already-started write. Generation checks discard writes that have not started.
- Refresh and operation retries must not resurrect a signed-out/disposed client
  or invalidate a newer identity. Gateway invalidation and authentication retry
  ownership are explicitly bridged in #93/#94.
- The actual Manager refresh endpoint remains unconfirmed. Implement and verify
  the optional transport strategy and safe `auth_required` fallback; never invent
  a production endpoint or save/replay passwords. Record the production contract
  as unverified in the final compatibility matrix.
- Organization switching uses the Manager account/organization mapping verified
  against the current repository contract; UI only invokes headless commands.
- No polling, global state, default browser persistence or new workspace package.

## Verification and delivery

Use Node 24 from `.nvmrc`. Each issue gets focused tests and an isolated read-only
review of staged new files plus tracked/untracked diff; fix blocking findings and
rerun affected tests. Final acceptance includes `pnpm check`, focused browser
tests, packed enabled/disabled consumers and real local HTTP/Socket.IO behavior.
Real external Manager/RobotServer compatibility is recorded separately under
ADR-009. On 2026-10-10 the user explicitly authorized commit, push and PR creation.
Delivery resumes from the passing gates recorded above; no package publication
or merge is authorized. The previously requested closure of completed issues
follows verified PR delivery and each issue's own completion criteria. Existing
unrelated `.playwright-mcp/` artifacts remain outside scope.

## Remaining route after accepted PR #103

On 2026-10-10 the user required acceptance before publication and approved the
Kit/Server split for #46. #90 and #92–#99 are accepted and closed; #46 is accepted
and closed for Kit scope. Functional commit `3dc7284720ac5704cf8977ad0dfaac94c3512541`
passed full local checks and CI 38021419097, including all 27 browser scenarios.
The latest independent #46 run passed 161 tests; the real Server probe confirms
current-server compatibility with an empty ACK, not verified complete recovery.

1. Review/merge the feature and Changesets version PRs under separate merge
   authorization. Changesets plans core seven at `0.8.3` and auth at `0.9.0`;
   those versions have not been published by this work.
2. An authorized Release Owner verifies npm Environment, immutable tags and
   Trusted Publishers, executes the selected core/auth/all protected release,
   then verifies unauthenticated Registry consumers. Publish the already accepted
   implementation; do not postpone #90/#96 acceptance until this publication.
3. Server TFRS-336 owns structured conversation authorization/ACK, persisted
   replay/completeness and worker durable delivery. Latest Server develop
   `a0f2bc3a` still lacks the full protocol. TFRS-582 fixed heartbeat/worker
   reconnect and delivered a dev image; TFRS-550 retains a failed historical
   browser automatic-recovery check. Implement the remaining Server contract and
   independently verify offline-window recovery against an identified deployment.
   Audit details are in `../issue-46-recovery.md`.
