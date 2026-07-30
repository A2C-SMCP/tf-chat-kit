# TFCK-11 Kit-side host consumer validation

- Scope: TFCK-33, TFCK-35 and TFCK-36 Kit-side integration evidence
- Evidence type: deterministic Kit-repository mock consumer
- Real host status: not validated by this evidence

## Boundary

The committed consumer models the dependency injection and lifecycle shape
required by a Web + React + Ant Design host without importing TFRobotFront,
Next.js, a host store, a router, a global socket or persistent authentication.
It is copied into a system temporary directory, installed from the tarballs
listed in `.artifacts/packages/manifest.json`, type-checked, built and run.

This proves that the published package surface can compose a host adapter. It
does not prove that TFRobotFront has installed, enabled, grey-released or
accepted the new path. Login, refresh, routing, platform selection, the real
Feature Flag and legacy removal remain host responsibilities.

## Automated evidence

`pnpm run pack:check` verifies:

- the installed package name, version and GitHub repository metadata match the
  packed artifacts;
- API and Socket endpoints, `SessionProvider`, message creator, Ant Design
  theme, diagnostics and lifecycle callbacks are injected by the consumer;
- the packed public `ChatStateView` renders beneath each host-owned Ant Design
  theme boundary instead of merely being present in the installed manifest;
- rendering and client construction do not eagerly read session or identity
  material;
- two mounted clients keep conversation state, HTTP authentication, endpoints
  and Socket authentication isolated;
- message creator lookup occurs only when text is sent and remains scoped to
  the active conversation;
- replacing a stable React factory disposes only its previous client, while
  unmount disposes all remaining provider-owned clients and disconnects their
  sockets;
- controlled Socket failures containing synthetic HTTP and Socket
  credential-shaped values reach the correct diagnostic callback with those
  values redacted.

The fixture uses generated, non-production session values held only in memory.
It writes no token, cookie, API key or identity to the repository, temporary
consumer manifest, logs or packed artifacts.

## Reproduction

Use the repository toolchain baseline:

```bash
corepack prepare pnpm@10.34.5 --activate
pnpm install --frozen-lockfile
pnpm run pack:check
```

The authoritative CI result must use Node.js 24.x. A successful run on another
Node.js version is useful local evidence but does not replace that gate.

## Follow-up

- TFCK-35 adds a test-only, event-driven lifecycle controller around this
  consumer boundary. It serializes each ownership handoff and never activates
  the replacement until the selected path has disposed successfully.
- TFCK-36 adds the V1 vertical behavior checks over memory and controlled
  TFRobot Gateways.
- TFCK-37 collects the final Kit-side report. Production Socket validation is
  an optional external E2E observation; the controlled Gateway contract remains
  the repository-owned compatibility gate.

## Feature Flag lifecycle model

The model accepts one host-owned Boolean selection and maps it to `legacy` or
`kit`. It does not read an environment variable, router, global store or
production flag service.

| Transition             | Required result                                                          |
| ---------------------- | ------------------------------------------------------------------------ |
| Initial/off            | One legacy mock owns its client, gateway and subscription                |
| off → on               | Legacy disposes by a fresh deadline before Kit activates                 |
| on → off               | Kit disposes by a fresh deadline before a new legacy mock activates      |
| Send during handoff    | New sends fail closed; an accepted send finishes before disposal starts  |
| Effect replay          | Superseded requests are coalesced; only the latest selection activates   |
| Kit creation failure   | Partial Kit resources clean up and fallback to legacy is observable      |
| Disposal failure       | Transition fails closed; no replacement activates until cleanup succeeds |
| Rollback while blocked | Retained ownership cleans up, then a fresh selected path activates       |
| Route-style unmount    | The selected path disposes and no later notification is delivered        |

The controller and its tests remain under `tests/`; they are host integration
guidance, not a Runtime API or production grey-release implementation.

## V1 vertical consumer

`tests/tfrobotfront-v1-consumer.test.ts` composes only public Protocol,
Runtime, React and ui-antd APIs. Test controllers simulate server and transport
input outside the React tree; UI commands can reach a Gateway only through the
injected `ChatClient`. A mounted `useChatSnapshot` consumer renders realtime
items with `ChatTimelineItem` and transport failures with `ChatStateView`, so
these assertions do not remount the Kit path to read a newer snapshot.

| Evidence                                       | Memory Gateway            | Controlled TFRobot Gateway       |
| ---------------------------------------------- | ------------------------- | -------------------------------- |
| Controlled session load and client replacement | yes                       | yes                              |
| Initial history and active Run rendering       | yes                       | yes                              |
| Realtime message and unknown-event fallback    | yes                       | yes                              |
| Text send and interrupt from UI controls       | yes                       | yes                              |
| Command error callback and disconnect state    | yes                       | yes                              |
| Theme, labels and platform context injection   | yes                       | yes                              |
| Replacement/unmount cleanup and no late event  | yes                       | yes                              |
| Missing send/interrupt capabilities            | normalized memory fixture | fixed TFRobot capability profile |

The capability-absence case is intentionally exercised with the normalized
Memory Gateway. The controlled TFRobot adapter advertises its fixed supported
capability profile, so the test does not fabricate an impossible transport
event to make that column pass. Package-level Gateway and Runtime contracts
remain the source of truth for adapter parity.

Run the focused evidence with:

```bash
pnpm exec vitest run \
  tests/chat-path-lifecycle.test.ts \
  tests/tfrobotfront-v1-consumer.test.ts
```

This is deterministic mock evidence. It excludes login, platform CRUD,
attachments, routing, a production Feature Flag and real TFRobotFront
deployment or grey-release claims.
