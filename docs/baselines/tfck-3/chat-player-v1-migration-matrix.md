# Chat Player V1 migration matrix

This matrix records TFCK-19 decisions before any public package API is designed. “In” means the behavior belongs in a later Kit package; it does not mean TFCK-3 implements it.

| Current V1 behavior                                                              | Stable semantic                                                                    | Target owner                                                   | Decision                          | Validation for later migration                                                 |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------- | --------------------------------- | ------------------------------------------------------------------------------ |
| List conversations with cursor and optional platform filter                      | Cursor-based conversation discovery                                                | Gateway + Runtime; platform filter stays adapter/host metadata | In                                | Gateway contract test plus host comparison                                     |
| Create, rename and delete conversations                                          | Conversation lifecycle commands                                                    | Gateway + Runtime candidate                                    | Defer after V1                    | Separate backward-compatible command design and host parity                    |
| Platform CRUD and PlatformSelector UI                                            | Robot deployment/configuration workflow                                            | Host                                                           | Out                               | Host regression only                                                           |
| Fetch history with `count=-10` and prepend it                                    | Backward cursor pagination with stable scroll position                             | Gateway + Runtime + React                                      | In                                | Pagination and scroll-anchor integration tests                                 |
| Merge messages and events by `createTimestamp`                                   | One normalized chronological timeline                                              | Protocol + Runtime                                             | In                                | Mixed fixture ordering tests                                                   |
| Group transitions sharing `eventId`                                              | One logical event with ordered transitions and latest state                        | Protocol + Runtime                                             | In                                | Running-to-terminal transition fixtures                                        |
| Preserve Tool `toolCall` and `toolReturn` across transitions                     | Tool execution is a structured event subtype                                       | Protocol                                                       | In                                | Partial/terminal tool event fixtures                                           |
| Accept `running/success/failed/aborted` and tolerate `timeout`                   | Known status plus unknown-safe fallback                                            | Protocol                                                       | Modified                          | Server statuses are canonical; `timeout` is tolerated, not asserted as emitted |
| Receive `chat_message` and `chat_event` after room join                          | Realtime updates scoped to one conversation                                        | Gateway + Runtime                                              | In                                | Reconnect, duplicate and cross-conversation tests                              |
| REST status snapshot on entry/reconnect                                          | Snapshot + event stream convergence                                                | Gateway + Runtime                                              | In                                | Drop/reconnect convergence tests                                               |
| Stop with active run `taskId`                                                    | Stale-safe interrupt command                                                       | Gateway + Runtime                                              | In                                | Old/new task race tests                                                        |
| Discard send response `taskId` and wait eight seconds before status fallback     | Run identity is available immediately, with status fallback only for recovery      | Gateway + Runtime                                              | Replace                           | Send response and recovery timer tests                                         |
| Global Socket singleton keyed only by URL                                        | Per-client instance lifecycle includes endpoint, auth/session and routing identity | Gateway                                                        | Replace                           | Two-host/two-session isolation tests                                           |
| Emit `leave_conversation` although Server has no handler                         | Subscription cleanup must match an implemented transport operation                 | Gateway                                                        | Reject current behavior           | Server-confirmed unsubscribe test before adding an event                       |
| Ignore `chat_error`                                                              | Normalize run errors and surface them to consumers                                 | Gateway + Runtime                                              | Replace                           | Socket error fixture and UI accessibility test                                 |
| Render message text/media/file/contact/url variants                              | Normalized message parts with safe unknown fallback                                | Protocol + React/UI                                            | In                                | Renderer registry fixture matrix                                               |
| Preserve uploaded attachment URI, MIME type and name                             | Candidate already-uploaded resource reference                                      | Protocol candidate                                             | Defer/Split                       | Separate attachment/multipart contract decision and round-trip fixtures        |
| COS upload, reference sync, polling and file-use workflow                        | Host data/source workflow                                                          | Host                                                           | Out                               | Existing host tests                                                            |
| Aggregate non-Tool event transitions into tabs                                   | Optional transition inspection presentation                                        | React/UI                                                       | In, optional                      | Renderer behavior tests                                                        |
| Detect Ask User result in `toolReturn.origin.type`                               | Ask User result is a validated event-renderer extension                            | Protocol + React/UI extension candidate                        | In candidate                      | Answered/cancelled/timeout/failed fixture tests                                |
| Remote Tool namespace, modal, acknowledgement and “chat about this” window event | Candidate standard interaction request plus controlled answer command              | Protocol/Runtime/Gateway candidate; host supplies presentation | Defer/Split                       | Freeze Remote Tool transport before designing a public interaction API         |
| Auto/manual playback, previous/next and slider                                   | Local event selection and follow-latest navigation                                 | React/UI candidate                                             | Defer after V1                    | Separate state-machine and keyboard design                                     |
| Treat playback controls as server replay                                         | No such server semantic exists                                                     | None                                                           | Reject                            | Contract must contain no replay endpoint/event                                 |
| Shell, Editor, Preview, Browser and Download renderers                           | Optional default renderers with host override                                      | `@turingfocus/chat-ui-antd` internal candidates                | In candidates, selection deferred | Real-frequency selection plus lazy-load/fallback tests                         |
| Fallback to Markdown/JSON for unknown events/tools                               | Never crash on unknown protocol data                                               | Protocol + React/UI                                            | In                                | Unknown scene/status/content fixtures                                          |
| Assistant `reasoningContent` is parsed but not rendered                          | Preserve data; product display decision is unresolved                              | Protocol, UI deferred                                          | Defer UI                          | Production-frequency evidence plus UX decision                                 |
| Running event timeout heuristic from a Front environment variable                | Presentation-only stale indicator                                                  | Host/UI option                                                 | Defer                             | Product decision and clock tests                                               |

## V1 scope decisions

### Conversation CRUD

Conversation loading/switching, history pagination, send, status and interrupt are part of the V1 reusable chat workflow. Create/rename/delete remain post-V1 public capability candidates and require a separate backward-compatible command design. Exact query/body quirks stay private to `@turingfocus/chat-gateway-tfrobot`; normalized packages must not expose Server path parameters or camel/snake transport aliases.

Platform management is not general conversation CRUD. It remains a TFRobot host configuration workflow.

### Ask User

Two existing behaviors are deliberately separated:

1. A completed Ask User tool result in history is an `IN` candidate normalized and rendered through an extension.
2. A live interaction request plus controlled answer command is a reusable candidate, but is deferred until the `/remote-tool` transport is frozen and separated from presentation.

The Kit must not make browser `window` events, the current modal implementation or the Remote Tool namespace mandatory for every host. Hosts choose presentation and may draft a new chat message through an explicit command/callback rather than a global event.

### Attachments

Attachment and multipart standardization is deferred/split from the V1 text-send slice. A later protocol may preserve already-uploaded attachment/resource references, but TFCK-3 does not predeclare its model or command. Upload credentials, COS endpoints, source synchronization, polling and “reference versus send alone” policy remain outside the Kit.

### Replay

V1 “playback” is local navigation over received event groups. It does not request historical execution from Server and must not create a replay protocol. The UI capability is deferred beyond the V1 vertical slice and requires a separate event-selection state-machine decision.

### Heavy renderers

The core UI provides lightweight built-ins, extension registration and safe fallback. Based on real event frequency, selected Shell, Editor, Preview, Browser and Download implementations enter `@turingfocus/chat-ui-antd` as internal lazy-loaded modules; hosts may override or omit them. They remain inside `ui-antd` until a real independent installation or version lifecycle justifies another package.

## Compatibility rules

- Preserve observable stable semantics, not accidental singleton, timer or unsupported-event behavior.
- Prefer normalized discriminated models and keep raw data only as an escape hatch.
- Unknown message types, event scenes, statuses and tool payloads render safely.
- Authentication material and host cookies are injected by a `SessionProvider`; they never enter React component props or persisted Kit state.
- Migration must support old and new host paths during an explicit compatibility window, with no silent fallback to local storage credentials.
