# @turingfocus/chat-protocol

## 0.6.0

### Minor Changes

- 91a29e5: Add conversation lifecycle state, independently resolvable error occurrences,
  atomic TFRobot subscription handoff, acknowledged Socket.IO joins, verified
  reconnect recovery gating, and lifecycle-aware command controls.

## 0.5.0

## 0.4.2

## 0.4.1

## 0.4.0

## 0.3.0

### Minor Changes

- 2cff6fd: Handle TFRobot event transitions whose per-transition timestamps change without treating them as conflicting immutable event metadata.

  `AgentEventTransitionPayload.createdAt` is now optional. Gateway consumers that
  read this field directly must handle `undefined`; Runtime derives a stable event
  creation time from the first accepted transition when the transport omits it.

## 0.2.0

### Minor Changes

- ce9d465: Add host-agnostic conversation listing and creation commands with normalized
  input validation, backward-compatible Gateway support, and stable Runtime
  errors for unsupported, expired, invalid, and disposed operations.

## 0.1.0

### Minor Changes

- 00d8daa: Add normalized received-message and event-transition models, runtime schemas, stable timeline identity and ordering, sanitized raw data, and host-agnostic Gateway and SessionProvider contracts.
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

### Patch Changes

- 9547bea: Adopt the MIT license, npm public registry metadata, and GitHub source provenance for all packages.
- 6c6ab42: Move the unpublished public package family to the verified `@turingfocus` npm organization.
