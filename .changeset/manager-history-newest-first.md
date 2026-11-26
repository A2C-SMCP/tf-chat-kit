---
"@turingfocus/chat-gateway-tfrobot": minor
"@turingfocus/chat-kit": patch
"@turingfocus/chat-ui-antd": minor
---

Support newest-first conversation pagination in the TFRobot Gateway and custom list ordering in ChatCompactWorkspace. ManagerChatApp starts with the most recently updated conversations, appends older ones when loading more, and reorders loaded rows when their update timestamps change. Direct Gateway callers keep oldest-first pagination by default.
