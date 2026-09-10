# @turingfocus/chat-kit

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
