---
"@turingfocus/chat-runtime": patch
"@turingfocus/chat-react": patch
"@turingfocus/chat-ui-antd": patch
"@turingfocus/chat-kit": patch
---

Enable bounded, instance-local conversation caching by default, with cache-first display and server synchronization. Add optional scoped, versioned persistence and attachment revalidation ports, cache clearing and status subscriptions. Preserve the uncached path with `cache: false`; restored state does not grant live operation rights or automatically resend messages.
