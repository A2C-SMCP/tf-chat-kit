---
"@turingfocus/chat-gateway-tfrobot": patch
---

Retry current-server subscription preflight once after an HTTP 401, reusing the
refreshed credential for REST validation and the Socket handshake. Bound pinned
credential invalidation by the subscription deadline.

Reconcile current-server provisional user message identities with persisted
history across realtime delivery and subscription handoff, retaining distinct
database IDs and clearing correlation state with its Gateway instance.
Allow confirmed Server processing fields to be added during persistence without
duplicating the user message, while retaining existing-value conflicts and
ambiguous identities.
