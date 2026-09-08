# Third-party capability matrix — #58

Baseline: 2026-09-07, implementation based on `a917ebae63cd90132d7d8fdb7549f3d53cd0be3c`.
This is the current extension matrix. Historical migration matrices remain historical records.
The release is a backwards-compatible Minor in the seven-package fixed Changesets group; this document
does not declare a published version. Install the exact version containing the `parity-display` changeset.

## Responsibilities and architecture

The Kit owns normalized display data, default renderers, resource lifecycle bindings, local event
navigation and conversation-scoped draft anchors. Integrating applications own identity, document
authorization, private storage, platform navigation and their resource implementation. No external
application source, BFF, COS integration, document parsing service or memory system is required.
No Accepted ADR is replaced. ADR-002/003/004/005/006/008/009/010 continue to apply.
There is no transition flag, new polling, service replay protocol, login flow or file-write operation.
Ask User extensions are excluded; its existing behavior remains covered by regression tests.

## Capabilities

| Issue / acceptance | Standard API and default behavior                                                                         | Evidence                                                             | Limitations / application responsibility                                                                                                                                                       |
| ------------------ | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #59 / AC1          | `ToolReturn.presentation`, `attachments`, `AgentEventTransition.content`; runtime schemas                 | `chat-presentation.test.ts`, `chat-presentation.integration.test.ts` | Origin/result/success/done retain their meaning; unknown results use the safe inspector. The Gateway chooses valid transformed data before origin.                                             |
| #60 / AC2          | `ChatResourcePort`, `ChatResourceProvider`, `useChatResource`, `ChatResourceView`                         | `chat-resources.test.ts`, `chat-resource-actions.test.ts`            | App resolves private/s3 resources and changes provider scope on authorization changes. Public downloads require fetch/CORS permission.                                                         |
| #61 / AC1          | Browser address, screenshot and safe Markdown in default tool detail                                      | `chat-tool-presentation.test.ts`                                     | No remote iframe or script execution. Missing fields are omitted; resource failures are retryable.                                                                                             |
| #62 / AC1          | Preview code and read-only Editor diff; shared code component                                             | `chat-code-content.test.ts`                                          | Core highlighter and seven language grammars load only with code details. Unknown languages stay plain text. Diff work is capped; original/modified remain available.                          |
| #63 / AC1          | Read-only Shell command/context and ANSI SGR output                                                       | `chat-shell-content.test.ts`                                         | Colors/reset/bold are supported; cursor/OSC commands are discarded. This is an execution log, not an interactive terminal.                                                                     |
| #64 / AC1          | Download result and image/audio/video/unknown tool attachments                                            | `chat-tool-presentation.test.ts`, resource tests                     | Audio/video tool attachments download; message media has playback. Missing filenames have explicit generic labels.                                                                             |
| #65 / AC2          | Message audio/video controls, file actions, URL and contact card                                          | `chat-tool-presentation.test.ts`, `chat-attachments.test.ts`         | Media playback depends on browser codec support. Avatar/name are optional. Existing send attachment semantics are unchanged.                                                                   |
| #66 / AC2          | Resource-backed Markdown images, GFM, code highlighting and exact single-block copy                       | `chat-markdown-parity.test.ts`, renderer/code tests                  | Raw HTML disabled. Clipboard refusal shows failure. Private image schemes supported by the default policy: s3 and private.                                                                     |
| #67 / AC3          | `useChatEventNavigation`; previous/next/range/follow controls in `ChatConversationView`                   | `chat-event-navigation.test.ts`, event-detail tests                  | Default manual mode preserves controlled-selection compatibility. Manual selection never follows new IDs. Layout `auto` still means responsive layout.                                         |
| #68 / AC3          | Tool name/category/argument summary, safe Markdown and received-result inspection                         | `chat-value-inspector.test.ts`, renderer tests                       | Initial 4,000 characters, explicit increments of 64,000. Copy includes all received data. Upstream omission markers are not treated as complete results. TFCK-43 owns response-loading limits. |
| #69 / AC4          | `ChatDocumentSourceProvider`, `ChatDocumentSource`, `appendComposerReference`; References and slash entry | `chat-document-references.test.ts`, vertical-slice test              | App supplies already-authorized plain text. Maximum 100 displayed candidates; source filters by explicit query. Send expands title and full content through existing draft anchors.            |
| #70 / AC6          | This matrix and the independent integration guide                                                         | `docs/third-party-parity.md`                                         | No external application integration or migration steps.                                                                                                                                        |
| #71 / AC5          | Packed headless/React/Antd consumers plus Memory/HTTP/Socket.IO integration                               | Repository `pnpm check` and packed consumer checks                   | Real deployed server/real host compatibility remains separately unverified.                                                                                                                    |

## Performance and lifecycle budgets

- Preview/Shell initially render 4,000 characters; expand explicitly to see received content.
- Syntax highlighting is skipped above 40,000 characters. Supported grammars: JavaScript, TypeScript,
  JSON, Python, Bash, XML/HTML and CSS (including their library aliases).
- Diff runs only below 80,000 combined characters with 1,000 edit steps and a 50 ms timeout.
  Over-budget results retain both full input versions and an explicit unavailable message.
- Resource resolution is cancelled on client, conversation, provider, authorization scope or input
  change. Late resolved leases are disposed. There is no shared resource cache or credential storage.
- Document source requests are explicit; cancelling or changing scope discards late candidates.
- Existing virtual timeline and 5,000-item Runtime performance contracts remain the regression base.

## Compatibility record

The transport baseline remains the repository's TFRobotServer source/test-derived contract listed in
`release/compatibility.json`. Added display mapping uses existing event content and MCP metadata;
no server endpoint or authentication handshake is added. Controlled HTTP and Socket.IO fixtures run
locally. They prove the adapter contract, not compatibility with an unknown deployed server commit.
Production host rollout, old-path retirement and external UAT seeds are outside this extension.
Repository fixtures and packed consumers are updated; existing Ask User seeds are retained.

## Verification record

Executed on 2026-09-07 with Node 24.20.0 and pnpm 10.34.5:

```sh
CHANGESET_BASE_REF=a917ebae63cd90132d7d8fdb7549f3d53cd0be3c pnpm check
```

The Changesets base is this task's starting HEAD. Workspace policy, Changesets, dependency boundaries,
lint, formatting, type checks, all 51 test files / 1,022 tests, playground build, seven-package packing,
artifact scanning, publint/ESM type checks and independent packed consumers passed. Consumers cover
headless, React without Ant Design, Office-style, Tauri-style and the existing Front-style compatibility
fixture. These are independent integration shapes, not deployed Office/Tauri/Front applications.

Real local HTTP/Socket.IO tests drive history and terminal updates into Runtime and the default UI,
including both transition tabs. Real HTTP resource bytes drive download. DOM regressions cover media
URL changes, error/retry with the same URL, client/conversation/authorization cancellation, late lease
release and streamed Markdown selection. Document references traverse the existing full-text send path.

Lazy playground chunks: code highlighter 55.24 kB (18.19 kB gzip), diff 8.20 kB (3.03 kB gzip),
code view 4.28 kB (1.94 kB gzip), Shell 1.76 kB (0.98 kB gzip). Existing large main-chunk and
ESM-only/CommonJS-resolution notices remain non-failing build diagnostics.

Production-host E2E/UAT and a newly deployed server were not exercised. The server baseline remains
`TFRobotServer develop@2a97c8f4`, a source/test-derived contract; no claim of production Socket.IO
compatibility is added. No new Feature Flag, legacy-path retirement or host migration is introduced.

Non-blocking follow-up: the new navigation, reference, resource and code controls currently use English
labels; extending the existing label-override API remains future work.

## Independent review

Final isolated review (`review_parity58_4`, no inherited implementation conversation): **APPROVE**.
The reviewer covered all 51 Feature files using both staged and unstaged diffs and complete maintained
files; the generated lockfile was checked through its complete diff/importers and an unchanged-line
comparison. Seven blocking findings from prior rounds were verified resolved: media URL cleanup,
action scope/cancellation, streamed code selection, presentation-only return validation, Markdown
resource routing, same-URL media retry cleanup and invalid transformed Shell fallback.

The remaining non-blocking suggestions are label overrides (above) and deterministic tests for dynamic
module import rejection and document-source rejection/retry. Deployed-host E2E/UAT remains outside the
verified evidence. No commit, push, PR or release was performed; issue closure awaits committed delivery.
