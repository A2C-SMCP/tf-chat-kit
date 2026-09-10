# Issue #77: Multi-conversation cache and optional persistence

Status: Implementation approved by the user on 2026-09-10, including default caching without an explicit scope.

Source: https://github.com/A2C-SMCP/tf-chat-kit/issues/77

## Scope

IN: reusable conversation caching belongs to Runtime, with React/UI bindings and
optional host-supplied storage. No new workspace package is needed. The host owns
the opaque isolation scope, storage implementation, logout policy and identity
changes. Kit must not infer account, organization or Robot identifiers.

The client navigation task in tfrobot-client#78 remains independent. This plan
does not change another repository, keep multiple Socket subscriptions alive or
implement an offline send queue.

## Current implementation evidence

- `packages/chat-runtime/src/chat-client.ts`: one active snapshot/subscription;
  per-conversation in-memory composer drafts; request/generation guards; successful
  deletion clears current state and relevant drafts.
- `packages/chat-runtime/src/snapshot-state.ts` and `timeline.ts`: immutable state,
  stable item keys, history merge and subscription-handoff rebase already exist.
  Reload rebase can treat absence as deletion; a partial latest page must not use
  that rule to discard older cached history.
- `packages/chat-runtime/src/conversation-workspace.ts`: selection becomes ready
  after `loadConversation` completes. Cached display needs explicit coordination
  with this workflow, not only a Map inside ChatClient.
- `packages/chat-kit/src/tfrobot-client.ts`: the factory currently forwards only
  Gateway options and the Runtime error callback; cache options need explicit
  routing to Runtime.
- `ComposerDraft` contains text, long-text fragments and uploaded attachments.
  Persisting an entire draft or ChatSnapshot without a dedicated codec is unsafe.

## Proposed behavior and compatibility

1. Add optional cache configuration to ChatClient and production factories.
   Per user clarification, memory caching is enabled by default even when
   `scope` is omitted. The default scope is private to the ChatClient instance,
   not a shared process-wide `default` namespace. Supply an explicit disable
   option for callers that need the previous uncached behavior. A matching scope
   does not create an implicit global in-memory cache shared by different clients.
   Persistence still requires a separate storage port.
2. On A → B → A, publish A's cached view immediately and synchronize through the
   existing Gateway. Publish cache hit/freshness/sync-failure status separately
   from live connection assurance. Cached content remains readable on network
   failure, with an explicit offline/unsynchronized indicator.
3. Preserve the existing load operation's completion semantics: its Promise
   represents the server synchronization result, not a fabricated network
   success. Workspace reacts to cached visibility while synchronization remains
   pending, and does not replace readable cached content with a full-page error.
4. Reuse one selected-conversation subscription, generation guards, notification
   buffering and stable-key merge. Track retained historical coverage separately
   from the latest-page response. Accept server data for unchanged items, replay
   updates received during synchronization, preserve older loaded pages and
   reject stale requests after selection changes, deletion or disposal.
5. Keep existing send correlation where supported. Restore unsent text as a
   draft, never automatically resend. Do not pretend the current server contract
   can establish delivery certainty for an interrupted send without confirmation.
6. Configure capacity, freshness and eviction, including a total item/size bound
   rather than conversation count alone. Use access-time freshness checks and
   event-driven writes, with no polling. Distinguish expired-but-displayable data
   from hard-expired data. Protect the active view and make draft eviction/loss
   explicit. Provide single-conversation and entire-scope clearing.
7. Successful deletion and clear operations invalidate outstanding reads/writes
   before clearing storage. A delayed persistence write must not resurrect data.
   Specify adapter ordering/concurrency requirements for hosts that share storage
   across instances; do not claim cross-instance deletion guarantees from an
   unordered read/write port.

## Persistence and trust boundary

- Define a versioned, validated cache record distinct from live ChatSnapshot.
  Bound record size and reject mismatched scope, corruption and unsupported
  versions; continue server loading and expose a nonfatal cache error.
- Persist only the approved restore projection. Do not serialize credentials,
  arbitrary raw payloads, temporary signed URLs or native attachment objects.
  Resource references require a stable host-resolvable identity; unsafe or
  unresolvable resources become an explicit unavailable placeholder.
- Restore text and long-text drafts. Attachment restoration requires a host
  revalidation/resolution port; until validated it cannot become a sendable
  UploadedAttachment. Without that port, explain that reattachment is required.
- Cached run/interaction/capability data is not authorization to act. Do not
  restore pending Ask User controls, live-running assurance, in-flight commands
  or send permission from disk. Server synchronization establishes live truth.
- Scope is immutable for a client. Hosts replace the client on identity changes
  and explicitly clear the old scope when required. No implicit browser storage.
- An omitted scope is sufficient for in-process A/B/A caching. Cross-instance or
  restart recovery needs a stable isolation identity supplied either explicitly
  by the host or by a host-provided storage adapter already bound to that scope.
  An ephemeral instance scope must not be presented as restart persistence, and
  Kit must not guess identity from credentials, endpoints or product entities.
- Record these trust and lifecycle decisions in a proposed ADR without changing
  existing Accepted ADRs; assess any contract conflict before implementation.

## Implementation groups

1. Runtime cache/storage contracts, bounded memory policy, versioned restore
   codec, scope invalidation and persistence write coordination.
2. ChatClient load/sync/history/delete integration and safe composer restoration;
   extend protocol only for genuinely shared presentation contracts.
3. Workspace selection integration, React cache subscriptions and Ant Design
   status/attachment recovery presentation. Preserve headless consumers.
4. Factory option forwarding, public exports, host integration example, Changeset
   and versioned packed-consumer coverage.

Reuse #77 as the single delivery record. The groups above are implementation
steps, not separately deliverable substitutes for its acceptance criteria.

## Validation and delivery gates

- Memory Gateway: cache hit, miss, expiry, capacity/eviction, per-scope isolation,
  failure fallback, drafts, safe attachment restore and cache-disabled behavior.
  Include zero-configuration caching and two clients omitting scope without data
  sharing. Verify explicit disable preserves the uncached path.
- Deterministic interleavings: sync/history/live updates, pending send resolution,
  A/B/A switching, clear/delete versus outstanding load/save, disposal and shared
  storage ordering. Assert retained history and no duplicate/regressed items.
- Persistence: new-client recovery, malformed/oversized/incompatible records,
  unsafe resources, storage failures and absence of automatic resend/interaction.
- DOM/browser: cached A becomes visible before a held server response completes;
  sync failure retains content and presents the correct status; reconnection
  restores live controls only after valid synchronization.
- Controlled HTTP/Socket Gateway integration for the changed load/merge path,
  plus packed headless/React/Tauri-style consumers. No production access needed.
- Existing quality gates and an isolated full-diff review. Real external host
  E2E remains optional compatibility evidence under ADR-009.

User clarification: omitting scope must still provide a default. The earlier
explicit-scope opt-in recommendation is superseded by default instance-local
memory caching with an explicit disable option. This changes default cache
behavior; retain call signatures and document the migration escape hatch.
The user subsequently authorized implementation of this plan.
Commit, push and release require separate authorization for this feature.
