# TFCK-7 TFRobot Gateway compatibility report

- Status: source/test-derived; production runtime validation blocked
- Observed: 2026-07-27
- Chat Kit workspace version: `0.1.0`
- TFRobotServer baseline: `d085c12dd8f603477dfb445bc5f5b0fd099caf15` (`0.3.0-dev7`)
- TFRobotFront contract witness: `af3b4e2fa8d7a94c458d7c0812435ad17df0eb2e`

## Implemented surface

`@turingfocus/chat-gateway-tfrobot` maps the frozen direct Server contract into
the normalized `ChatGateway` port:

- conversation discovery, history and status REST reads;
- text send and run-pinned interrupt commands;
- `/chat` Socket.IO connection and `join_conversation`;
- `chat_message`, `chat_event`, `chat_error`,
  `conversation_state_changed` and unknown-event fallback;
- per-instance authentication, connection, subscription and disposal;
- per-send host identity resolution for TFRobotServer's required `creator`
  object, kept separate from opaque authentication sessions;
- HTTP/Socket DTO validation, structured errors and credential redaction.

The adapter deliberately does not emit the unsupported `leave_conversation`
event. Replacing a subscription disconnects the old instance-owned connection
before connecting and joining the new conversation. Reconnect rejoins first,
then performs a deadline-bounded REST status read and publishes a `run.replace`
only when the remembered run state has changed. A reconnect generation and
realtime revision prevent older REST responses from overwriting newer state.
The production Socket.IO factory pins `transports: ["websocket"]`; polling and
transport fallback are disabled.

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
- `tests/chat-gateway-tfrobot-socket-factory.test.ts` guards the production
  websocket-only transport configuration.
- `tests/chat-gateway-tfrobot-contract.test.ts` runs all framework-neutral
  Gateway contract cases from `@turingfocus/chat-testing` against the real
  adapter through fake REST and Socket.IO transports. The matrix covers
  normalized loading, duplicate/out-of-order/unknown updates, send/interrupt,
  stale interrupt, authentication, disconnect/reconnect with optional run
  convergence, deadlines, late results, cleanup bounds, resource ownership and
  instance isolation.

These tests exercise the production mapper, HTTP client, Socket lifecycle and
Gateway implementation. They do not claim a deployed TFRobotServer connection.

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
