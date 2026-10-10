# Issue 98: connection-panel cleanup

Source: https://github.com/A2C-SMCP/tf-chat-kit/issues/98. Baseline:
`dev-0.8.3` / `6e10d6d06426d3cc2d0b19e4e829d007cd4ca17d` plus the current
locally verified authentication and quick-chat work. User authorization covers
implementation and acceptance of the remaining issues.

## Evidence and corrected scope

The independent read-only caller audit found no callers supplying the private
panel's `prefill` or `managerConnect` props, no public npm export and no local
cross-repository consumers. Remove those declarations, the now-unused prefill
interface, initialization/synchronization from that prop, manager-loading state
and its unreachable one-click button. Keep the normal form fields and controls.

The issue's claim that `prefillError` is also dead is contradicted by live code:
the development-only `.debug` loader uses it for invalid configuration and request
failures. README documents this local feature, Vite enables it for serve, and
existing DOM tests exercise all field prefills and late-response protection.
Retain the dynamic loader, warning, abort controller, user-edit guard and secret
in-memory behavior. Manager automatic connection remains in the Manager module.
Do not touch external repositories, developer `.debug` files or credentials.

## Verification plan

Run existing panel/Playground and Manager regressions. Add directed Chromium
coverage for empty defaults, valid/invalid `.debug` prefills, clearing a warning
after editing and rejecting a late response after manual edits. Use synthetic
browser test responses; no real credentials. Assert the manual panel has no old
Manager button. Run types/lint/format/build and an isolated full-scope review.

## Evidence

The three directed Playground files pass 51 tests, including retained field
prefills, late-response protection, manual connection and Manager automatic
connection/retry. Four actual Chromium scenarios pass: absent configuration
starts empty, valid configuration populates the form without storing the synthetic
credential, invalid configuration warns and manual editing clears it, and a late
response cannot replace manual values. Each checks absence of the old Manager
button. The browser run uses isolated port 4321 and leaves the existing 4311
development server running.

Full types, targeted lint, Prettier, diff checks and Playground build pass.
The final isolated full-scope review approved the complete change with no blockers.

Status: local acceptance and review passed; delivery pending. No commit, push, publication
or issue closure has occurred.
