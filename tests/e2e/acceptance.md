# Playground acceptance map

All automated scenarios run only against the repository-owned Memory Gateway or
the approximate HTTP/Socket.IO service. A real RobotServer remains an optional
manual compatibility target and is never required by CI.

## Parent #10

| Acceptance criterion                                                                                     | Evidence                                                                                                                     |
| -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Local Playground at `http://localhost:3000` using the formal Runtime, React, and Ant Design packages     | Playwright starts the private Vite app on port 3000; workspace aliases and the production build are checked by `pnpm check`. |
| Mock mode covers conversations, messages, streaming, interrupt, and errors without an external project   | `Mock mode renders and exercises the formal Runtime scenarios`.                                                              |
| Real mode configures HTTP/Socket endpoints, `platformId`, creator, Bearer, and Admin credentials         | Bearer and Admin Playwright scenarios plus `tests/playground-robotserver.test.ts`.                                           |
| A compatible RobotServer supports query, create, send, realtime updates, and interrupt                   | `Bearer mode covers create, send, stream, interrupt, reconnect, CORS and disposal`.                                          |
| Retained test sessions use `[tf-chat-kit playground] <time>` and expose no rename/delete/cleanup action  | Bearer scenario verifies the retained server title; Playground component tests verify the fixed operation surface.           |
| Credentials remain in page memory and never enter storage, Cookie, URL, environment, or logs             | Bearer live/mode-switch/reload browser-state assertions and the component security-boundary test.                            |
| Protocol, Memory/TFRobot Gateways, Playground components, and browser E2E run without a real RobotServer | Vitest suites, this Playwright suite, and the CI quality job.                                                                |
| No public package or foreign project source is added; failures are understandable                        | Workspace policy, package gates, repository-owned mock, and safe 401/403/CORS/Socket/protocol unit scenarios.                |

## Issue #16 invariants

| Invariant                                                                                                  | Evidence                                                                                                                                             |
| ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Memory and TFRobot use the same Runtime semantics                                                          | Both browser modes create/select/send through `ChatConversationView` and `ChatClient`; Gateway contract suites cover normalized results.             |
| Missing or wrong REST and Socket credentials cannot succeed                                                | `the approximate server rejects missing and wrong REST and Socket credentials`.                                                                      |
| Bearer/Admin headers, JSON content type, Socket auth, CORS, initial connection, and reconnect are observed | Bearer/Admin scenarios assert only sanitized counters recorded by the approximate server.                                                            |
| Credentials are not persisted or logged, and mode changes release connections                              | Bearer checks live, Mock-mode-switch and reload state, with zero active sockets after each disposal boundary.                                        |
| Regular CI is external-service independent                                                                 | CI installs Chromium and runs `pnpm test:e2e` against the two local web servers from `playwright.config.ts`.                                         |
| A real RobotServer is optional and manual                                                                  | Follow the real-mode instructions in the root README; feed any incompatibility back into the local mock or fixtures before changing production code. |
