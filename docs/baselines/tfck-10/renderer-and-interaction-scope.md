# TFCK-10 renderer and interaction scope

Date: 2026-07-29

Status: package-level implementation verified; live TFRobot Ask User routing
deferred

## Evidence and scope decision

The TFCK-3 migration matrix admits completed Ask User history rendering but
requires real-frequency evidence before selecting Shell, Editor, Preview,
Browser, or Download as default renderers. No deployment-frequency capture was
available for TFCK-10, so no heavy renderer was approved. The existing
error-isolated registry and safe fallback remain the migration path for those
events.

The current TFRobotServer `/remote-tool` contract binds providers to Socket
sessions but does not provide reliable conversation routing for invocations.
TFRS-231 owns provider scope and conversation isolation; TFRF-89 owns cleanup
of the current host implementation. Until those tasks supply integration
evidence, `TFRobotChatGateway` neither advertises `answerInteraction` nor
implements the optional command.

## Delivered Kit behavior

- Protocol defines conversation-scoped Ask User request, answer, and terminal
  result models, optional snapshot state, updates, capability, and Gateway
  command.
- Runtime validates the active conversation, immutable request
  `requestId`/`revision` identity, required fields, answer shape, and declared
  options; it rejects unsupported/stale/invalid answers, clears only the
  matching acknowledged revision, and ignores late results after replacement
  (including a new revision that reuses the request ID), conversation switch,
  or disposal. Each active conversation epoch keeps a bounded retired-revision
  set so delayed updates cannot revive a replaced or cleared interaction.
- Pending request schemas reject reserved object keys and unsupported
  multi-select free-text shapes; the UI stores form state by question index and
  maps it back to the external safe ID only at the answer boundary.
- Protocol-level budgets bound question, option, answer, ID, and text sizes for
  every Gateway, and option values are unique within each question.
- Testing provides normalized Ask User fixtures, a controllable in-memory
  answer command, and capability-aware framework-neutral answer contracts.
- TFRobot Gateway maps historical `ask_user` Tool call/return variants into the
  standard terminal result, including failed/timeout/cancelled terminal
  precedence, bounded/sanitized option values, and duplicate-option
  normalization. Alias and snake-case tolerance stay inside this compatibility
  layer.
- Ant Design UI separates Markdown content from message chrome, sanitizes GFM,
  makes failed events visually explicit, renders bounded normalized generic
  Tool results and Ask User history, scopes answer failures to their exact
  pending request revision, routes pending answers only through `ChatClient`, and
  exposes per-question chat-about-this as an explicit host drafting callback
  rather than a Gateway answer action.
- A renderer exception remains isolated to its timeline item; timeline,
  composer, and interruption controls continue to operate.

## Deferred and unverified

- Live `/remote-tool` registration, provider selection, callback ownership,
  login/layout integration, and chat-about-this host drafting remain host
  responsibilities.
- Shell, Editor, Preview, Browser, and Download defaults remain deferred until
  frequency evidence approves individual renderers.
- No production TFRobot live Ask User run is claimed by this change.

## Automated evidence

| Area                                                        | Evidence                                    |
| ----------------------------------------------------------- | ------------------------------------------- |
| Protocol validation and tolerant optional capability        | `tests/chat-protocol.test.ts`               |
| Runtime stale/replacement/switch/dispose/instance isolation | `tests/chat-runtime.test.ts`                |
| Historical TFRobot compatibility mapping                    | `tests/chat-gateway-tfrobot.test.ts`        |
| Markdown safety, Tool result, renderer failure isolation    | `tests/chat-ui-antd-renderers.test.ts`      |
| Ask User submit and controlled failure ownership            | `tests/chat-ui-antd-vertical-slice.test.ts` |
