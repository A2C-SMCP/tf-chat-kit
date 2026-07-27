---
"@turingfocus/chat-gateway-tfrobot": minor
"@turingfocus/chat-testing": patch
---

Add the instance-scoped TFRobotServer REST and Socket.IO Gateway with runtime DTO validation, short-lived SessionProvider authentication, normalized history/realtime/command mapping, deadline and stale-interrupt safety, reconnect and disposal ownership, unknown-event fallback, and credential redaction.

Allow Gateway contract implementations to emit a subscribed-conversation run
convergence update while recovering their original live subscription.
