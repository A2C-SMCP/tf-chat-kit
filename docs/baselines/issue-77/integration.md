# Conversation cache integration

Issue: [#77](https://github.com/A2C-SMCP/tf-chat-kit/issues/77)

## Default memory cache

```ts
import { createTFRobotChatClient } from "@turingfocus/chat-kit/headless";

const client = createTFRobotChatClient({
  ...hostGatewayOptions,
  // Optional: omitting cache and scope still enables instance-local caching.
  cache: { maxConversations: 20, maxItems: 10_000, maxBytes: 8_000_000 },
});
```

Each client owns its own LRU. Matching scope names do not create a global Map or
keep inactive conversations subscribed. Defaults are 20 conversations, 10,000
cached timeline items and 8 MB of encoded content across entries. The active
Runtime view is independent of these bounds; an oversized active view remains
usable but cannot be retained in the bounded cache. Freshness defaults to five
minutes and hard expiry to 24 hours. Both are checked on access, without polling.
Every cache hit still synchronizes with the server. Eviction and expiry are
observable through `cache.onEvent`, including whether an evicted entry had a draft.

`cache: false` preserves the previous uncached load path. The new default changes
what subscribers may see while a load is pending; existing method signatures and
the completion meaning of `loadConversation()` are unchanged. Its Promise still
reports the server result. Read cache state separately:

```ts
const subscription = client.subscribeCacheState(() => {
  const state = client.getCacheState();
  // source: none / memory / storage
  // freshness: miss / fresh / stale / expired
  // status: disabled / idle / syncing / ready / error
  renderCacheStatus(state);
});

await client.loadConversation({
  conversationId: "A",
  deadlineAt: Date.now() + 10_000,
});
await client.loadConversation({
  conversationId: "B",
  deadlineAt: Date.now() + 10_000,
});
await client.loadConversation({
  conversationId: "A",
  deadlineAt: Date.now() + 10_000,
});
subscription.dispose();
```

React exposes `useConversationCache()`. `ChatWorkspace` and
`ChatConversationView` show cached content before synchronization and keep it
readable after a network failure. Cache notices support label overrides and
closing. Cached content is explicitly offline/read-only; run controls and pending
Ask User requests are not restored as live authority. Authentication, authorization
and not-found failures invalidate the affected cached view.

## Optional persistence

Supply `ConversationCacheStorage` through `cache.storage`. No browser storage,
filesystem or credentials are selected implicitly. Its `read(scope, options)`
returns a string or null; `update(scope, transform, options)` must atomically
read, synchronously transform and commit that string. This transaction must be
serialized across adapters sharing the same backend. Implementations must honor
`deadlineAt`, including lock acquisition, and must not claim success before commit.

The default namespace is `default` **within the host-isolated adapter**. A host may
omit scope if its adapter/database is already partitioned by identity. Otherwise
provide a stable opaque scope; use the same partition on restart. Never derive
scope from a credential. Replacing identity requires a new client and, when
appropriate, clearing the previous scope. Multiple live clients sharing storage
need host-coordinated invalidation on logout; disk version checks prevent stale
writes, but do not broadcast invalidation to another client's in-memory view.

The disk envelope and each restore record are version 1. Corruption, incompatible
versions, wrong scopes and excessive data degrade to server loading. Errors are
reported without echoing raw storage contents. Explicit clear failures reject;
automatic persistence errors are nonfatal and visible via state/events.
Concurrent stale writers are rejected using scope epochs and entry revisions.

An IndexedDB adapter can implement `update` in one readwrite transaction:

```ts
import type { ConversationCacheStorage } from "@turingfocus/chat-kit/headless";

// db is supplied and isolated by the host; object store "conversation-cache"
// is created in its version-change transaction. The host owns db.close().
function storageFor(db: IDBDatabase): ConversationCacheStorage {
  const transact = (
    scope: string,
    mode: IDBTransactionMode,
    deadlineAt: number,
    transform?: (current: string | null) => string | null,
  ): Promise<string | null> =>
    new Promise((resolve, reject) => {
      const remaining = deadlineAt - Date.now();
      if (remaining <= 0) {
        reject(new Error("Cache deadline exceeded"));
        return;
      }
      const tx = db.transaction("conversation-cache", mode);
      const store = tx.objectStore("conversation-cache");
      let value: string | null = null;
      const timeout = setTimeout(() => tx.abort(), remaining);
      const request = store.get(scope);
      request.onsuccess = () => {
        try {
          if (
            request.result !== undefined &&
            typeof request.result !== "string"
          ) {
            throw new Error("Invalid cache storage value");
          }
          value = request.result ?? null;
          if (transform) {
            value = transform(value);
            if (value === null) store.delete(scope);
            else store.put(value, scope);
          }
        } catch {
          tx.abort();
        }
      };
      tx.oncomplete = () => {
        clearTimeout(timeout);
        resolve(value);
      };
      tx.onabort = () => {
        clearTimeout(timeout);
        reject(new Error("Cache transaction aborted"));
      };
    });
  return {
    read: (scope, { deadlineAt }) => transact(scope, "readonly", deadlineAt),
    update: async (scope, transform, { deadlineAt }) => {
      await transact(scope, "readwrite", deadlineAt, transform);
    },
  };
}
```

This timeout bounds one requested operation; it is not a refresh/polling timer.
The host remains responsible for encryption, quota and platform storage policy.

## Safe restored content and attachments

Persistence is a display projection, not a raw snapshot dump. It retains plain
message text, event identities/summaries, ordering and plain draft text. Long-text
draft fragments are expanded into their full text. Structured tool/raw payloads,
resource URLs, reasoning, live errors, credentials and native attachment objects
are not persisted. Rich resources become reconnect placeholders; original rich
content returns from server synchronization. Recognizable credential-shaped text
and temporary resource URLs are redacted; this is not general-purpose content DLP.

To restore draft attachments, supply `cache.attachments`:

```ts
cache: {
  storage: storageFor(hostDatabase),
  scope: hostOpaqueScope,
  attachments: {
    identify: (attachment) => hostStableFileId(attachment),
    resolve: async (fileId, { deadlineAt }) => {
      // Check current permission/existence and obtain a fresh sendable resource.
      return hostResolveAndValidateUpload(fileId, deadlineAt);
    },
  },
}
```

Keys must be short opaque identifiers, not URLs or credentials. Unresolved or
invalid attachments cannot be sent and cause a reattachment notice. Resolution
must honor the deadline and does not overwrite a draft edited in the meantime.
Restoration never sends anything automatically or revives an in-flight command.
The server remains the source of confirmed messages; delivery certainty cannot
be inferred when the server never acknowledged an interrupted send.

## Clearing and shutdown

```ts
await client.clearConversationCache("A", { deadlineAt: Date.now() + 5_000 });
await client.clearCache({ deadlineAt: Date.now() + 5_000 });
await client.flushCache({ deadlineAt: Date.now() + 5_000 });
await client.dispose({ deadlineAt: Date.now() + 5_000 });
```

Clear APIs remove the affected cached entries and drafts and invalidate pending
loads; they do not delete the server conversation or remove it from Workspace.
Clearing a restored offline view empties its timeline and draft while retaining
the selection; selecting it again reloads from the server. Explicit server deletion also
invalidates its cache and retires the selected view/subscription. Clear and delete
serialize after earlier writes, preventing late writes from resurrecting records.
Disposal drains scheduled persistence and releases the existing Gateway ownership.
It does not delete persisted records, because they are intended for later recovery.

## Verification

`chat-conversation-cache.test.ts` covers memory policy, restoration, failures,
scope isolation and concurrency. `chat-conversation-cache.integration.test.ts`
uses a real local HTTP server, Socket.IO connections and atomic file writes to
verify cache-first switching, live updates and new-client disk restoration.
The DOM vertical-slice suite verifies that cached content is visible before a held
server response completes. No production data or external credentials are used.

## Local delivery evidence (2026-09-10)

The implementation belongs to Runtime, with React, Ant Design UI and Kit facade
bindings. `ConversationCacheOptions`, `ConversationCacheStorage`,
`CachedAttachmentResolver`, cache state/event types, ChatClient clear/flush/state
methods and `useConversationCache` are public. ADR-011 records the restore trust
boundary and supplements the existing Accepted ADRs without moving authentication
or transport ownership.

Validation completed on Node 24.20.0 / pnpm 10.34.5:

- `pnpm check`: passed, including workspace/Changesets/dependency boundaries,
  lint, formatting, type checks, 54 test files / 1095 tests, Playground build and
  packed artifact validation for all seven packages.
- The final focused Runtime/cache/Workspace/UI run passed 175 tests. This includes
  real local HTTP and Socket.IO traffic with atomic file persistence, plus delayed
  response, clear/delete, draft, attachment and capacity boundary regressions.
  The subsequent attachment-notice restoration adjustment passed type checks,
  lint and 55 cache/integration/UI tests, including A/B/A notice retention.
- Packed consumers cover Headless without React, React without Ant Design or a
  production Gateway, minimum React 18.2, Ant Design 5.23.4/5.29.3, Tauri-style and
  the versioned TFRobotFront-style host. Tauri-style coverage exercises default
  cache-first switching through installed public package exports.

The server evidence is the repository's controlled REST/Socket.IO contract
fixture, not a deployed TFRobotServer release certification. No production
credentials, host repositories or UAT/Seed data were changed. External host/service
E2E remains optional compatibility evidence under ADR-009 and was not run.

Default memory caching is the new path; `cache: false` is the compatibility escape
hatch. Persistence remains opt-in. No polling, extra live subscriptions, navigation
freeze/retirement change or offline send queue is introduced. Resource bounds are
covered by capacity tests; no new throughput or latency benchmark claim is made.
Hosts still own durable storage, isolation, logout/identity invalidation and
attachment resolution. No external implementation dependency blocks this Kit
change; tfrobot-client#78 remains independently deliverable.

This evidence describes local changes awaiting separate commit authorization;
it does not represent a published package or a completed external host rollout.

Final isolated review: APPROVE, zero blocking findings. One nonblocking follow-up
remains under the default block-only review scope: clearing an individual
conversation's restored draft may retain its unavailable-attachment notice count
until a later state refresh. The draft and cache are cleared correctly; the stale
notice grants no send permission. Whole-scope clearing already resets the count.
