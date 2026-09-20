# Playground acceptance map

All automated scenarios run only against the repository-owned Memory Gateway or
the approximate HTTP/Socket.IO service. A real RobotServer remains an optional
manual compatibility target and is never required by CI.

## Issue #97 identity and ChatKit separation

| Acceptance criterion                                                                                                                   | Evidence                                                                                                                                                                                                               |
| -------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mock ChatKit can render before login and remains independent from identity state                                                       | `Mock ChatKit does not require login and the identity toolbar can log out`                                                                                                                                             |
| Identity supports Mock/Manager, staging/production/custom Manager, account or organization context, robot directory and logout         | The three Manager browser scenarios plus the logout flow in `tests/e2e/playground.spec.ts`                                                                                                                             |
| Manager robot directory keeps employee ID, robot ID and robot account ID distinct, and strips legacy token fields from routing headers | `tests/playground-manager-directory.test.ts`                                                                                                                                                                           |
| RobotServer mode keeps the existing explicit credential form and releases the previous ChatKit instance before reconnecting            | Bearer/Admin/password RobotServer scenarios and the existing lifecycle assertions                                                                                                                                      |
| Manager bearer is not silently reused as a RobotServer credential; automatic connection remains capability-gated                       | Manager connection-info plus RFC 8693 exchange tests verify `robot:{robotAccountId}`, `chat:read chat:send`, `token_profile=session`, short-token caching, and the manual fallback for robots without `robotAccountId` |
| Public ChatKit package boundaries and authentication ownership remain unchanged                                                        | No public ChatKit runtime/UI package API was changed by this feature; the separate `chat-auth` transport compatibility fixes remain host-independent and are covered by their own tests                                |

## Parent #10

| Acceptance criterion                                                                                                              | Evidence                                                                                                                         |
| --------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Local Playground at `http://localhost:4311` using the formal Runtime, React, and Ant Design packages                              | Playwright starts the private Vite app on port 4311; workspace aliases and the production build are checked by `pnpm check`.     |
| Mock mode covers conversations, messages, streaming, interrupt, and errors without an external project                            | `Mock mode renders and exercises the formal Runtime scenarios`.                                                                  |
| Real mode derives HTTP/Socket settings from service origin, Namespace and Robot ID, and accepts password/Bearer/Admin credentials | Password, Bearer and Admin Playwright scenarios plus parser/proxy tests; direct endpoints and creator overrides remain advanced. |
| A compatible RobotServer supports query, create, send, realtime updates, and interrupt                                            | `Bearer mode covers create, send, stream, interrupt, reconnect, CORS and disposal`.                                              |
| Test sessions use `[tf-chat-kit playground] <time>` and can be renamed/deleted only while retaining that reserved prefix          | Bearer scenario renames and deletes the created session; Playground component tests verify the host-owned safety policy.         |
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

## Issue #17 event detail invariants

| Invariant                                                                                              | Evidence                                                                                                                            |
| ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| Messages remain in the left timeline while Agent, Tool and unknown events use compact selectable rows  | UI renderer tests and both Playground modes exercise the package-default compact event renderer.                                    |
| Wide auto mode starts split with an empty detail pane and selection changes only after user activation | Unit tests cover empty state, click/keyboard selection, same-ID updates and new-event non-stealing; Mock browser flow covers split. |
| Narrow auto mode opens a Modal, while a per-instance manual mode overrides responsive selection        | Unit tests cover controlled and uncontrolled modes; browser flow resizes, opens Modal, closes by Escape and restores trigger focus. |
| Generic, Tool, transitions, Ask User, failure and unknown details fail safely without exposing raw     | Renderer and event-detail suites cover structured variants, bounded values, error isolation and raw redaction.                      |
| Existing custom renderer, virtual timeline, tail follow, send and interrupt behavior remains intact    | Existing UI, virtualization and scroll suites remain gates; Mock and Bearer browser scenarios still send, stream and interrupt.     |
| Mock and approximate RobotServer Playground modes use public package components                        | Mock and Bearer Playwright scenarios select package-default event rows and switch between split and Modal modes.                    |
| Front-style and Tauri-style consumers can adopt the public API without host-owned internals            | Source-level Front-style suite mounts split mode; the packed Tauri consumer selects a row and opens event detail.                   |

## Issue #58 capability demonstrations

Start `pnpm dev:playground`, open `http://localhost:4311`, and use the **能力演示**
buttons in Mock mode. Switching scenarios replaces the current local demo timeline and cancels
pending mock streaming; the input draft remains. **重建实例** resets the demo and its private-resource
failure simulation. RobotServer mode does not expose these mock fixtures or document/resource ports.

| Scenario         | Browser acceptance                                                                                                              |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| 工具呈现         | Browser screenshot, Preview syntax, Editor readonly diff, Shell ANSI output, actual Download bytes; previous/next navigation    |
| 媒体与资源       | Local WAV and WebM playback advances currentTime; private image fails once and succeeds on 重试资源; contact/file/URL cards     |
| Markdown 与复制  | GFM table, local private image and exact second-block clipboard text                                                            |
| 长结果与事件导航 | Full received result expansion, both transition tabs, follow latest vs manual selection; 390px modal and no horizontal overflow |
| 文档引用         | Injected source selection, reference draft placeholder, sending both original text paragraphs through Runtime                   |

Run `TF_CHAT_PLAYGROUND_PORT=4312 pnpm test:e2e` while keeping the manual playground on port 4311.
The four added tests live in `capability-scenarios.spec.ts`; screenshots are written under `test-results/`
for tool detail, media, references and mobile inspection. They exercise real Chromium media playback,
clipboard and download APIs, with no route interception or external data. This is local browser
acceptance, not a production RobotServer or real-host UAT claim.

All demo assets in `playground/public/demo/` are repository-authored synthetic samples: the SVG and
report contain no production data; WAV is a 440Hz sine tone; WebM is an FFmpeg testsrc2 pattern.
Recreate media with `ffmpeg -f lavfi -i 'sine=frequency=440:duration=2' -ar 16000 tone.wav` and
`ffmpeg -f lavfi -i 'testsrc2=size=320x180:rate=12:duration=3' -c:v libvpx -b:v 90k -an clip.webm`.
The mock resource port is a local URI mapping demonstration; it does not authenticate a real account.

Acceptance run (2026-09-08): all 9 Playwright tests passed (4 new, 5 existing), plus 5 Playground
component tests, typecheck, lint, formatting and playground production build. Desktop and mobile
screenshots were visually inspected. Isolated review of the 11 follow-up files: **APPROVE**.
Non-blocking follow-ups: explicit draft-preservation/stream-cancellation tests, and clearing the active
scenario highlight when changing conversations.

## Issue #75 resource failures and copy

The media scenario now throws the public `expired` resource error and shows Chinese expiry/retry
copy through the conversation labels. The focused capability browser tests verify recovery to a
loaded image, actual audio/video playback, and downloaded file bytes with Chinese resource actions.
The resource component suites cover English/Chinese port failures, cancellation and stale scopes;
real local HTTP tests cover status classification and connection failures. No external seed or
production resource is used.

## Issue #82 session notices and diagnostics

Use the Mock mode “服务端错误” action twice. The conversation keeps one fault banner,
while Diagnostics retains both occurrences. Keyboard Enter opens the diagnostic modal;
copy the current conversation and an individual record, close with Escape and verify
focus returns to the trigger. Chat content and input remain separate from notices.

Focused browser gate: `TF_CHAT_PLAYGROUND_PORT=4312 pnpm test:e2e tests/e2e/session-diagnostics.spec.ts`.
Timing, recovery, cache and instance disposal are additionally covered by deterministic
DOM/Runtime suites, with actual HTTP/Socket.IO metadata tested on ephemeral local ports.
No server seed, external credentials or production data are required.

## Issue #84 long-history redaction on JavaScriptCore

`pnpm exec vitest run tests/chat-redaction-performance.test.ts` verifies credential
semantics and preservation of long transport strings. On macOS with the system
`jsc` helper, it also runs the production sanitizer after warmup on 12K, 24K and
200K synthetic strings, with a one-second per-input budget and a subprocess
timeout. The system-engine check is explicitly skipped where that helper is absent.

Install the browser with `pnpm exec playwright install webkit`, then run
`pnpm test:e2e tests/e2e/long-history-webkit.spec.ts`. CI installs WebKit alongside
Chromium. This test uses WebKit and a real local HTTP/Socket.IO fixture to load
200K characters through the public headless factory and Runtime. It verifies the
five-second load deadline, complete non-sensitive tool text and removal of both
embedded and session credentials from the snapshot. It does not intercept fetch
or substitute the Gateway. No external seed or private history is used.

The original macOS client/private conversation remains a separate host retest;
this gate does not claim that the client has upgraded or that production history
has been verified. There are no server DTO, host API or feature-flag changes.

Verification on 2026-09-15: macOS 14.2 system JavaScriptCore processed 12,004 /
24,004 / 200,005 characters in 2 / 2 / 48 ms after warmup, preserving the input.
WebKit in the Playwright 1.62.1 Noble container loaded the 200K history fixture in
557 ms. The bundled macOS WebKit build crashed before executing the test on this
machine; the container result is separate from the system-JavaScriptCore result.
When the local browser cannot start, the same test can use a container browser
without mounting the repository (run the server in another terminal):

```sh
docker run --rm --init --shm-size=1g -p 127.0.0.1:3002:3002 mcr.microsoft.com/playwright:v1.62.1-noble npx -y playwright@1.62.1 run-server --port 3002 --host 0.0.0.0
PW_TEST_CONNECT_WS_ENDPOINT=ws://127.0.0.1:3002/ PW_TEST_CONNECT_EXPOSE_NETWORK='<loopback>' pnpm test:e2e tests/e2e/long-history-webkit.spec.ts
```
