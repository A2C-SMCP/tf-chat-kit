---
"@turingfocus/chat-protocol": patch
"@turingfocus/chat-gateway-tfrobot": patch
"@turingfocus/chat-runtime": patch
"@turingfocus/chat-kit": patch
---

Interaction core follow-ups: interaction-specific retry that re-handshakes the shared namespace and re-registers RemoteTool, namespace trailing-slash normalization, legacy `supportsAskUserAdapter` restricted to the Bundle, ack timeout aligned to the 60s transport budget, closed answered metadata backfill, shared tool-name normalization, and additional recovery/cleanup coverage.
