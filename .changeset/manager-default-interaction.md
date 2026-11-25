---
"@turingfocus/chat-kit": minor
"@turingfocus/chat-auth": minor
"@turingfocus/chat-react": minor
---

ManagerChatApp now connects to the active Robot's Interaction channel and renders questions in the current conversation. ManagerClient exposes connectForInteraction to acquire an action-scoped Robot session. Pass interactionClient={null} to disable the default connection or provide a host-owned client with its existing identity binding.

Use the new useHasInteractionProvider hook to detect an existing Interaction boundary, including a disabled provider.
