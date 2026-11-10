---
"@turingfocus/chat-protocol": minor
"@turingfocus/chat-gateway-tfrobot": minor
"@turingfocus/chat-runtime": minor
"@turingfocus/chat-kit": minor
---

Add the Interaction channel core for `ask_colleague`: protocol wire models and transport ports, a single-owner interaction sub-protocol on the shared `/remote-tool` transport, an instance-scoped Runtime `InteractionClient` with EDF queueing, snapshot reconciliation, ack handling and queue bounds, and explicit interaction-only/combined factories. RemoteTool behavior and `/chat` events are unchanged.
