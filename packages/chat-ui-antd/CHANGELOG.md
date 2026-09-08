# @turingfocus/chat-ui-antd

## 0.8.0

### Minor Changes

- a83c4e3: Add host-agnostic attachment messages, conversation-scoped composer drafts,
  zero-extra-config TFRobot uploads, Ant Design file and long-paste interactions,
  and non-TFRobotFront consumer coverage.
- 358dd28: Add normalized tool presentations, host-injected resource and document ports, media and Markdown
  display, read-only code and terminal details, local event navigation and received-result inspection.
  Preserve existing transport and Ask User contracts and validate independent packed consumers.

### Patch Changes

- Updated dependencies [a83c4e3]
- Updated dependencies [358dd28]
  - @turingfocus/chat-protocol@0.8.0
  - @turingfocus/chat-react@0.8.0

## 0.7.0

### Minor Changes

- 93183e0: Add an explicit current TFRobotServer compatibility profile with validated legacy task IDs, same-session REST preflight, bounded best-effort reconnect rebase, and operable degraded lifecycle semantics while preserving the strict verified profile by default. Also add optional conversation rename and delete commands across Protocol, TFRobot Gateway, Runtime, React, Ant Design UI, testing, and the repository Playground, including active-snapshot retirement, an additive empty-state subscription, confirmation, and reserved-prefix cleanup guards.

### Patch Changes

- Updated dependencies [93183e0]
  - @turingfocus/chat-protocol@0.7.0
  - @turingfocus/chat-react@0.7.0

## 0.6.0

### Minor Changes

- 91a29e5: Add conversation lifecycle state, independently resolvable error occurrences,
  atomic TFRobot subscription handoff, acknowledged Socket.IO joins, verified
  reconnect recovery gating, and lifecycle-aware command controls.

### Patch Changes

- Updated dependencies [91a29e5]
  - @turingfocus/chat-protocol@0.6.0
  - @turingfocus/chat-react@0.6.0

## 0.5.0

### Minor Changes

- c22f4c9: Add compact navigation mode to `ChatUiShell` (inline conversation title, new-conversation trigger, and history dropdown that reuses the workspace's loading/paging/error/selection handling) and make `sendTextDtoSchema.taskId` optional so accepted TFRobot responses without a `taskId` no longer report a false validation error.

### Patch Changes

- @turingfocus/chat-protocol@0.5.0
- @turingfocus/chat-react@0.5.0

## 0.4.2

### Patch Changes

- 6ad3504: Add an instance-scoped conversation workspace controller, an effect-owned React binding, and a managed Ant Design ChatWorkspace that owns conversation listing, creation, pagination, selection, retries, and async race handling while keeping Robot, endpoint, identity, and authentication policy host-owned.
- Updated dependencies [6ad3504]
  - @turingfocus/chat-react@0.4.2
  - @turingfocus/chat-protocol@0.4.2

## 0.4.1

### Patch Changes

- @turingfocus/chat-protocol@0.4.1
- @turingfocus/chat-react@0.4.1

## 0.4.0

### Patch Changes

- @turingfocus/chat-protocol@0.4.0
- @turingfocus/chat-react@0.4.0

## 0.3.0

### Patch Changes

- Updated dependencies [2cff6fd]
  - @turingfocus/chat-protocol@0.3.0
  - @turingfocus/chat-react@0.3.0

## 0.2.0

### Minor Changes

- 8cd29c9: Add compact event rows, safe shared event details, and responsive split or modal detail modes with controlled and uncontrolled selection APIs.
- 8bc0f44: Add an accessible, pointer- and keyboard-resizable event-detail split with
  controlled and uncontrolled ratio APIs, while keeping persistence owned by the
  host application.
- 8bc0f44: Place the active-run interrupt action beside the composer send button and hide it when no run is in progress. Add optional composer interrupt configuration and allow standalone run-status views to suppress their interrupt button.

### Patch Changes

- Updated dependencies [ce9d465]
  - @turingfocus/chat-protocol@0.2.0
  - @turingfocus/chat-react@0.2.0

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

- c940089: Add the composable Ant Design chat shell, controlled virtualized conversation
  list, virtualized timeline, text composer, run interruption controls, smart
  scrolling, and extensible error-isolated renderers with safe unknown-event
  fallbacks. Command outcomes are scoped to their conversation and Run, while a
  null renderer override explicitly selects the safe fallback. Drafts, pending
  commands, and scroll state are also isolated across ChatClient replacement.
  Each command failure has a single presentation owner and failed send drafts are
  retained. Packed consumers verify the Ant Design 5.23.4 floor and current
  5.29.x line.

### Patch Changes

- 9547bea: Adopt the MIT license, npm public registry metadata, and GitHub source provenance for all packages.
- 6c6ab42: Move the unpublished public package family to the verified `@turingfocus` npm organization.
- Updated dependencies [00d8daa]
- Updated dependencies [c6d758e]
- Updated dependencies [bc4606a]
- Updated dependencies [9547bea]
- Updated dependencies [6c6ab42]
  - @turingfocus/chat-protocol@0.1.0
  - @turingfocus/chat-react@0.1.0
