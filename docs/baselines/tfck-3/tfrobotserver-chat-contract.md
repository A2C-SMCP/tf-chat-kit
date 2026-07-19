# TFRobotServer chat contract baseline

This document freezes the implemented TFRobotServer chat contract used as input to TFCK-21. The structured examples live in [`tfrobotserver-chat-contract.json`](../../../fixtures/tfck-3/v1/tfrobotserver-chat-contract.json).

## Evidence level

The baseline is derived from TFRobotServer `origin/develop` at `d085c12dd8f603477dfb445bc5f5b0fd099caf15` (`0.3.0-dev7`), its integration/unit tests, the active TFRobotFront production caller at `af3b4e2fa8d7a94c458d7c0812435ad17df0eb2e`, and completed authentication Jira work. Every implemented REST route and every cross-confirmed Socket event has Server source plus Server-test or Front-caller support. Source-only Socket events are explicitly marked and deferred with an owner and required verification. No live deployment capture is claimed, so the baseline is explicitly source/test-derived rather than runtime-verified.

## Ownership and topology

- TFRobotServer owns REST paths, Socket.IO namespace/events, authorization scopes, DTO serialization and server error behavior.
- TFRobotFront owns its BFF/cookie/routing behavior. `/api/v1/chat/**`, `/api/utils/socketio`, `X-TF-Namespace`, `X-TF-RobotId` and path-prefix routing are host integration details, not direct Server chat endpoints.
- `tf-chat-kit` Gateway will eventually adapt the Server contract to normalized Kit semantics. This baseline does not introduce that API.

## Authentication and authorization

| Surface            | Canonical credentials                                                   | Authorization                                                                                                    |
| ------------------ | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| HTTP `/v1/chat/**` | `Authorization: Bearer <user JWT>` or `admin_key: <AdminToken>`         | GET requires `chat:read`; non-GET requires `chat:send`; `robot:admin` and a valid AdminToken are superuser paths |
| Socket.IO `/chat`  | connection `auth.token` for user JWT or `auth.admin_key` for AdminToken | user JWT requires `chat:read`; AdminToken is superuser                                                           |

For user JWTs, Server validates RS256 signature, issuer, audience and expiry. Socket connections additionally require a valid `iat`, register the connection for epoch revocation, and can be disconnected after a break-glass epoch change. `Authorization: Bearer` may be accepted as a Server-internal Socket fallback, but is explicitly not the public Socket contract. Private `admin_key` Socket headers and Redis `access_token` are retired.

Credentials and raw headers must never be stored in fixtures or diagnostic output. Current Server source still logs the Socket `auth` object and some exception-handler request headers; this is a security follow-up, not behavior to copy into the Kit.

## REST endpoints

All direct Server endpoints use prefix `/v1/chat`. Successful responses use `{ "code": 200, "message": "Success", "data": ... }` with camel-case DTO fields.

| Method and path                                  | Input                                      | Success data                         | Scope       |
| ------------------------------------------------ | ------------------------------------------ | ------------------------------------ | ----------- |
| `GET /platforms`                                 | none                                       | `Platform[] \| null`                 | `chat:read` |
| `POST /platforms`                                | JSON `{platformName}`                      | numeric platform ID                  | `chat:send` |
| `PUT /platforms/{platformId}`                    | JSON `{platformName}`                      | `null`                               | `chat:send` |
| `DELETE /platforms/{platformId}`                 | path ID                                    | `null`                               | `chat:send` |
| `GET /conversations`                             | query `count=10`, `cursor?`, `platformId?` | `{conversations,cursor}`             | `chat:read` |
| `POST /conversations`                            | query `title`, `platformId?`               | conversation                         | `chat:send` |
| `PATCH /conversations/{conversationId}`          | query `title`                              | conversation                         | `chat:send` |
| `DELETE /conversations/{conversationId}`         | path ID                                    | `{message,conversationId}`           | `chat:send` |
| `GET /conversations/{conversationId}/messages`   | query `count=-10`, `cursor?`               | `{messages,events,cursor}`           | `chat:read` |
| `POST /conversations/{conversationId}/messages`  | JSON discriminated message DTO             | `{taskId}` for the run task          | `chat:send` |
| `GET /conversations/{conversationId}/status`     | path ID                                    | `{working,taskId}`                   | `chat:read` |
| `POST /conversations/{conversationId}/interrupt` | optional JSON `{taskId?}`                  | `{taskId}` for the cancellation task | `chat:send` |

Important adapter rules:

- Conversation and route IDs are integer path parameters on Server, while serialized DTO IDs allow string or number. The normalized Kit model must not leak this transport inconsistency.
- Negative message `count` means backward pagination. Returned events are selected over the same cursor window as messages.
- Server overwrites a submitted message's `createTimestamp` with Server time before dispatch so message/event ordering does not depend on the client clock.
- The send response `taskId` identifies the run. The interrupt response `taskId` identifies the cancellation task, not the interrupted run.
- A supplied interrupt `taskId` is compared with the active run to prevent a stale stop request from cancelling a later turn.
- TFRobotFront currently parses the send response as an empty object, discarding `taskId`; this is caller compatibility debt, not Server contract.

## Socket.IO contract

- Engine path: `/socket.io` unless a deployment gateway routes an instance-specific path.
- Namespace: `/chat`.
- Subscription: browser emits `join_conversation` with `{conversation_id}` and is entered into that room.
- There is no implemented `leave_conversation` handler. The current Front emits it, but Server ignores it; rooms are left on disconnect.
- Reconnect requires rejoining the room and refreshing the REST status snapshot.

### Server-to-browser events

| Event                        | Payload                                  | Evidence and notes                                                                                                              |
| ---------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `chat_message`               | message DTO                              | Server source + integration test + active Front caller; may be a user or assistant message                                      |
| `chat_event`                 | event transition DTO                     | Server source + active Front caller; includes IDs, status, scene, timestamp, content and optional exception                     |
| `chat_error`                 | `{conversationId,error,createTimestamp}` | Server source + robot-run unit test; current Front does not listen, so consumer validation is deferred to TFCK-37               |
| `conversation_state_changed` | `{conversationId,state,taskId?}`         | Server source + namespace unit test + active Front caller; state is `working` or `idle`                                         |
| `error`                      | `{status:"error",message}`               | Server source only; negative integration coverage is deferred to TFRS-297 and blocks production validation, not baseline freeze |

### Implemented inbound handler exposure

The namespace handshake checks `chat:read` only. The frozen Server explicitly leaves per-event authorization to a later phase, and Python Socket.IO exposes every `on_<event>` method as an inbound handler. There is no producer identity check after connection.

| Inbound event                | Intended caller            | Implemented authorization  | Supported browser contract                               |
| ---------------------------- | -------------------------- | -------------------------- | -------------------------------------------------------- |
| `join_conversation`          | Browser                    | Handshake `chat:read` only | Yes                                                      |
| `chat_message`               | Legacy/browser test client | Handshake `chat:read` only | No; legacy echo remains reachable and is a security gate |
| `chat_event`                 | Worker                     | Handshake `chat:read` only | No, but currently reachable                              |
| `chat_error`                 | Worker                     | Handshake `chat:read` only | No, but currently reachable                              |
| `conversation_state_changed` | Worker                     | Handshake `chat:read` only | No, but currently reachable                              |

All inbound events have event-level evidence in the fixture and are cross-confirmed by Server tests and, where applicable, the active Front caller. Evidence that `chat_event` forwards its DTO does not prove that a browser principal is forbidden from invoking it: the negative authorization test and producer isolation remain a separate TFRS-297 security gate.

Consequently, any principal that can establish `/chat` with `chat:read` can currently attempt to inject room messages, events, errors or state changes. This is a frozen security exposure, not an API recommendation. `TFCK-21-SOCKET-AUTHZ-01` covers the legacy message echo and worker-facing ingress. [TFRS-297](https://turingfocus.atlassian.net/browse/TFRS-297) owns the Server fix and blocks TFCK-7/TFCK-37 production validation; the known exposure does not block TFCK-21 from freezing the contract that exists. A future Kit Gateway must never expose these non-public emits as consumer commands.

Implemented Server event statuses are `running`, `success`, `failed` and `aborted`. The current Front also recognizes `timeout`; Server source does not currently emit that value, so it is a tolerant-reader extension rather than frozen Server truth.

`docs/design/socketio-streaming-design.md` proposes `chat_stream_*` events but no matching handlers or emitters exist at the frozen revision. Those names are rejected from this contract.

## DTO preservation rules

- Preserve `raw`/unknown data for forward compatibility, but never use raw data as the primary normalized model.
- Messages carry `role`, `msgType`, IDs, timestamps, creator, `additionalKwargs` and optional attachments.
- User message types include text, audio, contact, file, image, video, URL, history and multipart. The currently implemented assistant conversion supports text; other assistant enum members are not proof of live serialization.
- Multipart parts include text, image URL, video URL, audio URL and PDF URL.
- Assistant text can include `reasoningContent`; current production rendering frequency and desired UI treatment remain unknown.
- Tool events merge `toolCall` and optional `toolReturn`. `toolReturn.origin` is intentionally open data and must be guarded by renderer-specific validation.

## Error baseline

| Condition                                        | HTTP/Socket result                                             | Evidence status                                         |
| ------------------------------------------------ | -------------------------------------------------------------- | ------------------------------------------------------- |
| Missing or invalid HTTP credential               | HTTP `401`, `{detail:"Could not validate credentials"}`        | Source-derived                                          |
| Valid user JWT without required scope            | HTTP `403`, `{detail:"Insufficient scope"}`                    | Source-derived                                          |
| FastAPI path/query/body validation               | HTTP `422`, FastAPI `detail` array                             | Framework/source-derived; exact deployment sample open  |
| Unmapped authorization rule                      | HTTP `403`, `{detail:"Could not validate credentials"}`        | Source-derived fail-closed behavior                     |
| Unhandled domain/server failure                  | HTTP `500`, TFS envelope whose message may contain `repr(exc)` | Source-derived risk; exact cases open                   |
| Socket handshake rejection                       | namespace connection failure                                   | Server tests                                            |
| Invalid browser `chat_message` or internal event | Socket `error` payload                                         | Server source; incomplete integration coverage          |
| Robot run failure                                | Socket `chat_error` payload                                    | DTO/unit evidence; browser integration coverage missing |

## Deferred runtime and production questions

- `TFCK-21-LIVE-01` → TFCK-37: identify a deployed environment, prove its Server revision/version and capture redacted real examples for conversations, history, send, status, interrupt and browser-facing Socket events.
- `TFCK-21-ERR-01` → TFCK-37: confirm domain-specific 404/422/500 behavior for missing conversations, platforms and run failures.
- TFRS-297: close `TFCK-21-SOCKET-AUTHZ-01` with Server-owned producer isolation or event-level authorization and negative regression tests.
- Confirm whether a future server-supported room leave/unsubscribe operation is required.
- Confirm real frequency and maximum size for event transitions, `reasoningContent`, multipart messages and tool-return payloads.
- Remove or redact credential-bearing Server logs in the owning repository.

These questions prevent a runtime-verified compatibility claim and production cutover. They do not invalidate the source/test-derived TFCK-21 contract freeze.
