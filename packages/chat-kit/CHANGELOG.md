# @turingfocus/chat-kit

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
