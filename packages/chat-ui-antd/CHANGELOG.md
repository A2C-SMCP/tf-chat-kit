# @turingfocus/chat-ui-antd

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
