---
"@turingfocus/chat-auth": minor
---

Verify persisted and renewed credentials against the server identity before
committing a session. Add an injectable clock and on-demand refresh skew, validate
credential records, and fence late refresh work and failed storage cleanup. A
renewal strategy must support installing candidate sessions for identity checking;
missing production refresh capability safely requires authentication.
