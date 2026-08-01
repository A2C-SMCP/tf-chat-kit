---
"@turingfocus/chat-gateway-tfrobot": patch
---

Preserve the required browser receiver when the Gateway uses the global Fetch API,
and redact the exact active Bearer or Admin credential from HTTP and Socket
responses, realtime payloads, and diagnostics even when a server echoes an opaque
value without a credential label.
