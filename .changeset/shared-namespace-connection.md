---
"@turingfocus/chat-gateway-tfrobot": minor
"@turingfocus/chat-kit": minor
---

Add createTFRobotSocketConnection for explicit instance-local sharing of one WebSocket by chat and RemoteTool namespaces. Each namespace retains its own authentication, recovery and disposal lifecycle; existing independent connection defaults remain compatible.
