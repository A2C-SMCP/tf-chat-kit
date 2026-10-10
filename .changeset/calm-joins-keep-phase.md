---
"@turingfocus/chat-gateway-tfrobot": patch
---

Preserve the reached Socket establishment phase when a conversation join times out, regardless of which deadline timer fires first. Cleanup still rejects late acknowledgements and disconnects the failed subscription.
