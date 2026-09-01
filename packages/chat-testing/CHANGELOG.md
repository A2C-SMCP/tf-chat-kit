# @turingfocus/chat-testing

## 0.8.0-dev.0

### Minor Changes

- Add host-agnostic attachment messages, conversation-scoped composer drafts,
  zero-extra-config TFRobot uploads, Ant Design file and long-paste interactions,
  and non-TFRobotFront consumer coverage.

### Patch Changes

- Updated dependencies
  - @turingfocus/chat-protocol@0.8.0-dev.0

## 0.7.0

### Minor Changes

- 93183e0: Add an explicit current TFRobotServer compatibility profile with validated legacy task IDs, same-session REST preflight, bounded best-effort reconnect rebase, and operable degraded lifecycle semantics while preserving the strict verified profile by default. Also add optional conversation rename and delete commands across Protocol, TFRobot Gateway, Runtime, React, Ant Design UI, testing, and the repository Playground, including active-snapshot retirement, an additive empty-state subscription, confirmation, and reserved-prefix cleanup guards.

### Patch Changes

- Updated dependencies [93183e0]
  - @turingfocus/chat-protocol@0.7.0

## 0.6.0

### Patch Changes

- 91a29e5: Add conversation lifecycle state, independently resolvable error occurrences,
  atomic TFRobot subscription handoff, acknowledged Socket.IO joins, verified
  reconnect recovery gating, and lifecycle-aware command controls.
- Updated dependencies [91a29e5]
  - @turingfocus/chat-protocol@0.6.0

## 0.5.0

### Patch Changes

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

### Patch Changes

- Updated dependencies [2cff6fd]
  - @turingfocus/chat-protocol@0.3.0

## 0.2.0

### Minor Changes

- ce9d465: Expand the Memory Gateway with deterministic multi-conversation creation,
  pagination, per-conversation snapshots and subscriptions, and scriptable
  creation failures, holds, deadlines, disconnects, and disposal.
- ce9d465: Add host-agnostic conversation listing and creation commands with normalized
  input validation, backward-compatible Gateway support, and stable Runtime
  errors for unsupported, expired, invalid, and disposed operations.

### Patch Changes

- Updated dependencies [ce9d465]
  - @turingfocus/chat-protocol@0.2.0

## 0.1.0

### Minor Changes

- 2a42b41: Add a scriptable in-memory ChatGateway, normalized fixture factories, and framework-neutral Gateway and Runtime contract cases.
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
- ea06213: Add the instance-scoped TFRobotServer REST and Socket.IO Gateway with runtime DTO validation, short-lived SessionProvider authentication, normalized history/realtime/command mapping, deadline and stale-interrupt safety, reconnect and disposal ownership, unknown-event fallback, and credential redaction.

  Allow Gateway contract implementations to emit a subscribed-conversation run
  convergence update while recovering their original live subscription.

- 6c6ab42: Move the unpublished public package family to the verified `@turingfocus` npm organization.
- Updated dependencies [00d8daa]
- Updated dependencies [bc4606a]
- Updated dependencies [9547bea]
- Updated dependencies [6c6ab42]
  - @turingfocus/chat-protocol@0.1.0
