# TFCK-17 event detail acceptance

- Scope: `@turingfocus/chat-ui-antd`, repository Playground and deterministic
  consumer evidence
- Reference: TFRobotFront revision
  `af3b4e2fa8d7a94c458d7c0812435ad17df0eb2e`
- Real host status: not changed or validated by this implementation

GitHub #23 later extends the accepted split layout with an accessible resize
handle and host-controlled ratio persistence. The 56/44 split below remains the
default, and persistence remains a host responsibility.

## Responsibility boundary

Chat Kit owns normalized event presentation, safe fallback rendering,
selection semantics, responsive split/Modal resolution and accessible event
activation. A host owns surrounding layout, theme, any controlled mode or
selection state, persistence policy and rollout. Protocol, Runtime, Gateway,
authentication, DTO and host store/router behavior are unchanged.

## Acceptance matrix

| Main issue criterion                                                                                                                        | Deterministic evidence                                                                              |
| ------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Every message remains in the timeline; Agent, Tool and unknown events are compact, selectable rows with state, summary and time             | `tests/chat-ui-antd-renderers.test.ts`, `tests/chat-ui-antd-event-detail.test.ts`                   |
| Wide auto mode uses a 56/44 split, starts empty, updates only from explicit selection and does not let new events steal selection           | `tests/chat-ui-antd-event-detail.test.ts`, Mock Playwright scenario                                 |
| Narrow auto mode uses Modal; manual split/Modal selection wins for the component instance                                                   | Unit controlled/uncontrolled mode cases and responsive Playground browser flow                      |
| Generic, Tool, multiple-transition, Ask User, failure and unknown details are safe; renderer errors remain isolated and raw is not rendered | Renderer/detail suites and existing renderer boundary tests                                         |
| Mouse, Enter and Space activate rows; Escape/close restores focus; conversation or invalid selection clears                                 | Event-detail unit suite and Mock Playwright flow                                                    |
| Custom renderers, virtualization, tail follow, send, interrupt and multi-host behavior do not regress                                       | Existing UI/scroll suites, Mock/Bearer Playwright scenarios, Front-style suite and packed consumers |
| Mock and approximate RobotServer modes exercise formal public UI components in split and Modal modes                                        | `tests/e2e/playground.spec.ts` and `scripts/playground-e2e-robotserver.mjs`                         |

## Host matrix

| Host topology                      | Evidence                                                                      | Claim boundary                                              |
| ---------------------------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Repository Playground Mock         | Package-default event row/detail plus responsive and manual modes             | Deterministic browser evidence                              |
| Repository approximate RobotServer | Normalized RobotServer event through package-default row/detail in both modes | Deterministic compatibility evidence, not a real deployment |
| TFRobotFront style                 | Source consumer mounts the public view with the split-mode API                | Repository-owned integration topology only                  |
| Tauri style                        | Packed lower-bound consumer mounts the public view and opens split detail     | Packed API compatibility only                               |

## Verification

Run with the repository Node.js 24 and pnpm baselines:

```bash
pnpm check
pnpm test:e2e
```

The browser suite normally uses port 3000. A developer may override
`TF_CHAT_PLAYGROUND_PORT` when that port is occupied. Real RobotServer and real
host rollout checks remain optional manual compatibility work; failures there
must first be reduced to repository fixtures before production contracts are
changed.

## Migration and rollback

This is an additive UI API and package-default renderer change. It requires no
schema migration, data backfill, dual write or feature flag. Consumers can
rollback by pinning the previous `@turingfocus/chat-ui-antd` version or by
providing their existing custom renderer registry.
