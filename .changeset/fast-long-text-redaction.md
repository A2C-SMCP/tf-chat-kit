---
"@turingfocus/chat-protocol": patch
---

Avoid JavaScriptCore stalls when redacting long tool output by scanning embedded
credential parameters without regexp backtracking, preserving credential removal
and non-sensitive text.
