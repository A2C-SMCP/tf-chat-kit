# 在宿主 App 中接入 Chat Kit

本文面向负责 Web、Office Add-in、Tauri 或其他宿主 App 的开发者，说明如何把 Chat Kit 接入现有应用。默认示例使用 **React 18 + Ant Design 5 + TFRobotServer Gateway**；如果宿主有自己的 UI，可以只使用 Runtime 和 React hooks。

接入完成后，宿主应当能够：

- 查询和切换会话；
- 加载历史消息并接收实时更新；
- 发送文本、展示 Run 状态并中断可中断的 Run；
- 在路由切换、账号切换或组件卸载时释放 HTTP、Socket 和订阅资源；
- 继续由宿主管理登录、Token 刷新、路由、主题、国际化和平台能力。

## 1. 先选择接入层级

| 需求                    | 需要安装的 Chat Kit 包                                                                | 说明                          |
| ----------------------- | ------------------------------------------------------------------------------------- | ----------------------------- |
| 直接使用成品聊天界面    | `chat-protocol`、`chat-runtime`、`chat-gateway-tfrobot`、`chat-react`、`chat-ui-antd` | 推荐的大多数 React 宿主接法   |
| 使用宿主自己的 React UI | `chat-protocol`、`chat-runtime`、`chat-gateway-tfrobot`、`chat-react`                 | 通过 hooks 读取状态和执行命令 |
| 非 React 或纯 Headless  | `chat-protocol`、`chat-runtime`、`chat-gateway-tfrobot`                               | 直接订阅 `ChatClient`         |
| 接入非 TFRobot 后端     | `chat-protocol`、`chat-runtime`，按需增加 React/UI 包                                 | 由宿主实现 `ChatGateway`      |

各层的依赖方向如下：

```text
宿主页面
  └─ chat-ui-antd（可选成品 UI）
       └─ chat-react（Provider 和 hooks）
            └─ chat-runtime（状态与命令）
                 └─ chat-protocol（模型与端口）

chat-gateway-tfrobot ──实现──> chat-protocol.ChatGateway
```

Chat Kit 不读取宿主的 Router、全局 Store 或登录状态。所有宿主能力都通过构造参数、Provider 或回调显式注入。

## 2. 环境和依赖

公共包是 ESM 包。宿主构建工具需要支持 ESM，并满足以下 peer dependency：

- React：`>=18.2.0 <19.0.0`
- ReactDOM：`>=18.2.0 <19.0.0`
- Ant Design：`>=5.23.4 <6.0.0`，仅成品 UI 路径需要

以 pnpm 为例：

```bash
pnpm add \
  @turingfocus/chat-protocol \
  @turingfocus/chat-runtime \
  @turingfocus/chat-gateway-tfrobot \
  @turingfocus/chat-react \
  @turingfocus/chat-ui-antd

pnpm add react@^18.2.0 react-dom@^18.2.0 antd@^5.23.4
```

如果宿主已经安装兼容版本的 React、ReactDOM 和 Ant Design，不要重复安装。所有 `@turingfocus/chat-*` 包应锁定到同一个发布版本，避免协议、Runtime 和 UI 的版本错配。

## 3. 准备宿主配置

接入前先从宿主或部署平台准备这些值：

| 配置                     | 是否必填     | 含义                                                                         |
| ------------------------ | ------------ | ---------------------------------------------------------------------------- |
| `baseUrl`                | 是           | TFRobotServer 或宿主 BFF 的聊天 API 前缀；Gateway 会在其后追加 `v1/chat/...` |
| `socketNamespaceUrl`     | 建议显式填写 | Socket.IO Namespace URL；不填时默认使用 `baseUrl` 的 origin 加 `/chat`       |
| `socketPath`             | 否           | Socket.IO path，默认 `/socket.io`                                            |
| `platformId`             | 否           | 查询和创建会话时使用的平台过滤值                                             |
| `SessionProvider`        | 是           | 按需返回当前短期凭据，并处理凭据失效通知                                     |
| `messageCreatorProvider` | 是           | 发送消息时返回当前宿主用户的 `uid`、`name` 和可选头像                        |

例如，若 `baseUrl` 是 `https://host.example.com/robot-proxy/`，Gateway 会请求：

```text
GET https://host.example.com/robot-proxy/v1/chat/conversations
```

`baseUrl` 和 `socketNamespaceUrl` 不得包含 URL 用户名或密码。跨域直连时，服务端必须同时允许宿主页面的 HTTP 请求和 Socket.IO WebSocket 连接。受控第三方应用优先使用宿主 BFF 和短期最小权限 Token，不要向浏览器分发管理密钥。

> 路由提示：某些 TFRobotServer 部署还需要 Namespace、Robot ID 或路由 Header。它们不由公共 Gateway 猜测。请在宿主的 endpoint resolver 或 BFF 中解析这些部署信息，再把最终的 HTTP 前缀、Socket Namespace URL 和 Socket path 传给 Gateway。

## 4. 创建 Gateway 和 ChatClient

下面的工厂把宿主认证、用户身份、端点和诊断回调注入 Chat Kit。`SessionProvider` 每次按需取短期凭据，Chat Kit 不负责登录，也不会替宿主持久化 Token。

```ts
// host-chat-client.ts
import type {
  SessionInvalidation,
  SessionProvider,
} from "@turingfocus/chat-protocol";
import {
  createTFRobotChatGateway,
  type TFRobotSession,
} from "@turingfocus/chat-gateway-tfrobot";
import type { ChatClientFactory } from "@turingfocus/chat-react";
import { createChatClient } from "@turingfocus/chat-runtime";

export interface HostChatConfig {
  apiBaseUrl: string;
  socketNamespaceUrl: string;
  socketPath?: string;
  platformId?: string;
  getAccessToken(): Promise<string>;
  getCurrentUser(): Promise<{
    uid: string | number;
    name: string;
    avatar?: string | null;
  }>;
  onSessionInvalid(invalidation: SessionInvalidation): void | Promise<void>;
  reportError(error: unknown): void;
}

const REQUEST_TIMEOUT_MS = 10_000;
const deadlineAt = () => Date.now() + REQUEST_TIMEOUT_MS;

export function createHostChatClientFactory(
  config: HostChatConfig,
): ChatClientFactory {
  const sessionProvider: SessionProvider<TFRobotSession> = {
    async getSession() {
      return {
        kind: "bearer",
        token: await config.getAccessToken(),
      };
    },
    onSessionInvalid: config.onSessionInvalid,
  };

  return {
    create() {
      const gateway = createTFRobotChatGateway({
        baseUrl: config.apiBaseUrl,
        sessionProvider,
        messageCreatorProvider: () => config.getCurrentUser(),
        socketNamespaceUrl: config.socketNamespaceUrl,
        ...(config.socketPath === undefined
          ? {}
          : { socketPath: config.socketPath }),
        ...(config.platformId === undefined
          ? {}
          : { platformId: config.platformId }),
        onDiagnostic: config.reportError,
      });

      return createChatClient({
        gateway,
        onUnhandledError: config.reportError,
      });
    },
    getDisposeOptions: () => ({ deadlineAt: deadlineAt() }),
  };
}

export const getChatDeadlineAt = deadlineAt;
```

要点：

- `getAccessToken()` 应返回当前有效的短期 Token；不要在模块全局变量、URL、日志或浏览器持久化存储中放管理密钥。
- Bearer Token 会进入 HTTP `Authorization: Bearer ...` 和 Socket auth 的 `token` 字段。
- 内部受控宿主如果确实需要 Admin Token，可以返回 `{ kind: "admin", adminKey }`；不要把该模式用于第三方浏览器应用。
- `messageCreatorProvider` 与认证分开，Gateway 不解析 Token 来猜用户身份。
- `deadlineAt` 是 Unix epoch 毫秒的**绝对截止时间**，不是超时秒数；每次操作都要生成新值。

## 5. 在 React 生命周期中挂载

`OwnedChatProvider` 会在挂载后创建一个 `ChatClient`，在 factory 变化或组件卸载时释放它。Factory 的对象引用决定实例是否需要替换，因此要用 `useMemo` 保持稳定。

```tsx
// ChatRoute.tsx
import { ConfigProvider, Spin } from "antd";
import { useMemo } from "react";
import { OwnedChatProvider } from "@turingfocus/chat-react";

import {
  createHostChatClientFactory,
  type HostChatConfig,
} from "./host-chat-client";
import { HostChatWorkspace } from "./HostChatWorkspace";

export function ChatRoute({ config }: { config: HostChatConfig }) {
  const factory = useMemo(() => createHostChatClientFactory(config), [config]);

  return (
    <ConfigProvider theme={{ token: { colorPrimary: "#2563eb" } }}>
      <OwnedChatProvider
        factory={factory}
        fallback={<Spin />}
        onDisposeError={config.reportError}
      >
        <HostChatWorkspace />
      </OwnedChatProvider>
    </ConfigProvider>
  );
}
```

确保传入的 `config` 本身也是稳定对象。账号、租户、Robot 或环境发生变化时，应创建新的 config/factory，让旧实例先释放，再启用新实例。

如果宿主在 React 树外创建并持有 `ChatClient`，改用：

```tsx
<ChatProvider client={hostOwnedClient}>
  <HostChatWorkspace />
</ChatProvider>
```

此时 `ChatProvider` **不会**释放外部实例；宿主必须在对应生命周期中执行：

```ts
await hostOwnedClient.dispose({ deadlineAt: Date.now() + 10_000 });
```

## 6. 组合会话列表和聊天视图

`ChatUiShell` 负责页面壳和会话列表，`ChatConversationView` 负责当前会话的时间轴、发送框、Run 中断、事件详情和 Ask User 展示。会话列表、选中项和切换动作仍由宿主控制。

```tsx
// HostChatWorkspace.tsx
import { useCallback, useEffect, useRef, useState } from "react";
import type { Conversation } from "@turingfocus/chat-protocol";
import { useChatClient } from "@turingfocus/chat-react";
import {
  ChatConversationView,
  ChatUiShell,
  type ChatContentState,
} from "@turingfocus/chat-ui-antd";

import { getChatDeadlineAt } from "./host-chat-client";

export function HostChatWorkspace() {
  const client = useChatClient();
  const requestRevision = useRef(0);
  const listRevision = useRef(0);
  const [conversations, setConversations] = useState<readonly Conversation[]>(
    [],
  );
  const [selectedId, setSelectedId] = useState<string>();
  const [pendingId, setPendingId] = useState<string>();
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState<string>();
  const [contentState, setContentState] = useState<ChatContentState>({
    kind: "loading",
  });

  const selectConversation = useCallback(
    async (conversationId: string) => {
      const revision = ++requestRevision.current;
      setPendingId(conversationId);
      setContentState({ kind: "loading" });

      const result = await client.loadConversation({
        conversationId,
        deadlineAt: getChatDeadlineAt(),
      });
      if (revision !== requestRevision.current) return;

      setPendingId(undefined);
      if (!result.ok) {
        setContentState({
          kind: result.error.code === "network" ? "disconnected" : "error",
          description: result.error.message,
        });
        return;
      }

      setSelectedId(conversationId);
      setContentState({ kind: "ready" });
    },
    [client],
  );

  const loadConversationList = useCallback(async () => {
    const revision = ++listRevision.current;
    setListLoading(true);
    setListError(undefined);

    const result = await client.listConversations({
      deadlineAt: getChatDeadlineAt(),
      limit: 50,
    });
    if (revision !== listRevision.current) return;
    setListLoading(false);

    if (!result.ok) {
      setListError(result.error.message);
      setContentState({ kind: "error", description: result.error.message });
      return;
    }

    setConversations(result.value.conversations);
    const first = result.value.conversations[0];
    if (first === undefined) {
      setContentState({ kind: "empty" });
    } else {
      await selectConversation(first.id);
    }
  }, [client, selectConversation]);

  useEffect(() => {
    void loadConversationList();
    return () => {
      requestRevision.current += 1;
      listRevision.current += 1;
    };
  }, [loadConversationList]);

  return (
    <div style={{ height: "100%", minHeight: 480 }}>
      <ChatUiShell
        contentState={contentState}
        conversationListError={
          listError === undefined
            ? undefined
            : { message: listError, onRetry: () => void loadConversationList() }
        }
        conversationListLoading={listLoading}
        conversations={conversations.map((conversation) => ({
          id: conversation.id,
          title: conversation.title,
          description: conversation.description,
          updatedAt: conversation.updatedAt,
        }))}
        onConversationSelect={(id) => void selectConversation(id)}
        pendingConversationId={pendingId}
        selectedConversationId={selectedId}
      >
        <ChatConversationView
          getDeadlineAt={getChatDeadlineAt}
          onCommandError={({ error }) => {
            // 接入宿主遥测；不要记录凭据或包含凭据的原始对象。
            console.error(error.code, error.message);
          }}
        />
      </ChatUiShell>
    </div>
  );
}
```

生产代码通常还需要补充会话分页、创建会话按钮和业务埋点。`ChatClient` 对命令统一返回 `GatewayResult<T>`：先检查 `result.ok`，失败时读取结构化的 `result.error.code`、`message` 和 `retryable`，不要只依赖 Promise rejection。

### 6.1 记忆事件详情双栏比例

双栏模式的分隔条支持鼠标、触控和键盘调整。Chat Kit 只提供比例状态与回调，不会自行访问宿主存储：

- `defaultEventDetailSplitRatio`：非受控模式的初始左栏比例；
- `eventDetailSplitRatio`：受控模式的左栏比例；
- `onEventDetailSplitRatioChange`：拖动结束或键盘调整后返回新比例。

比例范围是 `0.2`–`0.8`，默认值是 `0.56`。如果整个宿主 App 要共用一个比例，应在 App 级状态或 Store 中只保存一份，并把同一受控值传给所有 `ChatConversationView`。下面以非敏感的布局偏好为例：

```tsx
const SPLIT_RATIO_KEY = "acme.host.chat.event-detail-split-ratio.v1";
const DEFAULT_SPLIT_RATIO = 0.56;

function readSplitRatio(): number {
  try {
    const value = Number(globalThis.localStorage.getItem(SPLIT_RATIO_KEY));
    return Number.isFinite(value) && value >= 0.2 && value <= 0.8
      ? value
      : DEFAULT_SPLIT_RATIO;
  } catch {
    return DEFAULT_SPLIT_RATIO;
  }
}

// 放在当前宿主 App 的共同祖先中，而不是每个会话组件中。
const [eventDetailSplitRatio, setEventDetailSplitRatio] =
  useState(readSplitRatio);

const changeEventDetailSplitRatio = useCallback((ratio: number) => {
  setEventDetailSplitRatio(ratio);
  try {
    globalThis.localStorage.setItem(SPLIT_RATIO_KEY, String(ratio));
  } catch {
    // 存储不可用时保留本次内存状态，不影响继续调整。
  }
}, []);

<ChatConversationView
  eventDetailSplitRatio={eventDetailSplitRatio}
  getDeadlineAt={getChatDeadlineAt}
  onEventDetailSplitRatioChange={changeEventDetailSplitRatio}
/>;
```

不要把 Token、Admin Key 等凭据放进这个布局偏好。若宿主运行在 SSR 环境，应继续把存储访问留在浏览器侧；若不需要跨刷新记忆，直接使用 `defaultEventDetailSplitRatio` 即可。

成品 UI 默认：

- 虚拟化渲染时间轴；
- 用户离开底部后不会强制抢滚动；
- 使用经过清洗的 GFM Markdown，忽略原始 HTML，图片只显示安全占位文本；
- 对未知事件或单个自定义渲染器异常执行安全降级；
- 继承外层 Ant Design `ConfigProvider` 的 theme token。

组件自身使用 `height: 100%`，所以宿主必须给父容器一个可计算的高度或最小高度。

## 7. 宿主自定义 UI

不使用 Ant Design UI 时，通过 React hooks 读取状态：

```tsx
import { useChatClient, useChatSelector } from "@turingfocus/chat-react";

export function CompactComposer() {
  const client = useChatClient();
  const active = useChatSelector((snapshot) =>
    snapshot === null
      ? null
      : {
          conversationId: snapshot.conversation.id,
          canSend: snapshot.capabilities.sendText,
        },
  );

  const send = async (text: string) => {
    if (active === null || !active.canSend) return;
    const result = await client.sendText({
      conversationId: active.conversationId,
      text,
      deadlineAt: Date.now() + 10_000,
    });
    if (!result.ok) {
      // 映射为宿主自己的错误提示。
    }
  };

  return <button onClick={() => void send("你好")}>发送</button>;
}
```

优先使用 `useChatSelector` 订阅实际需要的切片，避免时间轴等无关更新导致整个页面重渲染。只有确实需要完整不可变快照时才使用 `useChatSnapshot()`。

如果需要覆盖某种消息或事件的呈现，可用 `createChatRendererRegistry()` 创建 registry，再传给 `ChatConversationView.renderers`。Registry 支持按 `message:<content-kind>`、`agent-event:<event-type>`、`agent-event:<event-category>` 等粒度覆盖；自定义渲染器仍会被错误边界隔离。

## 8. 非 React 宿主

`ChatClient` 不依赖 React。非 React 页面、桌面壳或其他框架可以直接订阅它：

```ts
const gateway = createTFRobotChatGateway(gatewayOptions);
const client = createChatClient({ gateway });

const subscription = client.subscribe(() => {
  const snapshot = client.getSnapshot();
  renderWithHostFramework(snapshot);
});

const conversations = await client.listConversations({
  deadlineAt: Date.now() + 10_000,
});

// 路由或窗口卸载时：
subscription.dispose();
await client.dispose({ deadlineAt: Date.now() + 10_000 });
```

同一个宿主可以创建多个客户端实例。每个实例都必须拥有独立 Gateway；不要在不同用户、租户或页面之间共享一个可变的全局 Gateway。

## 9. 能力边界

UI 和宿主逻辑应读取当前快照的 `capabilities`，不要假设所有 Gateway 都支持全部命令。

当前 TFRobot Gateway 支持：

- 会话列表和会话创建；
- 历史加载与实时订阅；
- 文本发送；
- 对拥有真实活动 `taskId` 的 Run 执行中断。

当前 TFRobot Gateway **不开放实时 Ask User 回答**。UI 可以安全展示交互请求，但回答控件会按能力降级。附件发送、宿主登录系统和平台专属动作也不属于 V1 公共能力。

## 10. 认证与安全边界

宿主负责：

- 登录、登出、Token 刷新和重新认证体验；
- Token 的安全存储策略；
- BFF、CORS、CSP、租户和 Robot 路由；
- 在 `onSessionInvalid` 收到失效通知后刷新会话或引导登录；
- 确保日志、埋点和错误上报不包含 Token、Cookie、Admin Key 或完整原始认证对象。

Chat Kit 负责：

- 仅在请求和连接期间向 `SessionProvider` 获取会话材料；
- 将 HTTP/Socket DTO 校验并映射为标准模型；
- 将 401、403、超时、网络和协议错误映射为结构化 `ChatError`；
- 在诊断信息中清洗已知凭据值；
- 在客户端释放后停止订阅和晚到事件交付。

不要把 Playground 的开发代理当成生产 BFF。它只用于本仓库本地调试，不会进入生产构建。

## 11. 测试和上线检查

开发阶段可以安装 `@turingfocus/chat-testing`，用 `createMemoryChatGateway()` 在没有真实 RobotServer 的情况下验证宿主页面、生命周期和错误状态。真实服务联调还应覆盖 CORS、Socket path、重连、凭据刷新和路由配置。

合并或上线前至少确认：

- [ ] 所有 Chat Kit 包使用同一版本，peer dependency 无冲突；
- [ ] 宿主父容器有明确高度，窄屏和宽屏布局都可用；
- [ ] 首次加载、空列表、切换会话、网络错误和重试均有可见状态；
- [ ] HTTP 和 Socket 使用同一个当前会话身份，账号切换后旧实例已释放；
- [ ] 发送消息时的 creator 来自当前宿主用户；
- [ ] 每个请求生成新的绝对 `deadlineAt`；
- [ ] 路由卸载、窗口关闭、Feature Flag 回滚和 StrictMode effect replay 不残留 Socket；
- [ ] 日志、URL、浏览器存储和遥测中没有凭据；
- [ ] UI 根据 `capabilities` 禁用不支持的操作；
- [ ] 已用真实目标环境验证 API 前缀、CORS、Socket Namespace/path 和重连；
- [ ] 灰度开关能在旧实现与 Chat Kit 之间安全切换，切换期间不会同时拥有两个活动客户端。

## 12. 仓库内可参考实现

- [Playground 的真实 TFRobotServer 会话装配](../playground/src/robotserver-session.ts)
- [Playground 的 Runtime + React + Ant Design 页面](../playground/src/app.tsx)
- [宿主认证与会话边界 ADR](./adr/006-auth-and-session.md)
- [React + Ant Design 宿主消费者验证](./baselines/tfck-11/host-consumer-validation.md)
- [Office 与 Tauri 接入形态矩阵](./baselines/tfck-12/non-tfrobotfront-consumer-matrix.md)
