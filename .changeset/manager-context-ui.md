---
"@turingfocus/chat-kit": patch
"@turingfocus/chat-ui-antd": patch
"@turingfocus/chat-auth": minor
---

Clarify identity, organization, robot and platform context in the default Manager UI. Add consistent switch controls and preserve active chat and drafts while browsing or cancelling robot/platform candidates. Keep host-fixed platforms visible and distinguish account display names from organization IDs.

Preserve the optional Manager organizationName field independently of account displayName, with safe ID fallbacks for missing organization names.

Restore focus to the actual history/help navigation trigger in WebKit as well as Chromium.
