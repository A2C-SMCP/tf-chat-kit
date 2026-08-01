# Playground acceptance map

All automated scenarios run only against the repository-owned Memory Gateway or
the approximate HTTP/Socket.IO service. A real RobotServer remains an optional
manual compatibility target and is never required by CI.

## Parent #10

| Acceptance criterion                                                                                                              | Evidence                                                                                                                         |
| --------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Local Playground at `http://localhost:3000` using the formal Runtime, React, and Ant Design packages                              | Playwright starts the private Vite app on port 3000; workspace aliases and the production build are checked by `pnpm check`.     |
| Mock mode covers conversations, messages, streaming, interrupt, and errors without an external project                            | `Mock mode renders and exercises the formal Runtime scenarios`.                                                                  |
| Real mode derives HTTP/Socket settings from service origin, Namespace and Robot ID, and accepts password/Bearer/Admin credentials | Password, Bearer and Admin Playwright scenarios plus parser/proxy tests; direct endpoints and creator overrides remain advanced. |
| A compatible RobotServer supports query, create, send, realtime updates, and interrupt                                            | `Bearer mode covers create, send, stream, interrupt, reconnect, CORS and disposal`.                                              |
| Retained test sessions use `[tf-chat-kit playground] <time>` and expose no rename/delete/cleanup action                           | Bearer scenario verifies the retained server title; Playground component tests verify the fixed operation surface.               |
| Passwords and Tokens remain in page memory and never enter storage, Cookie, URL, environment, or logs                             | Password/Bearer live browser-state assertions, mode-switch/reload checks, proxy and component security-boundary tests.           |
| Protocol, Memory/TFRobot Gateways, Playground components, and browser E2E run without a real RobotServer                          | Vitest suites, this Playwright suite, and the CI quality job.                                                                    |
| No public package or foreign project source is added; failures are understandable                                                 | Workspace policy, package gates, repository-owned mock, and safe proxy/401/403/Socket/protocol scenarios.                        |

## Issue #15 connection invariants

| Invariant                                                                                                                        | Evidence                                                                                                  |
| -------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Standard mode uses blank service-origin, Namespace and Robot ID fields instead of a chat-player URL                              | Component test asserts blank initial values; target parser and all three authenticated browser paths run. |
| Password exchange, Bearer/Admin headers, routing headers, JSON content type, Socket auth, connection, and reconnect are observed | Password/Bearer/Admin scenarios assert only sanitized counters recorded by the approximate server.        |
| Passwords and Tokens stay in page memory and are cleared across connection, mode switch and reload boundaries                    | Proxy, component and browser-state assertions cover DOM, URL, Cookie, storage and console output.         |

## Issue #16 runtime and CI invariants

| Invariant                                                                     | Evidence                                                                                                                                             |
| ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Memory and TFRobot use the same Runtime semantics                             | Both browser modes create/select/send through `ChatConversationView` and `ChatClient`; Gateway contract suites cover normalized results.             |
| Missing or wrong REST and Socket credentials cannot succeed                   | `the approximate server rejects missing and wrong REST and Socket credentials`.                                                                      |
| Credentials are not persisted or logged, and mode changes release connections | Bearer checks live, Mock-mode-switch and reload state, with zero active sockets after each disposal boundary.                                        |
| Regular CI is external-service independent                                    | CI installs Chromium and runs `pnpm test:e2e` against the two local web servers from `playwright.config.ts`.                                         |
| A real RobotServer is optional and manual                                     | Follow the real-mode instructions in the root README; feed any incompatibility back into the local mock or fixtures before changing production code. |
