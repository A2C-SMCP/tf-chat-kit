---
"@turingfocus/chat-runtime": patch
---

Report the subscription failure when a conversation load fails after its
subscription did. The follow-up snapshot request reuses the same deadline, so
its own timeout used to hide the socket handshake or join failure that spent
the deadline in the first place.
