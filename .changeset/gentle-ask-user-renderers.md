---
"@turingfocus/chat-protocol": minor
"@turingfocus/chat-runtime": minor
"@turingfocus/chat-gateway-tfrobot": minor
"@turingfocus/chat-ui-antd": minor
"@turingfocus/chat-testing": minor
---

Add conversation-scoped Ask User request, answer, result, capability, update,
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
