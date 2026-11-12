# @turingfocus/chat-kit

## 0.13.0

### Minor Changes

- 9c81d5b: Add the Interaction channel core for `ask_colleague`: protocol wire models and transport ports, a single-owner interaction sub-protocol on the shared `/remote-tool` transport, an instance-scoped Runtime `InteractionClient` with EDF queueing, snapshot reconciliation, ack handling and queue bounds, and explicit interaction-only/combined factories. RemoteTool behavior and `/chat` events are unchanged.
- 9f8ad7a: Add the optional Interaction channel UI for `ask_colleague`: an instance-scoped `InteractionProvider` and hooks over the Runtime `InteractionClient`, a single-active Ant Design queue that consumes the Runtime EDF/active state, an interaction card supporting single-select, multi-select and free text, inline/modal display, read-only interaction history, and coexistence rules with the legacy `AskUserRemoteTool` and Gateway `pendingInteraction` paths. Existing hosts that do not inject an interaction client keep their current behavior.
- fb4420b: Add createTFRobotSocketConnection for explicit instance-local sharing of one WebSocket by chat and RemoteTool namespaces. Each namespace retains its own authentication, recovery and disposal lifecycle; existing independent connection defaults remain compatible.

### Patch Changes

- 6caea4e: Fix mismatched account and password input heights in the Manager login screen.
- f67cf28: Interaction core follow-ups: interaction-specific retry that re-handshakes the shared namespace and re-registers RemoteTool, namespace trailing-slash normalization, legacy `supportsAskUserAdapter` restricted to the Bundle, ack timeout aligned to the 60s transport budget, closed answered metadata backfill, shared tool-name normalization, and additional recovery/cleanup coverage.
- f535556: Allow hosts to request explicit Robot session scopes through Manager, including action:execute for RemoteTool providers. Existing chat-only defaults remain unchanged.
- Updated dependencies [9c81d5b]
- Updated dependencies [f67cf28]
- Updated dependencies [9f8ad7a]
- Updated dependencies [f535556]
- Updated dependencies [fb4420b]
  - @turingfocus/chat-protocol@0.13.0
  - @turingfocus/chat-gateway-tfrobot@0.13.0
  - @turingfocus/chat-runtime@0.13.0
  - @turingfocus/chat-react@0.13.0
  - @turingfocus/chat-ui-antd@0.13.0
  - @turingfocus/chat-auth@0.13.0

## 0.11.0

### Minor Changes

- d655c82: Let Manager chat content follow the host width by default. Add optional contentMaxWidth to constrain both the welcome and conversation views without replacing the active connection or draft.
- d655c82: Default conversation interfaces to product UI. Enable developer diagnostics explicitly with debug, including loading/error states; preserve user-facing errors and recovery actions. Playground Manager now consumes the public ManagerChatApp with an explicit 60 second request budget. Auto / Split / Modal selection remains visible by default and can be hidden independently with showEventDetailModeSelector. Event cards replace the separate arrow column with a hover/focus detail icon, keep keyboard access, and do not open details while selecting text.

  Simplify intermediate messages, collapse rendered content taller than five lines to a three-line preview, shorten event timeline times while keeping full timestamps in details, and use the available width for assistant messages.

### Patch Changes

- Updated dependencies [d655c82]
- Updated dependencies [d655c82]
- Updated dependencies [d655c82]
- Updated dependencies [d655c82]
- Updated dependencies [d655c82]
  - @turingfocus/chat-auth@0.12.1
  - @turingfocus/chat-protocol@0.11.0
  - @turingfocus/chat-gateway-tfrobot@0.11.0
  - @turingfocus/chat-runtime@0.11.0
  - @turingfocus/chat-ui-antd@0.11.0
  - @turingfocus/chat-react@0.11.0

## 0.10.1

### Patch Changes

- 4ff5ca5: Publish the complete stable core group above the interrupted 0.10.0 release, including compact chat controls, five-second recovery notices, and realtime and historical conversation failure cards. Ensure ordinary installs use the Protocol version containing the new failure API.
- Updated dependencies [4ff5ca5]
  - @turingfocus/chat-protocol@0.10.1
  - @turingfocus/chat-runtime@0.10.1
  - @turingfocus/chat-gateway-tfrobot@0.10.1
  - @turingfocus/chat-react@0.10.1
  - @turingfocus/chat-ui-antd@0.10.1

## 0.10.0

### Minor Changes

- 1e43425: Display realtime and persisted conversation failures with safe business explanations and authoritative original text. Allow users to restore text into the composer with overwrite confirmation, without resending or treating conversation errors as current-run outcomes. Legacy transports without shared error identities retain separate realtime observations and history records.
- 55b4248: Compact default chat controls into accessible icon buttons and a dropdown menu. Show the assistant and platform badge on one compact row, with the conversation title and 28px actions on the next; long names expose their complete text in tooltips. Keep assistant and platform summaries read-only and move their switch actions into the menu. The compact organization header is read-only, with organization switching available through account settings. Hosts can append actions through the optional compact workspace moreActions prop. Conversation creation still derives its required title from the first message without asking the user to enter a name.
- 55b4248: Add an optional complete Manager chat interface with Chinese/English copy, compact conversation navigation, explicit identity/robot/platform selection and instance-scoped lifecycle handling.
- 55b4248: Correlate user messages by the Server's elementId across POST receipts, realtime,
  history and cache, independently of author display and database persistence.
  Expose instance-local outgoing send observations with accepted, failed and unknown
  outcomes and render them outside the formal timeline. Preserve legacy Server
  compatibility and never replay sends from cache. Full POST promotion metadata and
  correlated business terminal states still require the Server contracts tracked in #141.
- 55b4248: Expose explicit auth subentries through chat-kit so hosts can install one facade while chat-auth retains its independent version. Add explicit JSON conversation creation and Server platform discovery, with validated platform selection and lifecycle isolation in Manager integrations.

### Patch Changes

- 55b4248: Resolve packed workspace dependencies from the target package version so the auth facade installs the independently released chat-auth API it requires. Verify actual registry dependency resolution without overrides in Manager consumers.
- 55b4248: Clarify identity, organization, robot and platform context in the default Manager UI. Add consistent switch controls and preserve active chat and drafts while browsing or cancelling robot/platform candidates. Keep host-fixed platforms visible and distinguish account display names from organization IDs.

  Preserve the optional Manager organizationName field independently of account displayName, with safe ID fallbacks for missing organization names.

  Restore focus to the actual history/help navigation trigger in WebKit as well as Chromium.

- Updated dependencies [1e43425]
- Updated dependencies [55b4248]
- Updated dependencies [55b4248]
- Updated dependencies [55b4248]
- Updated dependencies [55b4248]
- Updated dependencies [55b4248]
- Updated dependencies [55b4248]
- Updated dependencies [55b4248]
  - @turingfocus/chat-protocol@0.10.0
  - @turingfocus/chat-gateway-tfrobot@0.10.0
  - @turingfocus/chat-runtime@0.10.0
  - @turingfocus/chat-ui-antd@0.10.0
  - @turingfocus/chat-auth@0.12.0
  - @turingfocus/chat-react@0.10.0

## 0.10.0-next.5

### Minor Changes

- 1e43425: Display realtime and persisted conversation failures with safe business explanations and authoritative original text. Allow users to restore text into the composer with overwrite confirmation, without resending or treating conversation errors as current-run outcomes. Legacy transports without shared error identities retain separate realtime observations and history records.

### Patch Changes

- Updated dependencies [1e43425]
- Updated dependencies [55b4248]
  - @turingfocus/chat-protocol@0.10.0-next.5
  - @turingfocus/chat-gateway-tfrobot@0.10.0-next.5
  - @turingfocus/chat-runtime@0.10.0-next.5
  - @turingfocus/chat-ui-antd@0.10.0-next.5
  - @turingfocus/chat-react@0.10.0-next.5

## 0.10.0-next.4

### Minor Changes

- 61976ab: Compact default chat controls into accessible icon buttons and a dropdown menu. Show the assistant and platform badge on one compact row, with the conversation title and 28px actions on the next; long names expose their complete text in tooltips. Keep assistant and platform summaries read-only and move their switch actions into the menu. The compact organization header is read-only, with organization switching available through account settings. Hosts can append actions through the optional compact workspace moreActions prop. Conversation creation still derives its required title from the first message without asking the user to enter a name.

### Patch Changes

- Updated dependencies [61976ab]
  - @turingfocus/chat-ui-antd@0.10.0-next.4
  - @turingfocus/chat-protocol@0.10.0-next.4
  - @turingfocus/chat-runtime@0.10.0-next.4
  - @turingfocus/chat-gateway-tfrobot@0.10.0-next.4
  - @turingfocus/chat-react@0.10.0-next.4

## 0.10.0-next.3

### Minor Changes

- 473865d: Correlate user messages by the Server's elementId across POST receipts, realtime,
  history and cache, independently of author display and database persistence.
  Expose instance-local outgoing send observations with accepted, failed and unknown
  outcomes and render them outside the formal timeline. Preserve legacy Server
  compatibility and never replay sends from cache. Full POST promotion metadata and
  correlated business terminal states still require the Server contracts tracked in #141.

### Patch Changes

- Updated dependencies [473865d]
  - @turingfocus/chat-protocol@0.10.0-next.3
  - @turingfocus/chat-runtime@0.10.0-next.3
  - @turingfocus/chat-gateway-tfrobot@0.10.0-next.3
  - @turingfocus/chat-ui-antd@0.10.0-next.3
  - @turingfocus/chat-react@0.10.0-next.3

## 0.10.0-next.2

### Patch Changes

- f7c1fa2: Clarify identity, organization, robot and platform context in the default Manager UI. Add consistent switch controls and preserve active chat and drafts while browsing or cancelling robot/platform candidates. Keep host-fixed platforms visible and distinguish account display names from organization IDs.

  Preserve the optional Manager organizationName field independently of account displayName, with safe ID fallbacks for missing organization names.

  Restore focus to the actual history/help navigation trigger in WebKit as well as Chromium.

- Updated dependencies [ba54e24]
- Updated dependencies [f7c1fa2]
  - @turingfocus/chat-gateway-tfrobot@0.10.0-next.2
  - @turingfocus/chat-protocol@0.10.0-next.2
  - @turingfocus/chat-runtime@0.10.0-next.2
  - @turingfocus/chat-ui-antd@0.10.0-next.2
  - @turingfocus/chat-auth@0.12.0-next.1
  - @turingfocus/chat-react@0.10.0-next.2

## 0.10.0-next.1

### Minor Changes

- b4741c9: Add an optional complete Manager chat interface with Chinese/English copy, compact conversation navigation, explicit identity/robot/platform selection and instance-scoped lifecycle handling.

### Patch Changes

- 52a7803: Resolve packed workspace dependencies from the target package version so the auth facade installs the independently released chat-auth API it requires. Verify actual registry dependency resolution without overrides in Manager consumers.
- Updated dependencies [b4741c9]
  - @turingfocus/chat-ui-antd@0.10.0-next.1
  - @turingfocus/chat-auth@0.12.0-next.0
  - @turingfocus/chat-protocol@0.10.0-next.1
  - @turingfocus/chat-runtime@0.10.0-next.1
  - @turingfocus/chat-gateway-tfrobot@0.10.0-next.1
  - @turingfocus/chat-react@0.10.0-next.1

## 0.10.0-next.0

### Minor Changes

- 04ffac1: Expose explicit auth subentries through chat-kit so hosts can install one facade while chat-auth retains its independent version. Add explicit JSON conversation creation and Server platform discovery, with validated platform selection and lifecycle isolation in Manager integrations.

### Patch Changes

- Updated dependencies [04ffac1]
  - @turingfocus/chat-gateway-tfrobot@0.10.0-next.0
  - @turingfocus/chat-protocol@0.10.0-next.0
  - @turingfocus/chat-runtime@0.10.0-next.0
  - @turingfocus/chat-react@0.10.0-next.0
  - @turingfocus/chat-ui-antd@0.10.0-next.0

## 0.9.0

### Minor Changes

- 9dc5b76: Add optional public Manager directory, validated connection resolution and robot token exchange, plus headless and React chat ownership adapters. Share the adapters with Playground and verify independent consumers against local HTTP/Socket.IO and browsers.

### Patch Changes

- @turingfocus/chat-protocol@0.9.0
- @turingfocus/chat-runtime@0.9.0
- @turingfocus/chat-gateway-tfrobot@0.9.0
- @turingfocus/chat-react@0.9.0
- @turingfocus/chat-ui-antd@0.9.0

## 0.8.4

### Patch Changes

- Updated dependencies [e84b101]
  - @turingfocus/chat-gateway-tfrobot@0.8.4
  - @turingfocus/chat-protocol@0.8.4
  - @turingfocus/chat-runtime@0.8.4
  - @turingfocus/chat-react@0.8.4
  - @turingfocus/chat-ui-antd@0.8.4

## 0.8.3

### Patch Changes

- Updated dependencies [da5b4f0]
- Updated dependencies [92ac1da]
- Updated dependencies [46dad86]
- Updated dependencies [0a0be31]
  - @turingfocus/chat-gateway-tfrobot@0.8.3
  - @turingfocus/chat-runtime@0.8.3
  - @turingfocus/chat-protocol@0.8.3
  - @turingfocus/chat-react@0.8.3
  - @turingfocus/chat-ui-antd@0.8.3

## 0.8.2

### Patch Changes

- bf2963d: Change the default composer behavior to Enter for a newline and Ctrl+Enter to send on every platform, including macOS. Cmd+Enter does not send. Hosts that need Enter-to-send must explicitly set `sendShortcut="enter"`; Ctrl+Enter also sends in that mode, while Shift+Enter always inserts a newline.

  Expose `sendShortcut` through ChatComposer, ChatConversationView and ChatWorkspace's conversationViewProps, with localized accessible hints. Preserve drafts and attachments when switching modes. Protect IME composition and its final keydown boundary, suppress repeated shortcuts, and share upload/in-flight guards between keyboard and button submissions.

  Release decision: ship this explicitly approved default-interaction change in 0.8.2. The patch version does not imply that the default shortcut is unchanged; existing hosts must opt into `sendShortcut="enter"` to preserve Enter-to-send.

- fdceb0a: Add an optional Headless RemoteTool provider with typed host handlers, registration acknowledgement, reconnect registration, bounded execution and cooperative cancellation. Report same-name registration conflicts explicitly. Add a built-in Ask User tool with conversation cards, draft preservation, validated answers and terminal feedback. Hosts supply trusted request-to-conversation routing; the current Server does not provide that routing automatically.
- 5b41649: Add bounded per-instance diagnostics with safe transport metadata and operation correlation. Reduce connection and cache notice interruptions, keep blocking failures visible, and provide scoped copyable diagnostics and local command failures without changing connection or cache authority.
- Updated dependencies [bf2963d]
- Updated dependencies [f1772a0]
- Updated dependencies [fdceb0a]
- Updated dependencies [dd97f1c]
- Updated dependencies [5b41649]
  - @turingfocus/chat-ui-antd@0.8.2
  - @turingfocus/chat-protocol@0.8.2
  - @turingfocus/chat-runtime@0.8.2
  - @turingfocus/chat-gateway-tfrobot@0.8.2
  - @turingfocus/chat-react@0.8.2

## 0.8.1

### Patch Changes

- a0dd631: Enable bounded, instance-local conversation caching by default, with cache-first display and server synchronization. Add optional scoped, versioned persistence and attachment revalidation ports, cache clearing and status subscriptions. Preserve the uncached path with `cache: false`; restored state does not grant live operation rights or automatically resend messages.
- e3ba706: Add safe resource error codes, neutral cancellation handling, and optional unified resource labels for loading, retry, open and download. Existing resource ports and host label dictionaries remain compatible. Resource copy now reaches attachments, Markdown and event details through the existing UI labels input.
- Updated dependencies [a0dd631]
- Updated dependencies [4f32743]
- Updated dependencies [e3ba706]
- Updated dependencies [a2d7ab0]
  - @turingfocus/chat-runtime@0.8.1
  - @turingfocus/chat-react@0.8.1
  - @turingfocus/chat-ui-antd@0.8.1
  - @turingfocus/chat-protocol@0.8.1
  - @turingfocus/chat-gateway-tfrobot@0.8.1

## 0.8.0

### Minor Changes

- a83c4e3: Add host-agnostic attachment messages, conversation-scoped composer drafts,
  zero-extra-config TFRobot uploads, Ant Design file and long-paste interactions,
  and non-TFRobotFront consumer coverage.
- 358dd28: Add normalized tool presentations, host-injected resource and document ports, media and Markdown
  display, read-only code and terminal details, local event navigation and received-result inspection.
  Preserve existing transport and Ask User contracts and validate independent packed consumers.

### Patch Changes

- Updated dependencies [a83c4e3]
- Updated dependencies [358dd28]
- Updated dependencies [a917eba]
  - @turingfocus/chat-protocol@0.8.0
  - @turingfocus/chat-runtime@0.8.0
  - @turingfocus/chat-gateway-tfrobot@0.8.0
  - @turingfocus/chat-react@0.8.0
  - @turingfocus/chat-ui-antd@0.8.0

## 0.7.0

### Minor Changes

- 93183e0: Add an explicit current TFRobotServer compatibility profile with validated legacy task IDs, same-session REST preflight, bounded best-effort reconnect rebase, and operable degraded lifecycle semantics while preserving the strict verified profile by default. Also add optional conversation rename and delete commands across Protocol, TFRobot Gateway, Runtime, React, Ant Design UI, testing, and the repository Playground, including active-snapshot retirement, an additive empty-state subscription, confirmation, and reserved-prefix cleanup guards.

### Patch Changes

- Updated dependencies [93183e0]
  - @turingfocus/chat-gateway-tfrobot@0.7.0
  - @turingfocus/chat-protocol@0.7.0
  - @turingfocus/chat-react@0.7.0
  - @turingfocus/chat-runtime@0.7.0
  - @turingfocus/chat-ui-antd@0.7.0

## 0.6.0

### Patch Changes

- Updated dependencies [91a29e5]
  - @turingfocus/chat-protocol@0.6.0
  - @turingfocus/chat-runtime@0.6.0
  - @turingfocus/chat-gateway-tfrobot@0.6.0
  - @turingfocus/chat-ui-antd@0.6.0
  - @turingfocus/chat-react@0.6.0

## 0.5.0

### Patch Changes

- Updated dependencies [c22f4c9]
  - @turingfocus/chat-ui-antd@0.5.0
  - @turingfocus/chat-gateway-tfrobot@0.5.0
  - @turingfocus/chat-protocol@0.5.0
  - @turingfocus/chat-runtime@0.5.0
  - @turingfocus/chat-react@0.5.0

## 0.4.2

### Patch Changes

- 6ad3504: Add an instance-scoped conversation workspace controller, an effect-owned React binding, and a managed Ant Design ChatWorkspace that owns conversation listing, creation, pagination, selection, retries, and async race handling while keeping Robot, endpoint, identity, and authentication policy host-owned.
- Updated dependencies [6ad3504]
  - @turingfocus/chat-runtime@0.4.2
  - @turingfocus/chat-react@0.4.2
  - @turingfocus/chat-ui-antd@0.4.2
  - @turingfocus/chat-protocol@0.4.2
  - @turingfocus/chat-gateway-tfrobot@0.4.2

## 0.4.1

### Patch Changes

- 8b4cddf: Generate publish manifests in an isolated staging directory so workspace dependency resolution produces byte-reproducible tarballs across release attempts.
  - @turingfocus/chat-protocol@0.4.1
  - @turingfocus/chat-runtime@0.4.1
  - @turingfocus/chat-gateway-tfrobot@0.4.1
  - @turingfocus/chat-react@0.4.1
  - @turingfocus/chat-ui-antd@0.4.1

## 0.4.0

### Minor Changes

- db50ee1: Add one host-facing package with layered Headless, React and Ant Design entry
  points. It exposes the supported production surfaces and composes an
  instance-owned Gateway, ChatClient and React lifecycle factory.

### Patch Changes

- @turingfocus/chat-protocol@0.4.0
- @turingfocus/chat-runtime@0.4.0
- @turingfocus/chat-gateway-tfrobot@0.4.0
- @turingfocus/chat-react@0.4.0
- @turingfocus/chat-ui-antd@0.4.0
