---
"@turingfocus/chat-gateway-tfrobot": minor
"@turingfocus/chat-kit": patch
"@turingfocus/chat-ui-antd": patch
---

Connect Manager chat providers to a robot-scoped attachment uploader and dispose uploads when the connection changes. Support clipboard images, file selection and attachment-only first messages in the compact workspace, and explain unavailable image paste.

Manager uploads use the TFRobotServer chat attachment endpoint with the existing chat:send scope. Direct uploader callers keep the dashboard endpoint by default.
