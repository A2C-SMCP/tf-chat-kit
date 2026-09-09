# Third-party display and document integration

Use the exact release containing the #58 capability extensions. Install `@turingfocus/chat-kit` and
the React/ReactDOM/Ant Design peer versions documented in `host-app-integration.md` for default UI.
Choose `/headless` for non-React code, `/react` for custom React UI, or `/antd` (also the root entry)
for the default interface. Runtime and headless code do not load UI or highlighter modules.

Create one client per identity/Robot instance using `createTFRobotChatClient`, or a factory using
`createTFRobotChatClientFactory`. Supply endpoints, `SessionProvider`, and message creator as described
in the host integration guide. `ChatProvider` receives an app-owned client; the app must dispose it.
`OwnedChatProvider` owns instances created by its factory. Keep factories and ports referentially
stable. No login page, token storage, external application repository or platform SDK is needed.

## Resource and document ports

```tsx
import {
  ChatProvider,
  ChatResourceProvider,
  ChatDocumentSourceProvider,
  ChatWorkspace,
  type ChatClient,
  type ChatDocumentSource,
  type ChatResourcePort,
} from "@turingfocus/chat-kit/antd";

const documents: ChatDocumentSource = {
  list: ({ query, signal }) =>
    signal.aborted
      ? []
      : [
          {
            id: "handbook",
            title: "Handbook",
            content: "Authorized document text.",
          },
        ].filter((document) =>
          document.title.toLowerCase().includes(query.toLowerCase()),
        ),
};

export function IndependentChat({
  client,
  resources,
  accountRevision,
}: {
  client: ChatClient;
  resources: ChatResourcePort;
  accountRevision: string;
}) {
  return (
    <ChatProvider client={client}>
      <ChatResourceProvider port={resources} scope={accountRevision}>
        <ChatDocumentSourceProvider source={documents} scope={accountRevision}>
          <ChatWorkspace />
        </ChatDocumentSourceProvider>
      </ChatResourceProvider>
    </ChatProvider>
  );
}
```

`ChatResourcePort.resolve` receives a resource, purpose (`display`, `open`, `download`), cooperative
`signal` and current conversation ID for display, open and download. Return `{ url, dispose? }`; the URL must be
HTTP/HTTPS/blob with no URL userinfo. Return a short-lived accessible URL for private schemes.
`dispose` releases leases or revokes a blob created by the app. It is called even when an ignored
request finishes after cancellation. The app must stop work when `signal.aborted` or its
`signal.subscribe` callback indicates cancellation. Adapt that callback to your HTTP AbortController
as needed and unsubscribe in `finally`. Do not write URL credentials or port errors to logs/storage.

For platform-managed opening/saving, implement `open` or `download`; these receive the original
resource, conversation ID and cancellation signal. The default browser path opens a safe URL or fetches a download
with omitted credentials and no referrer. Failed fetch/CORS permission shows an action failure.
Provide host actions for protected downloads that cannot be exposed as accessible URLs. A host action
must reject when it cannot perform the operation; resolving means the host accepted responsibility.
On account changes replace the client where appropriate and change `scope` to invalidate all leases.
Use Retry resource after a short-lived URL expires. No automatic refresh loop runs.

Without a port, HTTP/HTTPS/blob resources work directly. Private URLs show unavailable/retry and
actions fail safely. A missing document source hides References. Sources must return authorized
plain-text content, stable IDs and nonempty titles. Search is explicit, not periodic. At most 100
returned candidates are displayed; filter or paginate in the app's source UI for larger libraries.
Selecting a candidate inserts a long-text draft placeholder with an independent anchor ID. Existing
view/edit/remove controls operate on that anchor. Sending expands title and complete content as text;
there is no new server reference field, document upload pipeline or implicit document processing.

## Default display and overrides

The default Tool renderer reads `presentation` and `attachments`, never raw DTO fields. Browser,
Preview, Editor, Shell and Download details activate only when their standard presentation exists.
Unknown results remain inspectable. To override, pass a registry created by
`createChatRendererRegistry({ "agent-event:tool": MyToolRenderer })` to workspace/conversation props.
The renderer receives a standard item and display mode; `null` explicitly requests fallback.
Use `useChatResource` in a custom React renderer for the same cancellation and lease behavior, or
call your `ChatResourcePort` directly in a non-React application. Theme uses Ant Design ConfigProvider.

The conversation view opens event details when a timeline event is selected. It does not render an
event navigation toolbar. A custom UI can use `useChatEventNavigation` for previous/next selection
and following the latest event, with its own controlled selected ID and a scope combining client
and conversation identity. Historical prepends preserve the selected ID. Changing scope returns
to manual mode. None of this invokes server replay.

Code blocks copy their own original text. Large received results initially show 4,000 characters and
can be expanded/copied; highlighter/diff budgets are listed in the capability matrix. Unknown language
or lazy import failure leaves readable text. Media failures show retry, not a broken chat timeline.
Renderer failure is contained by the existing registry boundary; customize `onRendererError` without
recording raw/sensitive resource information. Existing command errors still use `onCommandError`.

## Verify an integration

Run `pnpm check` from the repository's Node 24 environment. It builds tarballs and installs them in
independent headless, React and Ant Design consumer projects; those projects do not import workspace
source. The resource action test uses a real local HTTP server, and the presentation integration test
uses a real HTTP/Socket.IO adapter into Runtime. See `baselines/parity-58/capabilities.md` for the
acceptance-to-test mapping and limits. No production credentials or external application are required.

## Resource errors and localization (#75)

The resource port signatures are unchanged. Hosts may throw `ChatResourceError` (available from
`@turingfocus/chat-kit/headless` and its UI entries), or reject with `{ code }`. Supported codes are
`unauthorized`, `network`, `not-found`, `expired`, `unsupported`, `cancelled`, and `unknown`.
`normalizeChatResourceError(unknown)` produces only `{ code, retryable }`; it never copies a host
message, URL, response body, cause or stack. Existing untyped exceptions remain safe unknown errors.
Map your backend/platform errors to these codes in the host; do not infer classification from error
message substrings or pass credentials into the error.

For example, a host that detects an expired lease can `throw new ChatResourceError("expired")`.
A user-cancelled platform save can throw `new ChatResourceError("cancelled")`; native `AbortError`
is also recognized. `ChatResolvedResource.dispose` remains the lease cleanup callback, not a new
method on `ChatResourcePort`.

`useChatResource` retains its existing `loading | ready | unavailable` status union and adds an
optional `error: ChatResourceFailure`. Custom UIs should treat `error.code === "cancelled"` as a
neutral outcome, not an alert. Explicit `retry()` starts another resolve. The built-in UI offers
retry for authorization, network, expiry and unknown failures; sign in or correct permissions in
the host before retrying an authorization failure. Not-found and unsupported errors are not given
a display retry button. Open/download can be attempted again using the corresponding action.
Cancelled display loading shows neutral copy, while cancelled open/download silently clears busy
state. Context changes/unmount cancel requests, discard late failures, and release late leases.
There is no automatic retry, login, lease refresh or polling.

The default browser download maps HTTP 401/403 to unauthorized, 404 to not-found, 410 to expired,
and 415 to unsupported. Fetch/network failures use network; other responses use unknown. Browser
image errors provide no reliable status and therefore use unknown. Native media error codes
identify cancellation, network or unsupported/decoding failures. Opening a browser link only
initiates navigation; the Kit cannot inspect a new tab's HTTP/authentication result. Hosts needing
that guarantee must implement `open` and reject with the appropriate code.

Set `labels.resource` once on `ChatWorkspace` or `ChatConversationView`; it reaches message
attachments, Markdown resources, and both modal/split event details. Standalone `ChatTimeline`,
`ChatEventDetail`, and `ChatResourceView` also accept `labels`. Each omitted key retains English
copy. Labels are instance-local and can change without reconnecting or reacquiring a resource.
For a complete Chinese resource dictionary:

```tsx
import type { ChatUiLabelOverrides } from "@turingfocus/chat-kit/antd";

const labels: ChatUiLabelOverrides = {
  resource: {
    screenshot: "浏览器截图",
    generatedFile: "生成的文件",
    fileTitle: "文件",
    image: "图片",
    audio: "音频",
    video: "视频",
    loading: "正在加载资源…",
    retry: "重试资源",
    open: "打开",
    download: "下载",
    opening: "正在打开…",
    downloading: "正在下载…",
    unauthorized: "请登录或检查资源访问权限。",
    network: "无法连接资源，请检查网络后重试。",
    "not-found": "资源不存在。",
    expired: "资源链接已过期，请重试刷新。",
    unsupported: "不支持此资源格式。",
    cancelled: "已取消资源加载。",
    unknown: "资源操作失败，请重试。",
  },
};
// <ChatWorkspace labels={labels} /> inside the existing providers.
```

This is an additive Minor API change in the fixed package group. No TFRobot REST/Socket contract,
server baseline, credentials, host platform adapter, migration flag or production seed changes are
required. The repository's Playground expiry fixture and Tauri-style packed consumer cover the
new resource contract; actual client deployment and resource transport remain host-owned.
