---
"@turingfocus/chat-react": minor
"@turingfocus/chat-ui-antd": minor
"@turingfocus/chat-kit": minor
---

Add the optional Interaction channel UI for `ask_colleague`: an instance-scoped `InteractionProvider` and hooks over the Runtime `InteractionClient`, a single-active Ant Design queue that consumes the Runtime EDF/active state, an interaction card supporting single-select, multi-select and free text, inline/modal display, read-only interaction history, and coexistence rules with the legacy `AskUserRemoteTool` and Gateway `pendingInteraction` paths. Existing hosts that do not inject an interaction client keep their current behavior.
