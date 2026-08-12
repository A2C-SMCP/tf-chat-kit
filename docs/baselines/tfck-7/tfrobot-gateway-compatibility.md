# TFCK-7 TFRobot Gateway compatibility report

- Status: source/test-derived; current-server Staging partially observed
- Observed: 2026-08-11
- Chat Kit workspace version: post-`0.6.0` development
- TFRobotServer baseline: `2a97c8f4` (`develop`; deployed Staging version unknown)
- TFRobotFront contract witness: `af3b4e2fa8d7a94c458d7c0812435ad17df0eb2e`

## Implemented surface

`@turingfocus/chat-gateway-tfrobot` maps the frozen direct Server contract into
the normalized `ChatGateway` port:

- conversation discovery, history and status REST reads;
- conversation creation, title rename and deletion REST commands;
- text send and run-pinned interrupt commands;
- `/chat` Socket.IO connection and `join_conversation`;
- `chat_message`, `chat_event`, `chat_error`,
  `conversation_state_changed` and unknown-event fallback;
- per-instance authentication, connection, subscription and disposal;
- per-send host identity resolution for TFRobotServer's required `creator`
  object, kept separate from opaque authentication sessions;
- HTTP/Socket DTO validation, structured errors and credential redaction.

The adapter deliberately does not emit the unsupported `leave_conversation`
event. Established subscriptions remain independently owned until their
Runtime subscription is disposed; establishing a candidate subscription does
not disconnect the committed conversation. Only one candidate establishment is
allowed at a time. `join_conversation` uses a Socket.IO acknowledgement and the
subscription is not committed before that acknowledgement succeeds.

Reconnect rejoins first, then performs a deadline-bounded REST status read and
publishes a `run.replace` only when the remembered run state has changed. A
reconnect generation and realtime revision prevent older REST responses from
overwriting newer state. The normalized lifecycle remains `recovering` unless
the join acknowledgement explicitly confirms durable replay completion; a
legacy acknowledgement is never treated as proof that missed events were
recovered. Server-forced disconnects invalidate the host session before one
manual reconnect attempt. The Runtime and Ant Design UI gate commands while the
lifecycle is not `active`.
The production Socket.IO factory pins `transports: ["websocket"]`; polling and
transport fallback are disabled.

Issue #54 adds an explicit `current-server` compatibility profile while
keeping the strict behavior above as the default `verified` profile. The
compatibility profile performs a REST snapshot preflight with the same session
used by Socket connect before accepting an empty initial ACK. Reconnect with an
empty ACK performs backward, bounded REST history rebase to a remembered
identity checkpoint. Page, item and deadline limits, duplicate identities,
conversation disposal and realtime revision supersession are repository-owned
tests. The resulting lifecycle is `degraded` with `complete=false`,
`assurance=best-effort` and `source=rest-rebase`; it never claims durable replay
or recovery of transient `chat_error` events.

Status, send and interrupt responses accept validated `taskId` and legacy
`task_id` aliases. Equal dual fields are accepted, conflicting fields fail
validation, and interrupt requests continue to send the canonical `{taskId}`
body.

The frozen reasoning array shape (`{reasoningContent}`) and the newer
discriminated reasoning entries are both accepted; displayable text is
normalized and opaque fields remain only in sanitized raw metadata. A
`working` status without a real Server `taskId` is represented as running but
cannot be interrupted, so a synthetic normalized ID is never pinned as a
transport cancellation ID.

Conversation discovery uses the frozen Server's forward `count=limit`
direction; message history uses backward `count=-limit` pagination.

## Automated evidence

- `tests/chat-gateway-tfrobot.test.ts` validates REST/Socket DTO mapping,
  tolerant optional fields, malformed payloads, authentication invalidation,
  required outbound creator mapping, sensitive-field removal,
  cross-conversation filtering, replacement subscriptions, multiple Gateway
  instances and disposal. It also covers hanging SessionProvider hooks,
  authentication-time disposal, structured reasoning, explicit Socket
  handshake rejection using the frozen Server's default error, reconnect
  status convergence and stale-response rejection, foreign unknown/error
  events (including malformed payloads), unknown metadata redaction, throwing
  observer isolation, invalid identifiers/states, synchronous transport
  failures, response parsing that crosses its deadline and connections that
  cross their establishment deadline.
- `tests/support/current-server-fixture.ts` and the current-server integration
  cases exercise the production Gateway without mocking it: same-session REST
  preflight, empty/rejected ACKs, camel/snake task IDs, checkpoint rebase,
  persisted messages/events, duplicate suppression, configured bounds,
  deadline, disposal/conversation switch and realtime revision guards.
- `tests/chat-gateway-tfrobot-socket-factory.test.ts` guards the production
  websocket-only transport configuration.
- `tests/chat-gateway-tfrobot-lifecycle.integration.test.ts` uses a real local
  Socket.IO server and client to verify join acknowledgement, server-forced
  disconnect session invalidation, manual reconnect, cursor-bearing recovery
  acknowledgement and return to `active`.
- `tests/chat-gateway-tfrobot-contract.test.ts` runs all framework-neutral
  Gateway contract cases from `@turingfocus/chat-testing` against the real
  adapter through fake REST and Socket.IO transports. The matrix covers
  normalized loading, duplicate/out-of-order/unknown updates, send/interrupt,
  stale interrupt, authentication, disconnect/reconnect with optional run
  convergence, deadlines, late results, cleanup bounds, resource ownership and
  instance isolation.

These tests exercise the production mapper, HTTP client, Socket lifecycle and
Gateway implementation. They do not claim a deployed TFRobotServer connection.

## Issue #54 Staging observation

On 2026-08-11 the repository-private Playground ran the development build
against Staging using `.debug` memory prefill. Credentials and raw headers were
not printed or persisted. The deployed Server commit/version was not exposed
and is recorded as `unknown`.

Observed passes:

- password login, valid authentication, conversation list (`HTTP 200`, eight
  conversations at observation time), existing-conversation load/join and
  reserved Playground test-conversation creation/new-conversation join;
- empty join ACK accepted only after REST preflight, with the UI showing the
  non-blocking best-effort warning and never claiming complete recovery;
- legacy response produced a real interruptible Run and run-pinned interrupt
  completed successfully;
- deliberately invalid credentials returned `HTTP 401`;
- after a browser-forced offline/online cycle, the UI was observed in
  `degraded` again. The probe did not independently capture the transient
  `recovering` sequence, so it does not by itself prove which reconnect branch
  completed. The tracked persisted user message appeared once after recovery:
  observed loss count `0`, duplicate count `0` for that item.

The nonexistent numeric conversation probe returned `HTTP 200` from status but
`HTTP 500` from history. Therefore the current-server preflight failed closed
before Socket join; Staging did not provide the expected `404`. This is a
Server behavior observation, not evidence that nonexistent conversations are
readable.

The test Robot did not produce an assistant message, tool event or `chat_error`
within the observation window, so those three Staging surfaces remain
unverified. The offline window also did not yield a new server-generated
persisted item, so the zero loss/duplicate count above must not be generalized
to all assistant/event recovery. Repository-owned fixtures remain the release
gate for those deterministic cases.

Automation retries before cleanup support was implemented created five
conversations whose titles use the reserved `[tf-chat-kit playground]` prefix.
They were left intact because that earlier run had not yet validated a deletion
contract and this change does not retroactively bulk-delete remote data.

The Server source baseline and deployed browser request witness expose
`PATCH /v1/chat/conversations/{conversationId}` for title changes and
`DELETE /v1/chat/conversations/{conversationId}` for deletion. The Gateway sends
the normalized title in both query and JSON body because the source baseline
reads the query while the deployed Staging request uses JSON. Repository tests
validate both methods, exact response IDs, structured failures and active
Socket cleanup. New Playground automation may rename and delete only a
conversation whose title retains the reserved prefix, and deletes only the
exact ID created by that run.

## Open production gates

TFRS-297 remains open. At the frozen Server baseline, `/chat` checks
`chat:read` during the handshake but does not isolate the browser subscription
surface from legacy/internal producer inbound events. This blocks production
Socket validation and default host cutover.

Before TFCK-7 can be represented as runtime-verified:

1. TFRS-297 must provide producer isolation or event-level authorization plus
   negative Socket integration tests.
2. A controlled environment must identify its deployed Server commit/version.
3. Redacted real REST and browser-facing Socket samples must pass the same
   history, command, reconnect, error and disposal scenarios.
4. The report must be updated with the environment, execution command and
   result; credentials and raw headers must never be recorded.

TFRS-336 is the P0 upstream dependency for access-validated join
acknowledgements and durable cursor/replay/outbox semantics. Until it is
delivered, the frozen legacy Server is below the minimum compatible baseline:
it does not acknowledge the initial `join_conversation`, so a new live
subscription fails closed at its join deadline and no realtime session is
established. An already-established subscription connected through a
transitional Server that acknowledges the initial join but omits reconnect ACK
payloads remains in `recovering` after REST run reconciliation.

TFRS-336 remains the exit gate for the legacy profile, not a package release
gate. Hosts may explicitly use `current-server` with visible degraded semantics
after their own authorization and rollout assessment. The minimum Server for
returning to `verified` must provide an access-validated initial join ACK and a
verified durable cursor/replay/outbox contract before Kit may publish `active`
after reconnect.

Per ADR-009, this external deployment gate does not block publishing the Kit
packages: package release permission continues to derive only from repository
owned compatibility evidence. Until a deployed Server satisfies TFRS-336,
hosts must not represent REST rebase as complete recovery. Production
enablement of `current-server` remains a host-owned rollout decision and must
retain the visible best-effort warning.
