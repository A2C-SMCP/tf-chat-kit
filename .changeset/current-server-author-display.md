---
"@turingfocus/chat-gateway-tfrobot": patch
"@turingfocus/chat-protocol": minor
"@turingfocus/chat-runtime": patch
"@turingfocus/chat-ui-antd": minor
---

Reconcile mutable author names and avatars independently from current-server user-message identity. Keep historical author updates across cache reads, pagination, concurrent loads and reconnects without overwriting newer message content. Add optional message provenance and author-only recovery updates. Preserve unassociated provisional messages and show them in an expandable review section in the default UI; never alias different user IDs or claim complete current-server recovery.
