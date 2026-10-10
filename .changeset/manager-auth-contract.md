---
"@turingfocus/chat-auth": minor
---

Validate Manager authentication DTOs before committing credentials, verify selected
and switched identities with the candidate session through `/auth/me`, and preserve
structured errors without server-provided sensitive messages. Account choices can
omit user IDs; onboarding exposes a user without inventing an account. Provide a
Protocol-compatible session invalidation callback and cancellation checks.
