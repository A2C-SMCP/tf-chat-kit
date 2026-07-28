# TFCK-9 UI regression evidence

Date: 2026-07-28

Scope: `@turingfocus/chat-ui-antd` V1 vertical slice. This report covers
deterministic package-level and packed-consumer verification. Real
TFRobotFront browser comparison remains in TFCK-10/TFCK-37.

## Acceptance mapping

| Acceptance area                                                              | Automated evidence                          |
| ---------------------------------------------------------------------------- | ------------------------------------------- |
| Controlled conversation selection                                            | `tests/chat-ui-antd.test.ts`                |
| loading / empty / error / disconnected / capability unavailable              | `tests/chat-ui-antd.test.ts`                |
| History, realtime, send/interrupt, stale request and client isolation        | `tests/chat-ui-antd-vertical-slice.test.ts` |
| Smart scroll, new-ID counting, replacement deduplication, conversation reset | `tests/chat-ui-antd-scroll.test.ts`         |
| Renderer priority, null override, and safe unknown fallback                  | `tests/chat-ui-antd-renderers.test.ts`      |
| Per-renderer failure isolation and reset                                     | `tests/chat-ui-antd-renderers.test.ts`      |
| Large-list bounded rendering and timezone-stable SSR                         | `tests/chat-ui-antd-virtualization.test.ts` |
| Published-package consumers at AntD 5.23.4 and 5.29.3                        | `scripts/verify-packed-artifacts.mjs`       |

## Performance guard

- A 1,000-conversation server render is bounded to 20 initial rows.
- A 5,000-item timeline server render is bounded to the latest 20 initial
  items.
- Timeline identity uses protocol stable keys, so same-ID streaming
  replacements do not increase the away-from-bottom message count or change
  the simulated scroll position; the DOM regression applies 25 consecutive
  replacements.
- Timeline tail identity reads are O(1) for length-preserving streaming
  replacements and proportional only to appended items for growth. A dedicated
  5,000-item / 1,000-replacement guard verifies that the hot path performs
  exactly 1,000 key reads rather than rebuilding a full identity set.
- The timeline item and registry are memoized; renderer resolution and safe
  fallback do not require a host store or a second polling loop.
- Conversation metadata-only updates retain the selected UI slice and do not
  re-render timeline items.
- Runtime high-frequency merge performance remains guarded by the existing
  5,000-item / 1,000-update performance tests.
- Packed UI consumers compile and server-render with both the declared Ant
  Design 5.23.4 floor and the current 5.29.3 line. The temporary 5.23.4
  consumer has no repository `patchedDependencies`, proving the published
  declarations independently of local source-build patches.

These are structural regression guards rather than browser frame-time claims.
Frame-time, visual parity, and production host telemetry must be measured in
the host integration tasks.

## Boundary result

- UI reads state only through `@turingfocus/chat-react` hooks.
- Commands are routed only through `ChatClient`.
- Send and interrupt results are isolated by command, conversation, request,
  ChatClient instance, conversation-switch epoch, and immutable Run replacement
  epoch before they may update UI state. Local drafts, pending command results,
  and scroll state also reset when the Provider replaces its ChatClient, even
  when the replacement exposes the same conversation ID. Regression coverage
  includes A→B→A switching, ordinary and suspended-transition client
  replacement, and a same-ID Run replacement while a command is held.
- Command failures have one presentation owner: the composed view renders one
  exact error alert, while Composer and RunStatus retain only pending/draft
  state and do not create a duplicate generic alert.
- No Gateway, SessionProvider, Socket.IO, auth, router, branding, feature flag,
  or host Store dependency was introduced.
- Unknown event raw payloads and renderer exception text are not rendered.
