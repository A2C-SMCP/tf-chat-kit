---
"@turingfocus/chat-ui-antd": patch
"@turingfocus/chat-kit": patch
---

Change the default composer behavior to Enter for a newline and Ctrl+Enter to send on every platform, including macOS. Cmd+Enter does not send. Hosts that need Enter-to-send must explicitly set `sendShortcut="enter"`; Ctrl+Enter also sends in that mode, while Shift+Enter always inserts a newline.

Expose `sendShortcut` through ChatComposer, ChatConversationView and ChatWorkspace's conversationViewProps, with localized accessible hints. Preserve drafts and attachments when switching modes. Protect IME composition and its final keydown boundary, suppress repeated shortcuts, and share upload/in-flight guards between keyboard and button submissions.

Release decision: ship this explicitly approved default-interaction change in 0.8.2. The patch version does not imply that the default shortcut is unchanged; existing hosts must opt into `sendShortcut="enter"` to preserve Enter-to-send.
