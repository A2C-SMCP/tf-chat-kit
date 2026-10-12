---
"@turingfocus/chat-auth": minor
---

Add an explicit routed-server Manager HTTP strategy for browser hosts. REST uses the robot path and exchanged Bearer directly, without the Front BFF. Requires an ingress that forwards prefixed chat requests and unauthenticated CORS preflight to Server. Align the Playground Manager path and independent consumers with this public contract.
