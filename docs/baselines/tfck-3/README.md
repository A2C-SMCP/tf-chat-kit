# TFCK-3 V1 baseline evidence index

This directory freezes the migration input for [TFCK-3](https://turingfocus.atlassian.net/browse/TFCK-3). It is an evidence baseline, not a public `tf-chat-kit` API specification.

## Baseline status

| Area                                                           | Jira item         | Evidence                                                                                                                                                                 | Status                                                                                                           |
| -------------------------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| TFRobotServer REST, Socket.IO, authentication, DTOs and errors | TFCK-21           | [`tfrobotserver-chat-contract.md`](./tfrobotserver-chat-contract.md), [`tfrobotserver-chat-contract.json`](../../../fixtures/tfck-3/v1/tfrobotserver-chat-contract.json) | Complete as a source/test-derived contract freeze; runtime validation is deferred                                |
| V1 behavior and migration decisions                            | TFCK-19           | [`chat-player-v1-migration-matrix.md`](./chat-player-v1-migration-matrix.md)                                                                                             | Complete as a design input; no package API is introduced                                                         |
| V1 performance                                                 | TFCK-20 → TFCK-37 | [`performance-baseline.md`](./performance-baseline.md), [`chat-player-performance.json`](../../../fixtures/tfck-3/v1/chat-player-performance.json)                       | Historical anchor and comparison method frozen; unified measurement is deferred until V1 development is complete |

The artifacts are checked by [`verify-tfck-3-baselines.mjs`](../../../scripts/verify-tfck-3-baselines.mjs) and [`tfck-3-baselines.test.ts`](../../../tests/tfck-3-baselines.test.ts). Structural, redaction and evidence rules produce specific diagnostics; frozen SHA-256 digests make any content change an explicit, reviewable baseline update.

## Frozen source revisions

| Repository                        | Revision                                   | Version or role                                  | Observation date |
| --------------------------------- | ------------------------------------------ | ------------------------------------------------ | ---------------- |
| TFRobotServer `origin/develop`    | `d085c12dd8f603477dfb445bc5f5b0fd099caf15` | `0.3.0-dev7`; contract owner                     | 2026-07-17       |
| TFRobotFront `origin/develop`     | `af3b4e2fa8d7a94c458d7c0812435ad17df0eb2e` | Current caller and old-behavior evidence         | 2026-07-17       |
| TFRobotFront performance artifact | `7b81f4a5e57810a52337b18018308caa209e73a9` | TFRF-54 scripts and recorded output              | 2026-04-15       |
| TFRobotFront measured application | `61dec0023a5675725398c471f5ce07269a699ff7` | Code exercised by the historical performance run | 2026-04-15       |

The external repositories were inspected read-only. Their worktrees were not changed.

## Evidence rules

- `server-source` is authoritative for current paths, field names, scopes and emitted values.
- `server-test` proves serialization or transport behavior but is not production traffic.
- `front-caller` proves how the current host consumes the contract; it cannot override Server truth.
- `jira-decision` is supporting evidence for cross-repository authentication changes.
- `runtime-capture` is required before calling a payload a real deployment sample.
- Draft documents and comments are not treated as implemented contracts unless current source and tests agree.

## Deferred runtime and production gates

1. `TFCK-21-LIVE-01`: deployment URL, deployed Server commit/version, and redacted real REST/Socket payloads remain unverified. TFCK-37 owns this runtime evidence before default cutover.
2. `TFCK-21-ERR-01`: several domain failures fall through a generic exception handler and may expose `repr(exc)` in a `500` envelope. TFCK-37 owns exact deployed 404/422/500 confirmation.
3. `TFCK-21-SOCKET-AUTHZ-01`: `/chat` enforces only a connection-level `chat:read` scope. [TFRS-297](https://turingfocus.atlassian.net/browse/TFRS-297) owns producer isolation or event-level authorization and blocks TFCK-7/TFCK-37 production validation.

TFCK-21 is complete as a reproducible source/test-derived freeze because every REST route and every cross-confirmed Socket event is referenced to Server source plus Server tests or the active Front caller. Socket events with source-only evidence are explicitly marked and deferred with an owner and required verification. It must not be represented as runtime-validated. The deferred items do not reopen the frozen evidence task, but they continue to block real Gateway validation and migration cutover.

## Deferred performance validation

On 2026-07-17 the Feature owner moved the current-host performance run out of TFCK-3. TFCK-3 freezes the historical anchor, required dimensions and reproduction method; TFCK-37 owns the unified old-versus-new measurement after V1 development and before the new path becomes the default. The deferred checks are `TFCK-37-PAGE-01`, `TFCK-37-RERUN-01`, `TFCK-37-STREAM-01` and `TFCK-37-ENV-01`. They do not block this evidence baseline, but the required comparison still blocks migration cutover.
