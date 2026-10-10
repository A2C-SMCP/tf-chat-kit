# Issue 97: Manager quick-chat creation

Source: https://github.com/A2C-SMCP/tf-chat-kit/issues/97 and its 2026-10-09
consumer acceptance correction, incorporating duplicate #102. Baseline:
`dev-0.8.3` / `6e10d6d06426d3cc2d0b19e4e829d007cd4ca17d` plus the locally
accepted #46/#92–#96 work. User authorization covers implementation and
acceptance of the remaining issues in dependency order.

## Scope and reuse

Manager quick chat already mounts the same private PlaygroundWorkspace as the
full debugging module. The public compact navigation already supports new
conversation and history actions. The private workspace already owns the modal,
in-flight protection, session-generation guard, test conversation prefix and
precise owned-ID cleanup. The quick experience omitted this navigation config.

Pass the existing compact navigation to both experiences. Keep identity/directory
and Chat Kit modules independent and keep Manager token exchange in the host.
No Protocol/Runtime/public UI API or package dependency changes are required.
No manual admin or RobotServer token entry is added to Manager quick chat.
Quick chat now uses the same compact new/history header as the full workspace;
history remains available through its dropdown rather than the previous sidebar.
The existing automatic-connection/retry regression verifies that dropdown content
instead of asserting the superseded sidebar markup.

## Verification plan

- Mount the real Manager Playground path and drive login and quick-chat creation.
- Use actual local HTTP and Socket.IO for Manager authentication, connection-info,
  token exchange and RobotServer conversation operations; synthetic credentials
  only, no production-service compatibility claim.
- Cover existing and empty lists, create failure, retry and identity disposal
  during an outstanding creation. Verify new selection and rejection of old
  results, absence of messages in pre-existing conversations, expected title
  prefix and cleanup restricted to created IDs.
- Run focused tests, types/lint/format/build and an isolated full-scope review.
- Final browser consumer regression follows the #99 fixture correction. The
  production BFF path and historical direct issuer mismatch remain separate.

## Evidence

The new real local HTTP/Socket.IO test passes all four scenarios: existing list,
empty list, failed creation followed by retry, and logout during held creation.
Manager protected routes and RobotServer HTTP/Socket reject incorrect credentials.
The test confirms automatic Token Exchange, selected new conversation, title
prefix, no writes to business conversations, stale UI rejection and cleanup of
only created ID 42. It waits for actual ChatClient disposal before closing the
fixture, rather than treating an early session-disposed flag as cleanup completion.

Negative control: temporarily omitting quick compact navigation makes all four
scenarios fail because the new-conversation button is absent; the final change
was restored and the test rerun passed. Four directed Playground files pass 55
tests, including creation deduplication/session replacement and connection retry.
Full type checks, targeted lint, format/diff checks and Playground build pass.
The isolated full-scope review approved these changes with no blockers or
suggestions. Final Chromium regression now passes the Manager quick-create,
send/realtime reply and logout-cleanup scenario alongside all 14 other browser
cases. Real-service acceptance is still pending.

Status: local and real BFF regression acceptance and review passed; delivery pending. No commit, push,
publication or issue closure had been performed at the acceptance stage.

## Real BFF creation follow-up

After Playwright restart and direct user login, UI creation returned 200 and a
new independently sendable conversation, but its title was empty. The Gateway's
legacy direct request places title in the query; deployed Front BFF creation reads
JSON. The private Playground proxy now adapts only empty-body Front BFF creation
requests to JSON title and an optional already-supplied platformId. Direct Server
requests and explicit bodies retain their existing contract; no platform value is
invented and no external repository or public API changes.

A real local HTTP BFF test verifies the prefixed route and returned title with
and without an explicit platform. The follow-up is included in the 37 passing
directed tests. Hot update cleared the in-memory user session; re-login and real
creation/cleanup revalidation are pending. Owned conversation 27 is recorded for
precise cleanup, without taking ownership of any existing business conversation.

## Final real BFF acceptance

After re-login, conversation 28 was created with response 200 and the reserved
Playground title prefix. Full pagination confirmed that title on the persisted
conversation. Sending and a live assistant Socket reply passed, including another
send/reply after 401 recovery; both test messages remained unique after recovery.

The real cleanup run exposed a proxy method guard using the rewritten BFF path
instead of the validated logical path. The guard now checks the validated route
before BFF prefix mapping. The actual local HTTP BFF test verifies PATCH/DELETE
on exact conversation items and continued 405 rejection of collection DELETE and
nested message PATCH. Seven proxy tests passed, and a fresh isolated full-scope
review approved with no findings.

Old test-owned IDs 27/28 were deleted in their verified original routing scope,
with matching 200/code 200 response IDs. A new UI-created ID 29 retained its title
and was automatically deleted on logout with matching 200/code 200. After saved-
credential re-login, complete conversation pagination verified IDs 27/28/29 absent.
Real #97 regression acceptance passed. The final serial whole-project gate after the method repair passed with exit 0:
79 files / 1,424 tests, static checks, build and packed artifacts. All 27 collected
browser scenarios have passing evidence (23 local, four WebKit in the documented
container environment). Commit/push/PR creation was authorized on 2026-10-10; scoped issue closure follows
verified remote delivery.
