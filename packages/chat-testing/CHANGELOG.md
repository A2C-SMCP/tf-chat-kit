# @turingfocus/chat-testing

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
