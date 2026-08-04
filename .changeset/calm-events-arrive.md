---
"@turingfocus/chat-protocol": minor
"@turingfocus/chat-runtime": minor
"@turingfocus/chat-gateway-tfrobot": minor
---

Handle TFRobot event transitions whose per-transition timestamps change without treating them as conflicting immutable event metadata.

`AgentEventTransitionPayload.createdAt` is now optional. Gateway consumers that
read this field directly must handle `undefined`; Runtime derives a stable event
creation time from the first accepted transition when the transport omits it.
