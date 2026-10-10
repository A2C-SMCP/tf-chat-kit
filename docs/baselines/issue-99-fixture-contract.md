# Issue 99: approximate RobotServer contract

Source: https://github.com/A2C-SMCP/tf-chat-kit/issues/99 and its September 22
correction. The corrected scope is repository-local fixture compatibility, not a
production authentication repair. User authorization covers the remaining issue
implementation and acceptance. No public package API or external repository is
changed.

## Contract and plan

The September 22 correction records deployed `GET conversations?count=20`
returning 200 with admin-token authentication and no `platformId`; it attributes
the separate staging/production issuer mismatch to #97. Allow the fixture's authenticated, routed list/create
requests to omit that parameter. Preserve the existing explicit `platform-e2e`
manual path and reject unsupported explicit fixture platforms. This is a legacy
query-based creation fixture, not a claim of universal RobotServer compatibility.

Read-only inspection of TFRobotServer HEAD
`02a4a85c85a631436d9435814e1ee8cb1ec2b36c` confirms its list parameter is optional,
but its newer creation endpoint requires a JSON DTO with title and platformId.
That creation contract differs from this Kit gateway's deployed legacy query
contract. The sibling worktree also has edits; no sibling file is changed here.
Newer-server creation compatibility needs separate contract agreement and real
acceptance before it can be claimed.

Reuse the existing real HTTP/Socket.IO fixture and Chromium Manager scenario.
Accept the known Manager creator tuple under Bearer authentication, alongside
the existing manual creator tuple; keep credential and routing validation.
Exercise browser exchange, list, quick-create, send, realtime reply and logout
cleanup. Assert no platformId is injected, the original conversation survives,
test conversations disappear, sockets close and tokens are not persisted.
Run manual Bearer/Admin/password browser regressions and isolated review.

## Acceptance evidence

All 15 Chromium scenarios pass, including the complete Manager exchange/list/
quick-create/send/realtime/logout path, retained manual Bearer/Admin/password
paths and four debug-prefill cases. A real HTTP contract case verifies omitted
and supported explicit platforms, unsupported-platform rejection, authentication,
routing and exact-ID cleanup. No RobotServer HTTP or Socket response is intercepted
in the Manager scenario; Manager responses are controlled browser fixtures.
The existing Mock login helper used an obsolete field label; it now locates the
current public default label and retains its login/logout assertions.

The final isolated full-scope review approved the change with no blockers.

The final whole-project `pnpm check` passes: 79 files / 1,415 tests, static
checks, Playground build, all packed consumers and artifact security checks.

Status: local browser acceptance, isolated review and final gate passed; delivery pending.
Fixture success cannot close
the real Manager/BFF/RobotServer acceptance gate.
