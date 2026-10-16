---
"@turingfocus/chat-kit": patch
---

Resolve packed workspace dependencies from the target package version so the auth facade installs the independently released chat-auth API it requires. Verify actual registry dependency resolution without overrides in Manager consumers.
