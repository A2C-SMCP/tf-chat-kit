# Chat Player V1 performance baseline

This document imports and qualifies the reusable evidence frozen by TFCK-20. It does not claim that the numbers were measured against the current migration revision. The Feature owner decided on 2026-07-17 to run the complete old-versus-new comparison after V1 development; TFCK-37 owns that measurement before migration cutover.

## Provenance

The canonical measurement implementation and raw recorded artifacts remain in TFRobotFront at commit `7b81f4a5e57810a52337b18018308caa209e73a9`, under `docs/chat-kit/perf-baseline-v1/`. That run exercised application commit `61dec0023a5675725398c471f5ce07269a699ff7` on 2026-04-15.

The current caller baseline inspected for TFCK-3 is `af3b4e2fa8d7a94c458d7c0812435ad17df0eb2e`. Therefore the historical numbers are an anchor and reproduction recipe, not a release gate. Copying the TFRobotFront-specific Playwright/mock implementation into this repository would create two diverging owners; this repository instead stores the normalized result and validates its provenance and limitations.

## Environment

| Field                  | Historical value                                                       |
| ---------------------- | ---------------------------------------------------------------------- |
| Machine                | Apple M2 Ultra, 192 GB RAM                                             |
| OS                     | macOS 26.2, build 25C56                                                |
| Node                   | 20.19.1                                                                |
| pnpm                   | 10.19.0                                                                |
| Playwright             | 1.57.0 bundled Chromium                                                |
| CPU/network throttling | None                                                                   |
| Display                | Unknown; refresh rate and resolution were not recorded                 |
| Backend                | Local TFRobotServer with real conversation list; mocked Socket traffic |

## Recorded scenarios

| Scenario                    | Result                                                                                                          | Qualification                                                                                                 |
| --------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Initial populated timeline  | FCP 1812 ms; click-to-settled 5057 ms; 65 commits; first commit 32.7 ms; total React duration 641 ms            | 52 Socket events were emitted as a burst. This approximates list population but excludes REST history latency |
| Large-list scroll           | 192 frames; 21.78 ms average; 45.9 FPS; P95 37 ms; longest frame 425.9 ms; 146 commits; React duration 760.9 ms | 52-item list on one high-end machine                                                                          |
| Realtime progressive update | 4621 ms wall time; 124 commits; 21.49 ms average inter-commit; 26.83 commits/s; React duration 1106.1 ms        | Synthetic fallback: 80 updates at 25 ms, not a captured real stream                                           |
| Conversation switch         | 2773 ms; 163 commits; React duration 911.9 ms; six sider items                                                  | Depends partly on a real local conversation list and a mocked populated target                                |

## Required-dimension coverage

| Required dimension  | Coverage                                | Gate                                                                               |
| ------------------- | --------------------------------------- | ---------------------------------------------------------------------------------- |
| First render        | Approximation with quantified UI work   | Rerun with deterministic REST history and record navigation/FCP separately         |
| History pagination  | Missing                                 | `TFCK-37-PAGE-01` must measure request-to-stable-render and scroll-anchor movement |
| Large-list updates  | Measured for a 52-item burst and scroll | Rerun on the migration source revision; add a lower-end target host when available |
| Realtime updates    | Deterministic synthetic measurement     | Capture and replay a real event cadence before making a production threshold       |
| Conversation switch | Historical mixed real/mock measurement  | `TFCK-37-RERUN-01` must compare both completed paths with the same fixture         |

## Comparison policy for later Kit work

- Compare the old and migrated implementations on the same machine, browser, fixture, build mode and run order.
- Keep wall-clock/network metrics separate from React render duration.
- Run each scenario enough times to report median and P95; the historical single run cannot define statistical tolerance.
- Record display resolution/refresh rate, CPU/network throttling, application commit, fixture hash and browser version.
- Fail a release comparison only after the current-host rerun establishes approved thresholds. Do not encode the historical values as universal CI limits.
- At minimum, collect first render, backward pagination, large-list scroll/update, realtime update and conversation switch.

## Reproduction

At the frozen TFRobotFront artifact revision, install its locked dependencies and run the documented headed Playwright command:

```text
pnpm playwright test --config=docs/chat-kit/perf-baseline-v1/scripts/perf-playwright.config.ts
```

The runner requires the TFRobotFront environment and, for complete scenarios, a reachable test backend. Secrets must be supplied only through that host's approved environment mechanism and must never be copied into this repository or recorded traces.

## Deferred TFCK-37 measurement

- `TFCK-37-PAGE-01`: add and run a deterministic history-pagination scenario.
- `TFCK-37-RERUN-01`: compare the old and completed V1 implementations with all required scenarios.
- `TFCK-37-STREAM-01`: replace or supplement the synthetic stream with a redacted real cadence fixture.
- `TFCK-37-ENV-01`: record display information and a representative lower-end target environment.

These items do not block TFCK-3's evidence-only delivery. The first-render, pagination, large-list, realtime and conversation-switch comparisons remain mandatory before the Feature Flag can default to the new path.
