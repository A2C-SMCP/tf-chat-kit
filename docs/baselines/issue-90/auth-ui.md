# Issue 95: optional React bindings and default authentication UI

Source: GitHub issue #95, parent #90; baseline `dev-0.8.3` at
`6e10d6d06426d3cc2d0b19e4e829d007cd4ca17d`.

## Ownership and implementation

The optional `/react` and `/antd` entries operate only through Headless AuthClient.
UI does not read sessions, call REST, create ChatClients, navigate or persist
credentials. Hosts retain AuthClient ownership, select environments at startup,
provide storage and own identity-dependent chat lifecycle. No new dependencies,
polling or default browser persistence are introduced.

`useAuthSelector` subscribes to the stable raw AuthSnapshot before applying the
selector. A selector returning a fresh object therefore does not create an
unstable external-store snapshot. Client replacement unsubscribes the old binding;
unmount does not dispose the externally owned client.

Login, account selection, organization/account switching, status/logout and the
expired-session notice expose local loading, safe errors and host callbacks.
Organization choices use Headless `listAccounts`/`switchAccount`; empty choices and
unsupported capability are explicit. Login passwords are cleared after settlement
and client replacement. A replaced/unmounted binding cannot invoke its completion
callback or clear the replacement form. Busy bindings reject duplicate actions.

Labels, theme, controlled login fields, extra form fields and account labels can be
customized. An environment selector is disabled by default. When enabled it only
offers allowed canonical environments and calls the host's environment callback;
it does not mutate the current client's environment. Hosts should include the
current startup environment in the allowed list. Fewer than two choices disables
the selector; a host changing its sole allowed environment replaces the client
directly. Hosts can replace all UI using the existing headless commands.

## Verification

`tests/chat-auth-antd-dom.test.ts` mounts real React DOM and Ant Design components
with an AuthClient and its injected transport port. It drives form submission,
keyboard selection and buttons, covering customization, duplicate submission,
safe errors, password cleanup, empty/unsupported states, account and organization
selection, environment ownership, logout/expired state, Strict Mode subscriptions
and old-client completion after replacement. This is UI interaction evidence;
Manager HTTP and credential contracts remain covered by the separate local TCP
fixtures from #93/#94.

Nine focused auth/host test files pass 147 tests, including 13 new DOM scenarios.
The first isolated review found that account-selection errors disappeared after
Headless revoked the selection context. A regression reproduced the empty DOM;
the component now renders the terminal safe error without stale account choices.
Both ordinary and unsupported failures remain visible after settlement, do not
invoke the success callback and do not expose credentials.

An independent temporary consumer with no installed dependencies compiled the
headless source against ES2022 with `types: []` and executed login, session
provision, snapshot sanitization, logout rejection and dispose with Node 24.
This does not substitute for the packed artifact checks in #96. Full build/test/
Playground type checks, targeted lint, formatting, changeset coverage and both
staged/unstaged diff checks passed. Dependency checks found no violations across
310 modules and 521 dependencies. A fresh isolated review of all #95 changes
approved the final implementation with no blockers; its optional environment-list
configuration note is documented above.
Packed enabled/disabled and React/Ant Design consumers and whole-project
integration have since passed in #96; see `integration-acceptance.md` for the
final 1,415-test and packed-consumer evidence. This document does not claim production acceptance,
remote delivery or issue closure.
