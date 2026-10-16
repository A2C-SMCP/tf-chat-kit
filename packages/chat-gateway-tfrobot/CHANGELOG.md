# @turingfocus/chat-gateway-tfrobot

## 0.10.0

### Minor Changes

- 1e43425: Display realtime and persisted conversation failures with safe business explanations and authoritative original text. Allow users to restore text into the composer with overwrite confirmation, without resending or treating conversation errors as current-run outcomes. Legacy transports without shared error identities retain separate realtime observations and history records.
- 55b4248: Correlate user messages by the Server's elementId across POST receipts, realtime,
  history and cache, independently of author display and database persistence.
  Expose instance-local outgoing send observations with accepted, failed and unknown
  outcomes and render them outside the formal timeline. Preserve legacy Server
  compatibility and never replay sends from cache. Full POST promotion metadata and
  correlated business terminal states still require the Server contracts tracked in #141.
- 55b4248: Expose explicit auth subentries through chat-kit so hosts can install one facade while chat-auth retains its independent version. Add explicit JSON conversation creation and Server platform discovery, with validated platform selection and lifecycle isolation in Manager integrations.

### Patch Changes

- 55b4248: Reconcile mutable author names and avatars independently from current-server user-message identity. Keep historical author updates across cache reads, pagination, concurrent loads and reconnects without overwriting newer message content. Add optional message provenance and author-only recovery updates. Preserve unassociated provisional messages and show them in an expandable review section in the default UI; never alias different user IDs or claim complete current-server recovery.
- Updated dependencies [1e43425]
- Updated dependencies [55b4248]
- Updated dependencies [55b4248]
  - @turingfocus/chat-protocol@0.10.0

## 0.10.0-next.5

### Minor Changes

- 1e43425: Display realtime and persisted conversation failures with safe business explanations and authoritative original text. Allow users to restore text into the composer with overwrite confirmation, without resending or treating conversation errors as current-run outcomes. Legacy transports without shared error identities retain separate realtime observations and history records.

### Patch Changes

- Updated dependencies [1e43425]
  - @turingfocus/chat-protocol@0.10.0-next.5

## 0.10.0-next.4

### Patch Changes

- @turingfocus/chat-protocol@0.10.0-next.4

## 0.10.0-next.3

### Minor Changes

- 473865d: Correlate user messages by the Server's elementId across POST receipts, realtime,
  history and cache, independently of author display and database persistence.
  Expose instance-local outgoing send observations with accepted, failed and unknown
  outcomes and render them outside the formal timeline. Preserve legacy Server
  compatibility and never replay sends from cache. Full POST promotion metadata and
  correlated business terminal states still require the Server contracts tracked in #141.

### Patch Changes

- Updated dependencies [473865d]
  - @turingfocus/chat-protocol@0.10.0-next.3

## 0.10.0-next.2

### Patch Changes

- ba54e24: Reconcile mutable author names and avatars independently from current-server user-message identity. Keep historical author updates across cache reads, pagination, concurrent loads and reconnects without overwriting newer message content. Add optional message provenance and author-only recovery updates. Preserve unassociated provisional messages and show them in an expandable review section in the default UI; never alias different user IDs or claim complete current-server recovery.
- Updated dependencies [ba54e24]
  - @turingfocus/chat-protocol@0.10.0-next.2

## 0.10.0-next.1

### Patch Changes

- @turingfocus/chat-protocol@0.10.0-next.1

## 0.10.0-next.0

### Minor Changes

- 04ffac1: Expose explicit auth subentries through chat-kit so hosts can install one facade while chat-auth retains its independent version. Add explicit JSON conversation creation and Server platform discovery, with validated platform selection and lifecycle isolation in Manager integrations.

### Patch Changes

- @turingfocus/chat-protocol@0.10.0-next.0

## 0.9.0

### Patch Changes

- @turingfocus/chat-protocol@0.9.0

## 0.8.4

### Patch Changes

- e84b101: Preserve the reached Socket establishment phase when a conversation join times out, regardless of which deadline timer fires first. Cleanup still rejects late acknowledgements and disconnects the failed subscription.
  - @turingfocus/chat-protocol@0.8.4

## 0.8.3

### Patch Changes

- da5b4f0: Retry once with a freshly resolved session when the server rejects the
  credential with 401. The rejected session is invalidated on the provider, so a
  short-lived token that expired between requests no longer surfaces as a failed
  operation. Repeated rejection returns the original error and never loops.
- 92ac1da: Invoke a host-provided `fetch` without a foreign receiver so browsers stop
  rejecting gateway requests with `Illegal invocation` before they leave the page.
- 0a0be31: Retry current-server subscription preflight once after an HTTP 401, reusing the
  refreshed credential for REST validation and the Socket handshake. Bound pinned
  credential invalidation by the subscription deadline.

  Reconcile current-server provisional user message identities with persisted
  history across realtime delivery and subscription handoff, retaining distinct
  database IDs and clearing correlation state with its Gateway instance.
  Allow confirmed Server processing fields to be added during persistence without
  duplicating the user message, while retaining existing-value conflicts and
  ambiguous identities.
  - @turingfocus/chat-protocol@0.8.3

## 0.8.2

### Patch Changes

- fdceb0a: Add an optional Headless RemoteTool provider with typed host handlers, registration acknowledgement, reconnect registration, bounded execution and cooperative cancellation. Report same-name registration conflicts explicitly. Add a built-in Ask User tool with conversation cards, draft preservation, validated answers and terminal feedback. Hosts supply trusted request-to-conversation routing; the current Server does not provide that routing automatically.
- dd97f1c: Reuse healthy instance-local Socket.IO connections across conversation switches while preserving per-subscription cleanup, authentication isolation and recovery assurance. Current-server connections retain visited server rooms until disconnect; the Gateway filters foreign and ambiguous unscoped events after switching.
- 5b41649: Add bounded per-instance diagnostics with safe transport metadata and operation correlation. Reduce connection and cache notice interruptions, keep blocking failures visible, and provide scoped copyable diagnostics and local command failures without changing connection or cache authority.
- Updated dependencies [f1772a0]
- Updated dependencies [fdceb0a]
- Updated dependencies [5b41649]
  - @turingfocus/chat-protocol@0.8.2

## 0.8.1

### Patch Changes

- Updated dependencies [e3ba706]
  - @turingfocus/chat-protocol@0.8.1

## 0.8.0

### Minor Changes

- a83c4e3: Add host-agnostic attachment messages, conversation-scoped composer drafts,
  zero-extra-config TFRobot uploads, Ant Design file and long-paste interactions,
  and non-TFRobotFront consumer coverage.
- 358dd28: Add normalized tool presentations, host-injected resource and document ports, media and Markdown
  display, read-only code and terminal details, local event navigation and received-result inspection.
  Preserve existing transport and Ask User contracts and validate independent packed consumers.

### Patch Changes

- a917eba: Keep historical conversations readable when tool results exceed diagnostic raw limits. Redact transport payloads independently from diagnostic retention, preserve normal page content, and replace oversized tool details with an explicit omission explanation. Apply the same handling to realtime events and report transport structure limits without misclassifying valid response envelopes.
- Updated dependencies [a83c4e3]
- Updated dependencies [358dd28]
  - @turingfocus/chat-protocol@0.8.0

## 0.7.0

### Minor Changes

- 93183e0: Add an explicit current TFRobotServer compatibility profile with validated legacy task IDs, same-session REST preflight, bounded best-effort reconnect rebase, and operable degraded lifecycle semantics while preserving the strict verified profile by default. Also add optional conversation rename and delete commands across Protocol, TFRobot Gateway, Runtime, React, Ant Design UI, testing, and the repository Playground, including active-snapshot retirement, an additive empty-state subscription, confirmation, and reserved-prefix cleanup guards.

### Patch Changes

- Updated dependencies [93183e0]
  - @turingfocus/chat-protocol@0.7.0

## 0.6.0

### Minor Changes

- 91a29e5: Add conversation lifecycle state, independently resolvable error occurrences,
  atomic TFRobot subscription handoff, acknowledged Socket.IO joins, verified
  reconnect recovery gating, and lifecycle-aware command controls.

### Patch Changes

- Updated dependencies [91a29e5]
  - @turingfocus/chat-protocol@0.6.0

## 0.5.0

### Patch Changes

- c22f4c9: Add compact navigation mode to `ChatUiShell` (inline conversation title, new-conversation trigger, and history dropdown that reuses the workspace's loading/paging/error/selection handling) and make `sendTextDtoSchema.taskId` optional so accepted TFRobot responses without a `taskId` no longer report a false validation error.
  - @turingfocus/chat-protocol@0.5.0

## 0.4.2

### Patch Changes

- @turingfocus/chat-protocol@0.4.2

## 0.4.1

### Patch Changes

- @turingfocus/chat-protocol@0.4.1

## 0.4.0

### Patch Changes

- @turingfocus/chat-protocol@0.4.0

## 0.3.0

### Minor Changes

- 2cff6fd: Handle TFRobot event transitions whose per-transition timestamps change without treating them as conflicting immutable event metadata.

  `AgentEventTransitionPayload.createdAt` is now optional. Gateway consumers that
  read this field directly must handle `undefined`; Runtime derives a stable event
  creation time from the first accepted transition when the transport omits it.

### Patch Changes

- Updated dependencies [2cff6fd]
  - @turingfocus/chat-protocol@0.3.0

## 0.2.0

### Minor Changes

- ce9d465: Add authenticated RobotServer conversation creation with validated DTO mapping
  and immediate Gateway cache integration.

### Patch Changes

- 8bc0f44: Preserve RobotServer conversation identifier types when sending messages after normalizing public Chat Kit IDs.
- ce9d465: Preserve the required browser receiver when the Gateway uses the global Fetch API,
  and redact the exact active Bearer or Admin credential from HTTP and Socket
  responses, realtime payloads, and diagnostics even when a server echoes an opaque
  value without a credential label.
- Updated dependencies [ce9d465]
  - @turingfocus/chat-protocol@0.2.0

## 0.1.0

### Minor Changes

- bc4606a: Add conversation-scoped Ask User request, answer, result, capability, update,
  and optional Gateway contracts. Runtime now protects answers against stale
  requests, invalid question/value combinations, conversation switches,
  replacement requests (including new immutable revisions that reuse an ID), and
  disposal. Answers and acknowledgements carry the request revision end to end,
  and Runtime prevents delayed updates from reviving recently retired revisions,
  while the memory Gateway exposes deterministic interaction controls.

  Normalize historical TFRobot Ask User Tool results without enabling the unsafe
  live remote-tool route. Add sanitized GFM Markdown, explicit failed-event
  presentation, bounded normalized Tool-result and Ask User history rendering,
  and a controlled Ant Design Ask User form with per-question host discussion
  callbacks, index-isolated form state, request-scoped failures, and per-renderer
  failure isolation. Protocol-wide question, option, answer, ID, and text budgets
  bound pending interactions from every Gateway.

- ea06213: Add the instance-scoped TFRobotServer REST and Socket.IO Gateway with runtime DTO validation, short-lived SessionProvider authentication, normalized history/realtime/command mapping, deadline and stale-interrupt safety, reconnect and disposal ownership, unknown-event fallback, and credential redaction.

  Allow Gateway contract implementations to emit a subscribed-conversation run
  convergence update while recovering their original live subscription.

### Patch Changes

- 9547bea: Adopt the MIT license, npm public registry metadata, and GitHub source provenance for all packages.
- 6c6ab42: Move the unpublished public package family to the verified `@turingfocus` npm organization.
- Updated dependencies [00d8daa]
- Updated dependencies [bc4606a]
- Updated dependencies [9547bea]
- Updated dependencies [6c6ab42]
  - @turingfocus/chat-protocol@0.1.0
