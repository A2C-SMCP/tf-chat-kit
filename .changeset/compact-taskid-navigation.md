---
"@turingfocus/chat-ui-antd": minor
"@turingfocus/chat-gateway-tfrobot": patch
---

Add compact navigation mode to `ChatUiShell` (inline conversation title, new-conversation trigger, and history dropdown that reuses the workspace's loading/paging/error/selection handling) and make `sendTextDtoSchema.taskId` optional so accepted TFRobot responses without a `taskId` no longer report a false validation error.
