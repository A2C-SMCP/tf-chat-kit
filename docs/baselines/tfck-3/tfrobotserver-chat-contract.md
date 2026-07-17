# TFRobotServer chat contract baseline

This document freezes the implemented TFRobotServer chat contract used as input to TFCK-21. The structured examples live in [`tfrobotserver-chat-contract.json`](../../../fixtures/tfck-3/v1/tfrobotserver-chat-contract.json).

## Evidence level

The baseline is derived from TFRobotServer `origin/develop` at `d085c12dd8f603477dfb445bc5f5b0fd099caf15` (`0.3.0-dev7`), its integration/unit tests, the current TFRobotFront caller at `af3b4e2fa8d7a94c458d7c0812435ad17df0eb2e`, and completed authentication Jira work. No live deployment was available, so examples are redacted source/test fixtures rather than claimed production captures.

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

| Event                        | Payload                                  | Notes                                                                                                   |
| ---------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `chat_message`               | message DTO                              | May be a user or assistant message                                                                      |
| `chat_event`                 | event transition DTO                     | `eventId`, `status`, `eventScene`, `conversationId`, `createTimestamp`, `content`, optional `exception` |
| `chat_error`                 | `{conversationId,error,createTimestamp}` | Robot execution error; current Front does not listen for it                                             |
| `conversation_state_changed` | `{conversationId,state,taskId?}`         | state is `working` or `idle`                                                                            |
| `error`                      | `{status:"error",message}`               | Namespace validation/forwarding error sent to one Socket client                                         |

### Implemented inbound handler exposure

The namespace handshake checks `chat:read` only. The frozen Server explicitly leaves per-event authorization to a later phase, and Python Socket.IO exposes every `on_<event>` method as an inbound handler. There is no producer identity check after connection.

| Inbound event                | Intended caller            | Implemented authorization  | Supported browser contract                               |
| ---------------------------- | -------------------------- | -------------------------- | -------------------------------------------------------- |
| `join_conversation`          | Browser                    | Handshake `chat:read` only | Yes                                                      |
| `chat_message`               | Legacy/browser test client | Handshake `chat:read` only | No; legacy echo remains reachable and is a security gate |
| `chat_event`                 | Worker                     | Handshake `chat:read` only | No, but currently reachable                              |
| `chat_error`                 | Worker                     | Handshake `chat:read` only | No, but currently reachable                              |
| `conversation_state_changed` | Worker                     | Handshake `chat:read` only | No, but currently reachable                              |

Consequently, any principal that can establish `/chat` with `chat:read` can currently attempt to inject room messages, events, errors or state changes. This is a frozen security exposure, not an API recommendation. `TFCK-21-SOCKET-AUTHZ-01` covers the legacy message echo and worker-facing ingress; it remains blocking until TFRobotServer removes or appropriately authorizes the legacy echo and separates producer transport/namespace or adds per-event authorization. A future Kit Gateway must never expose these non-public emits as consumer commands.

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

## Open contract questions

- Identify a deployed environment and prove its Server revision/version.
- Capture redacted real examples for conversations, history, send, status, interrupt and all browser-facing Socket events.
- Confirm domain-specific 404/500 behavior for missing conversations and platforms.
- Close `TFCK-21-SOCKET-AUTHZ-01` with Server-owned producer isolation or event-level authorization and regression tests.
- Confirm whether a future server-supported room leave/unsubscribe operation is required.
- Confirm real frequency and maximum size for event transitions, `reasoningContent`, multipart messages and tool-return payloads.
- Remove or redact credential-bearing Server logs in the owning repository.
