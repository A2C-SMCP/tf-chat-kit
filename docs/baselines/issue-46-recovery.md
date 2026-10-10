# Issue 46 recovery follow-up

Source baseline: `dev-0.8.3@6e10d6d06426d3cc2d0b19e4e829d007cd4ca17d`.
The 2026-10-09 real-service failures in #100/#101 are merged into #46.

## Scope and sequence

1. Repair current-server subscription establishment after a rejected REST
   credential. A successful snapshot read must not conceal a failed subscription.
   REST access validation and the ensuing Socket handshake use the same session.
   Retry authentication only once, within the original deadline. Keep 403 terminal.
2. Reconcile temporary/persisted user message identity across realtime and history
   at the Gateway boundary. Do not collapse messages merely because their text
   matches. External Server changes require separate authorization.
3. Review the complete changes in an isolated context, run appropriate regressions,
   and repeat the real Manager/BFF/RobotServer acceptance. Keep direct API issuer
   compatibility separate from BFF compatibility. The final acceptance scope is
   the user-approved Kit/Server split recorded below.

## Subscription evidence

The original Socket preflight pins its session and HTTP deliberately does not
retry pinned sessions. Subsequent snapshot loading uses a fresh provider session,
which can succeed even though subscription establishment already failed.

The new local TCP HTTP/Socket.IO test checks initial 401, asynchronous host
invalidation, a second preflight with refreshed credentials, and the matching
Socket handshake. Second 401/403 rejection stops before creating the Socket.
Restoring the original Socket implementation makes the regression fail (one
status request instead of two). The two subscription Gateway test files pass 151
tests with the repair, including a hanging invalidation deadline regression.
Two isolated reviews approved this subscription stage. This is local acceptance,
not a production-service pass.

## Message identity evidence and remaining work

The retained, sanitized worker evidence shows the test input initially had
`msg_id=None` and later acquired persisted `msg_id=366`. The DTO mapper uses a
timestamp-based fallback for absent IDs and the database ID for persisted DTOs.
The retained HTTP summary strips IDs, so it alone cannot establish the precise
Socket/history ordering responsible for the observed duplicate. A real local
HTTP/Socket.IO regression reproduces a provisional realtime user message arriving
during same-conversation handoff and persisted history using another ID. Before
the repair Runtime retains two messages; after the repair it retains one.

Current-server Gateway instances share an identity mapper across Socket updates,
REST snapshots and recovery. A provisional user message is correlated only by
conversation, service timestamp, author and complete sanitized business DTO
content, including attachments and all loose DTO/creator business extensions.
The assigned persistence ID is excluded, with existing opaque identity
normalization preserved. Lossy display mapping is never used as the correlation
source. Two
explicit database IDs remain distinct even when those fields match. Ambiguous
provisional delivery stays unbound; assistant streaming content is not used as a
correlation key. All message roles reserve IDs in the same collision-protected
namespace. Recent payload signatures are bounded, while compact established
ID aliases remain stable for the instance lifetime. Conversation deletion and
Gateway disposal clear this private state; the default verified profile is
unchanged. Correlation tests cover both delivery orders, separate message facts,
known ID collisions, ambiguity and signature eviction. The real network test also
retains two separate database messages with otherwise identical fields.
The four focused Gateway test files pass 173 tests. Isolated review identified
ambiguity after a provisional-first match and cross-role ID collisions; both now
have regression coverage. A further full-content regression covers multipart
differences omitted by display truncation and DTO/creator business extensions in
either delivery order. Raw role and optional/null field differences remain
distinct in both delivery orders; only opaque conversation/user identifiers are
normalized. A fresh complete isolated review approved the current working-tree contents with no blockers.
Runtime, Timeline, Conversation Workspace and Playground RobotServer regression
files pass another 166 tests.

## Restarted Playwright real-service retry

On 2026-10-09, the user authorized restarting Playwright. Its own profile was
locked by an old Chrome process; terminating that specific process and reopening
Playwright restored access. The user logged in directly in the browser; no
password or token was requested, printed or stored in evidence.

UI-created owned test conversation 27 returned 200. One synthetic input produced
one successful POST, a provisional realtime user message with null ID, a real
assistant reply, and one persisted history user message. Injecting an invalid
Bearer into exactly one real status request produced 401, real Token Exchange
200, status 200 and a connected, enabled UI. Recovery nevertheless displayed two
copies of the user input. A second synthetic input confirmed persisted additions
under `additionalKwargs`: `chain_result`, `__tf_parent_uuid`, `__tf_element_uuid`.
No other message facts changed apart from the assigned ID.

The mapper now permits those confirmed fields to be added across the persistence
boundary when exactly one compatible identity exists. Existing values must agree;
other business fields and content are unchanged comparison inputs. Each distinct
persisted fact is retained separately, and ambiguous provisional delivery remains
unbound. Read-only Kernel source confirms the result-cache and memory-UUID writes.
New tests cover enrichment in both orders, present-value conflicts and ambiguous
enrichment, plus actual HTTP/Socket.IO handoff. The three focused files pass 37
tests. Fresh isolated review approved the repairs and all 15 Chromium regression
cases passed. The full `pnpm check` gate passed 79 files / 1,424 tests, build,
static checks and packed-consumer validation. The repaired real-service regression passed as recorded below.

After the user restored login, owned conversation 28 returned 200 with its test
prefix retained. A synthetic input returned POST 200, provisional realtime user
ID null, assistant ID 374, and one persisted user fact ID 373. Two separate
reconnects each injected an invalid synthetic Bearer into exactly one real status
request. Each produced a real 401 followed by Token Exchange 200 and status 200,
a connected UI and enabled composer. The first input remained one DOM message;
a second input after recovery returned POST 200 and live assistant ID 376.
After the second recovery, both synthetic inputs each had exactly one persisted
history fact and one DOM message. This proves the current deployed BFF recovery
and identity regression, not the complete verified Server profile below.

Owned conversations 27 and 28 were deleted with response 200/code 200 and matching
returned IDs after confirming the original robot routing scope. Conversation 29
was created through the UI with a retained test title and automatically deleted
on logout with 200/code 200 and matching ID. Re-login used only the browser's
saved credential form and click, as authorized by the user. Complete pagination
then verified all three owned IDs absent. No business conversation was modified.
Capture only identity metadata; never copy credentials or business history into
this baseline.

## Current real-service prerequisite check

On 2026-10-09, an unauthenticated read of the direct robot's public
`/.well-known/oauth-protected-resource` with the previously recorded routing
headers returned 200, resource
`https://api.turingfocus.cn/robots/one-person-org-3:000001` and authorization server
`https://api.turingfocus.cn`. This differs from September's staging issuer
advertisement. Public metadata alone does not prove actual JWT verification,
Socket authentication, 401 recovery or message identity acceptance.

The earlier computer-control startup failure was bypassed by restarting the
locked Playwright profile as requested. Real authenticated evidence is recorded
above. The development-server reload cleared the memory-only login session; the
repaired BFF flow and exact-ID cleanup subsequently passed as recorded above. No credentials or developer `.debug` configuration
were read. Local fixtures do not replace final real-service acceptance.

The linked Server requirement TFRS-336 was re-read on 2026-10-09 and remains
`待办`. Its verifiable join/object authorization, durable replay/completeness and
worker delivery requirements remain an external Server acceptance gate under
ADR-009 and TFRS-336. The user approved independent Kit acceptance on 2026-10-10.
The current-server regression does not establish the complete verified Server
contract; #46 closes only for its Kit scope.

## Final Kit acceptance and Server audit — 2026-10-10

The user explicitly approved closing #46 for Chat Kit scope and retaining Server
requirements in [TFRS-336](https://turingfocus.atlassian.net/browse/TFRS-336).
The four independent lifecycle/Gateway test files passed 161 tests. The accepted
functional revision is `3dc7284720ac5704cf8977ad0dfaac94c3512541`; its full local
check passed 1,430 tests. [CI 38021419097](https://github.com/A2C-SMCP/tf-chat-kit/actions/runs/38021419097)
passed 1,429 tests with the existing macOS JavaScriptCore performance test skipped
on Linux, and all 27 Chromium/WebKit scenarios passed.

A passive reconnect probe against the current real production BFF/RobotServer
returned two status HTTP 200 responses, one join request and an empty Socket.IO
ACK (zero arguments). The UI reported reconnection with no alert. This confirms
current-server compatibility, not object authorization or complete recovery. The
current-server profile remains explicitly degraded/best-effort with
`complete: false`; the verified profile requires structured recovery evidence.
No new business messages or conversations were created by this probe.

Server code was read from freshly fetched
`origin/develop@a0f2bc3a2e1a105e92cd887fcd997e140c25ece8`, rather than the dirty
local working tree. No Server source or user changes were modified.

| Requirement                                                                                   | Latest code and Jira evidence                                                                                                                                                                                                                                                                                                                                                                                                                              | Conclusion                                                                                  |
| --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Heartbeat and worker `/chat` reconnect stability                                              | Commit `68abebc47a69ae2c9b5031238614f69d2fb91054`, merged [PR #84](https://cnb.cool/turingfocus/tfrobotv2/TFRobotServer/-/pulls/84), raises Engine.IO minimum to 4.14.0 and uses production Admin instrumentation. Runtime tests cover heartbeat, residual CONNECT, transport loss and API-only restart with a surviving worker. [TFRS-582](https://turingfocus.atlassian.net/browse/TFRS-582) is completed; dev image `0.4.3-dev0-develop` was delivered. | Implemented; Jira records successful test-instance worker reconnect/chat after API restart. |
| Old browser page automatically resumes realtime without refresh                               | [TFRS-550](https://turingfocus.atlassian.net/browse/TFRS-550), comment 17357 on 2026-10-08, records five passing checks and one failing browser automatic-recovery check. Refresh exposes the reply but is not automatic recovery. This is the historical host-browser result, distinct from the accepted Kit probe above.                                                                                                                                 | Source incident remains in progress; not fully accepted.                                    |
| Authorized structured join, cursor/completeness, persisted replay and worker durable delivery | Latest `tfrobotserver/socket_namespaces/chat.py:59–68` only extracts `conversation_id` and calls `enter_room`, returning no structured ACK. Namespace authentication exists, but is not per-conversation authorization. The inspected chat paths expose no cursor/replay protocol. TFRS-336 is still pending; its controlled offline-window evidence records persisted messages retrievable by REST but no replay on rejoin.                               | Not implemented as a complete Server recovery contract; stays in TFRS-336.                  |

The newest Server routing-contract PR #86 does not implement this recovery
protocol. Server implementation and its deployment/fault-injection acceptance
remain separate follow-up work; reconnecting successfully does not prove that
all events lost during disconnection were recovered.

## Git delivery boundary

The user authorized commit, push and PR creation, and closing accepted issues.
[PR #103](https://github.com/A2C-SMCP/tf-chat-kit/pull/103) contains the accepted Kit
and optional authentication changes. #46 is accepted for Kit scope; Server work
remains in TFRS-336. Merge, deployment and npm publication are separate follow-ups.
Unrelated `.playwright-mcp/` artifacts remain outside delivery scope.
