# ADR-011: Conversation cache and restore trust

- Status: Accepted
- Date: 2026-09-10
- Approval: Issue #77 implementation plan approved in the user session, including
  the clarification that scope omission must have a default.
- Supplements: ADR-002, ADR-004, ADR-006, ADR-009 and ADR-010

## Decision

Runtime owns a bounded per-client conversation memory cache, enabled by default.
An explicit `cache: false` retains the uncached load path. Scope omission uses an
instance-local memory namespace; the same name never creates a process-global
cache or subscription. No new package or dependency direction is introduced.

Host-provided persistence is optional. Its default namespace is meaningful only
inside storage already isolated by the host. Hosts using a shared database must
provide appropriate opaque scopes and coordinate invalidation across their live
clients. Identity, credential storage, encryption and platform APIs remain host
responsibilities. Kit does not derive scope from product entities or credentials.

Disk records are a versioned display projection, not serialized live authority.
Recoverable text, ordering and safe summaries may be shown before a server load
completes. Credentials, arbitrary raw/tool payloads, native attachment objects and
temporary resource URLs are excluded. Attachment identities require explicit host
revalidation before becoming sendable. Interrupted sends are never replayed.

Cached views expose an offline lifecycle and no send, interrupt or answer rights.
Cache freshness and synchronization status are separate Runtime observations;
they do not redefine Gateway recovery assurance. The existing load Promise still
reports server synchronization, even when cached content is already visible.
Workspace can keep readable cached content on a network failure.

Only the selected conversation has a live subscription. Synchronization reuses
the existing notification queue, stable identities and generation guards, keeps
loaded historical coverage and traverses a bounded cursor gap when necessary.
Server data remains authoritative; no guarantee is made for transient events the
server never persisted or for unacknowledged command delivery.

Storage updates are atomic scope transactions. Scope epochs, entry revisions and
instance request generations prevent stale writes or reads from reviving cleared
or deleted data. Event-driven coalescing bounds write backlog; no refresh polling
is introduced. Storage failures do not prevent server loading; explicit clear
operations surface failures to their caller.

## Compatibility and verification

This is an additive API with a documented change in default loading presentation.
Consumers requiring exclusively network-first snapshots can opt out. Cached
capabilities cannot authorize operations, including for a custom headless UI.
Existing Accepted ADR ownership and transport boundaries remain in force.

Verification uses Memory Gateway interleavings, real local HTTP/Socket.IO and file
storage, DOM timing assertions and versioned packed consumers. Real external
host/service E2E remains optional under ADR-009. Navigation retention in
tfrobot-client#78 is independent and is not implemented by this ADR.
