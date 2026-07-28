---
"@turingfocus/chat-ui-antd": minor
---

Add the composable Ant Design chat shell, controlled virtualized conversation
list, virtualized timeline, text composer, run interruption controls, smart
scrolling, and extensible error-isolated renderers with safe unknown-event
fallbacks. Command outcomes are scoped to their conversation and Run, while a
null renderer override explicitly selects the safe fallback. Drafts, pending
commands, and scroll state are also isolated across ChatClient replacement.
Each command failure has a single presentation owner and failed send drafts are
retained. Packed consumers verify the Ant Design 5.23.4 floor and current
5.29.x line.
