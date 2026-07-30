# TFCK-12 non-TFRobotFront consumer matrix

- Scope: deterministic Kit-repository consumer evidence
- Source hosts: Office Add-in and Tauri repositories, inspected read-only
- Real host status: not validated by this evidence

## Boundary

The committed consumers are copied into system temporary directories and
installed from the versioned tarballs listed in
`.artifacts/packages/manifest.json`. They do not import either host repository,
host stores, routers, socket managers, platform SDKs or persistent
authentication.

This evidence proves that the published package surface can support two
non-TFRobotFront integration topologies. It does not prove that an Office
Add-in or Tauri product has installed, released or accepted Chat Kit. Real
second-host validation remains optional compatibility evidence; TFCK-1 is
gated by these repository-owned versioned consumer topologies instead.

## Read-only host evidence

| Host          | Revision                                                                                                                      | Dependency evidence                                                                                               | Topology evidence                                   |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Office Add-in | [`JIAQIA/office-editor4ai@449bde0`](https://github.com/JIAQIA/office-editor4ai/tree/449bde0ce35950569e139c6b40f819f94836a3c1) | `excel-editor4ai/package.json` declares React `^18.2.0`; `pnpm-lock.yaml` resolves React `18.3.1`                 | `excel-editor4ai/src/taskpane/index.tsx`, Fluent UI |
| Tauri client  | [`A2C-SMCP/tfrobot-client@9bda5a1`](https://github.com/A2C-SMCP/tfrobot-client/tree/9bda5a183a31029271e75e4d51ba37e4d4de8513) | `package.json` declares React `^18.3.1` and Ant Design `^5.23.4`; `pnpm-lock.yaml` resolves `18.3.1` and `5.29.3` | `src/main.tsx` StrictMode root, `tsconfig.json`     |

The revisions above identify the immutable host state inspected for this
matrix. The repositories remain external evidence: CI does not clone them, and
their source or lockfiles are not inputs to the committed consumers.

## Consumer matrix

| Consumer     | Host evidence                                                                                          | Installed Chat Kit packages                      | Consumer compatibility target                                     | Verified topology                                                |
| ------------ | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------ | ----------------------------------------------------------------- | ---------------------------------------------------------------- |
| Office style | Declared React range starts at 18.2; inspected lock resolves 18.3.1; Task Pane root uses Fluent UI     | Protocol, Runtime, React, Testing                | React 18.2.0 supported lower bound                                | Unstyled React, Memory Gateway, opaque SessionProvider injection |
| Tauri style  | Declared Ant Design range starts at 5.23.4; inspected lock resolves 5.29.3; root uses React StrictMode | Protocol, Runtime, React, UI Ant Design, Testing | React/ReactDOM 18.3.1 and Ant Design 5.23.4 supported lower bound | StrictMode UI/Runtime tree with host-owned platform ports        |

The host repositories are behavior and dependency evidence only. No source,
configuration, generated artifact or dependency from either repository is
copied into this repository.

The committed consumers intentionally pin the package-supported peer lower
bounds rather than reproduce the inspected hosts' resolved dependency graphs.
The Tauri-style consumer combines that lower-bound check with the inspected
host's StrictMode topology and `skipLibCheck: true` setting. Ant Design 5.23.4
and its pinned rc-* dependencies contain the declaration defects documented in
`docs/engineering-baseline.md`; the separate minimum UI consumer continues to
compile the packed UI without `skipLibCheck`, so this host-specific setting does
not replace the package-level declaration gate.

## Automated evidence

`pnpm run pack:check` builds the six workspace packages, packs them, creates
isolated consumer projects and verifies:

- the Office consumer installs no Ant Design, ReactDOM, Office, Next.js, Tauri
  or TFRobotFront dependency;
- each consumer compiles and runs using only packed public entry points;
- installed package names, versions and repository metadata match the pack
  manifest;
- the Office topology keeps two clients, Memory Gateways, SessionProviders,
  snapshots and subscriptions isolated;
- load, realtime subscription, text send and Run interrupt complete through
  public Runtime commands;
- replacing one `OwnedChatProvider` fully disposes only its prior client and
  Gateway, while unmount fully disposes all remaining provider-owned clients
  and Gateways;
- construction does not eagerly read session material and disposed instances
  ignore late events;
- the Tauri topology mounts the packed Ant Design shell in the same tree as the
  Runtime provider while window, file and tray behavior remains behind a
  host-owned narrow port;
- mounted host controls reach the mock platform port, while Chat Kit commands
  do not invoke it;
- React StrictMode effect replay replaces and fully disposes its rehearsal
  client and Gateway before the active instance completes the desktop flow;
- disposed Gateways report no live observers, accept no late deliveries and
  surface no hidden provider cleanup errors.

All session values are generated, non-production values held only in memory.
The consumers do not write credentials to their manifests, logs, repository
files or packed artifacts.

## Reproduction

Use the repository toolchain baseline:

```bash
corepack prepare pnpm@10.34.5 --activate
pnpm install --frozen-lockfile
pnpm run pack:check
```

The authoritative CI result uses Node.js 24.x. A local result on another
Node.js version is supporting evidence only.

## Completion semantics

This matrix satisfies TFCK-12's Kit-side mock-consumer scope and guards the
public reuse boundary. It must be reported as deterministic mock evidence, not
as production Office or Tauri validation. Login, Office lifecycle behavior,
Tauri platform permissions, real endpoints, rollout and product acceptance
remain host responsibilities.
