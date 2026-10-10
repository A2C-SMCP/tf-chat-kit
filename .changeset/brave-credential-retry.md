---
"@turingfocus/chat-gateway-tfrobot": patch
---

Retry once with a freshly resolved session when the server rejects the
credential with 401. The rejected session is invalidated on the provider, so a
short-lived token that expired between requests no longer surfaces as a failed
operation. Repeated rejection returns the original error and never loops.
