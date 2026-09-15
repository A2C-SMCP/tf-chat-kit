---
"@turingfocus/chat-gateway-tfrobot": patch
---

Reuse healthy instance-local Socket.IO connections across conversation switches while preserving per-subscription cleanup, authentication isolation and recovery assurance. Current-server connections retain visited server rooms until disconnect; the Gateway filters foreign and ambiguous unscoped events after switching.
