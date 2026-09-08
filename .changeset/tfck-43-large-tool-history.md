---
"@turingfocus/chat-gateway-tfrobot": patch
---

Keep historical conversations readable when tool results exceed diagnostic raw limits. Redact transport payloads independently from diagnostic retention, preserve normal page content, and replace oversized tool details with an explicit omission explanation. Apply the same handling to realtime events and report transport structure limits without misclassifying valid response envelopes.
