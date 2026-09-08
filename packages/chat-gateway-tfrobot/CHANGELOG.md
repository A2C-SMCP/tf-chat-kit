# @turingfocus/chat-gateway-tfrobot

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
