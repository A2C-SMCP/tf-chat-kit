# Optional authentication compatibility matrix

Code baseline: `dev-0.8.3` / `6e10d6d06426d3cc2d0b19e4e829d007cd4ca17d` plus
the current uncommitted #46/#92–#96 changes. This matrix distinguishes controlled
local contracts from production-service evidence; one does not replace the other.

| Boundary                                     | Baseline                                                                      | Evidence                                                                                                                                                                  | Result / limitation                                                                                                    |
| -------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Auth-disabled Chat Kit                       | Existing facade and manually injected SessionProvider                         | Packed React, Office and Tauri consumers compile/run; installed-package checks exclude `chat-auth`                                                                        | Passed; no automatic auth dependency or initialization                                                                 |
| Headless optional auth                       | Packed `@turingfocus/chat-auth` public `/headless` and `/tfrobot` exports     | Independent ES2022/types-empty installation executes selection, refresh, restore, switch, logout and scope isolation without React/AntD                                   | Passed; injected transport tests lifecycle, not a production refresh API                                               |
| React optional auth                          | Packed public `/react` export; React 18.3.1                                   | Strict Mode, subscriptions, fresh-object selector, client/environment replacement and externally owned client after unmount                                               | Passed; AntD absent from installed dependencies                                                                        |
| Default authentication UI                    | Packed public `/antd`; AntD 5.23.4                                            | Real DOM keyboard account switching, logout, expired state and credential absence                                                                                         | Passed; workspace DOM suite additionally covers login/customization/error/empty/unsupported states                     |
| Manager authentication contract              | Five issue #93 routes and DTOs from read-only Manager source                  | `chat-auth-tfrobot.integration.test.ts` runs actual local TCP HTTP requests, DTO/error mapping, selected/switched bearer `/me` verification and Gateway invalidation      | Passed against controlled fixture; production Manager version and deployment coverage unverified                       |
| Restore and renewal                          | Version-1 host-injected credential record; expiry in epoch milliseconds       | Credential suites verify scope, `/me` bearer, concurrency, clocks, store failures and bounded retry; local HTTP fixture supplies an explicitly fixture-only renewal route | Passed; no production renewal endpoint inferred or implemented                                                         |
| Missing renewal strategy                     | Manager user JWT refresh contract not supplied                                | 401/near-expiry tests enter `auth_required`, revoke session and do not replay passwords or invent network calls                                                           | Safe fallback passed; production refresh path, rotation, TTL, revocation and error contract remain external/unverified |
| Chat ownership                               | Private Playground identity scope; host owns ChatClient, cache and navigation | Scope tests retain refresh identity, dispose old instance on switch and reject held old loads; existing Playground regression                                             | Passed locally; public auth does not create ChatClients or control host navigation                                     |
| RobotServer subscription recovery            | Controlled HTTP + Socket.IO fixtures                                          | #46 tests cover rejected preflight, matching replacement REST/Socket session, retry bound, generation and provisional/persisted identity                                  | Passed locally; external-service follow-up remains required by #46                                                     |
| Real Manager → BFF → RobotServer             | Earlier 2026-10-09 exploratory run observed RobotServer image 0.3.7           | #100/#101 reports, now tracked under #46; #102 under #97                                                                                                                  | Earlier failures are recorded, not counted as fixed-service acceptance; no new production pass claimed                 |
| Direct Manager/RobotServer API compatibility | Earlier direct issuer-mismatch observation                                    | Existing recovery baseline explicitly separates direct API from the BFF path                                                                                              | Unverified; BFF success must not imply direct-token compatibility                                                      |

Production refresh support remains an external contract dependency. To remove that
limitation, the service owner must provide endpoint/request/response shapes,
credential rotation and expiry rules, revocation semantics and stable error codes.
Until then, hosts may inject a confirmed strategy or use the tested auth-required
fallback. Saving passwords or claiming silent production renewal is prohibited.

Fresh public-metadata check on 2026-10-09: the previously recorded direct robot
now advertises the production authorization server `https://api.turingfocus.cn`
and production resource issuer rather than September's staging value. This is
public discovery evidence only: actual JWT verification and the authenticated
direct flow remains unverified. Restarted Playwright restored the real BFF session:
one injected status 401 recovered through Token Exchange 200 to status 200 and
a connected UI. That run exposed message duplication and creation-title loss;
repairs passed focused tests and fresh isolated review. The repaired real BFF flow subsequently passed two injected-401 recoveries,
unique persisted/DOM messages, a post-recovery live reply, retained creation title
and exact-ID manual/automatic cleanup. Direct issuer and full verified Server
profile acceptance remain separate and unverified.

The combined packed auth/Chat Kit boundary also passes in two independent projects.
The headless project installs both tarballs without React/React DOM/AntD; the UI
project mounts the public auth and chat Providers and default components. Both
use the public SessionProvider/facade against actual local HTTP and Socket.IO,
including on-demand credentials, message sending/realtime delivery, verified
account switching, old-client disposal and late-response rejection, fresh cache
scope and logout. UI assertions verify server content, removal of the prior
account's history and credential absence. These are controlled local contracts,
not additional production-service compatibility claims.

Credentials remain in private transport/client state or a host-owned scoped
CredentialStore. They are excluded from snapshots, UI, logs, raw diagnostics and
published artifacts. Test credentials are synthetic and temporary consumer source
does not enter published tarballs. Whole-project gates, final isolated review and
remote delivery are tracked separately in `integration-acceptance.md`.
