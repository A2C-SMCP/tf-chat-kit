---
"@turingfocus/chat-protocol": minor
"@turingfocus/chat-runtime": minor
"@turingfocus/chat-gateway-tfrobot": minor
"@turingfocus/chat-ui-antd": minor
"@turingfocus/chat-kit": minor
"@turingfocus/chat-testing": minor
---

Correlate user messages by the Server's elementId across POST receipts, realtime,
history and cache, independently of author display and database persistence.
Expose instance-local outgoing send observations with accepted, failed and unknown
outcomes and render them outside the formal timeline. Preserve legacy Server
compatibility and never replay sends from cache. Full POST promotion metadata and
correlated business terminal states still require the Server contracts tracked in #141.
