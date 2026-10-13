# tf-chat-kit

TFRobot 聊天能力的可复用模块。项目采用 Headless Runtime、宿主无关协议、TFRobot Gateway 和可替换 UI 的分层方式，使同一套聊天能力可以集成到 TFRobotFront、Office Add-in、Tauri 客户端和受控第三方应用。

## 当前状态

项目处于 V1 纵向切片建设阶段。七包 workspace、统一构建测试配置和本地 tarball 验证已经建立；`@turingfocus/chat-kit` 通过 `headless`、`react`、`antd` 分层入口为不同宿主提供一个生产门面和实例安全的组合工厂。叶子包继续提供可裁剪的 Protocol、Runtime、Gateway、React、UI 与 Testing 能力，其中 Runtime、React 和 Ant Design UI 分别提供实例隔离的会话工作区编排、无样式订阅绑定和可直接挂载的成品工作区。真实 Gateway 与真实宿主 E2E 作为可选兼容观察记录；TFRobot `/remote-tool` 的多 Provider 与会话路由完成前，实时 Ask User 回答能力保持关闭。

## V1 承诺

- Protocol、Runtime 和 React 接入层支持 TFRobotFront、Office Add-in、Tauri 和受控第三方应用。
- 提供 React + Ant Design 成品 UI。
- Office Add-in 和第三方应用可以基于 React 接入层实现自己的 UI。
- 在公开的 `A2C-SMCP/tf-chat-kit` GitHub 仓库维护，并通过 npm 官方 Registry 公开发布 MIT 包。
- 以当前 TFRobotServer 契约为兼容基线，由 Gateway 隔离服务端差异。
- 每个支持的接入形态在本仓库维护近似的版本化消费者或受控传输，并作为发布硬门禁；真实外部
  E2E 不构成项目依赖。

V1 提供可选的认证接入模块，复用宿主的 Manager 账号体系；账号注册、组织开通和权限管理仍由宿主与 Manager 负责。V1 不承诺 Fluent UI、Web Component、AG-UI 或为每个宿主提供独立视觉包。

## 公共包

| 包                                  | 职责                                        |
| ----------------------------------- | ------------------------------------------- |
| `@turingfocus/chat-protocol`        | 标准聊天模型、运行时校验契约和 Gateway 端口 |
| `@turingfocus/chat-runtime`         | 实例化 ChatClient、状态机和聊天命令         |
| `@turingfocus/chat-gateway-tfrobot` | TFRobotServer REST 与 Socket.IO 适配        |
| `@turingfocus/chat-react`           | React Provider、hooks 和无样式接入层        |
| `@turingfocus/chat-ui-antd`         | Ant Design 成品 UI 与默认渲染器             |
| `@turingfocus/chat-kit`             | Headless、React 与 Ant Design 统一门面      |
| `@turingfocus/chat-testing`         | 内存 Gateway、fixtures 和契约测试工具       |
| `@turingfocus/chat-auth`            | 可选 Headless 认证、TFRobot 适配与默认 UI   |

核心依赖方向为：

```text
chat-ui-antd -> chat-react -> chat-runtime -> chat-protocol
chat-ui-antd -------------------------------> chat-protocol
                         chat-gateway-tfrobot -> chat-protocol
chat-kit -> chat-auth/chat-ui-antd/chat-react/chat-runtime/chat-gateway-tfrobot/chat-protocol
chat-auth (独立发布，门面显式 auth 子入口；react/antd 为可选 peer UI)
                                  chat-testing -> chat-protocol
```

普通宿主只需安装 `@turingfocus/chat-kit`：非 React 使用 `/headless`，自定义 React UI 使用 `/react`，成品 UI 使用根入口或 `/antd`。需要认证时使用门面 `/auth`，TFRobotServer 适配使用 `/auth/tfrobot`，React/Ant Design 默认 UI 分别使用 `/auth/react` 与 `/auth/antd`。高级消费者仍可按需安装叶子包；`chat-testing` 是独立开发依赖，不进入生产门面。

需要 Manager 机器人目录与自动连接时，可选使用 `chat-kit/auth/manager`、`chat-kit/manager`
和 `chat-kit/manager-react`。接法、部署策略与验证范围见 [Manager 集成指南](docs/manager-integration.md)。

任何 Chat Kit 包都不得反向依赖 TFRobotFront 或其他宿主项目。

## 登录、Chat Token 与会话接入

以下接入示例面向目标版本 `0.10.0`（需本次变更发布后使用）；认证叶子包独立发布，由门面声明兼容依赖。已经有登录系统的宿主可以只使用核心包，并注入自己的 `SessionProvider`。

```bash
pnpm add @turingfocus/chat-kit@0.10.0
# 使用下面的 React / Ant Design UI 时还需要：
pnpm add react@^18.2.0 react-dom@^18.2.0 antd@^5.23.4
```

### 1. 接入 Manager 登录

`AuthClient` 每个宿主实例单独创建；环境固定为 `staging` 或 `production`。`baseUrl` 由宿主选择，指向对应 Manager 或同源认证 BFF。

```ts
import { createAuthClient } from "@turingfocus/chat-kit/auth";
import { createTfRobotAuthTransport } from "@turingfocus/chat-kit/auth/tfrobot";

export const createHostAuth = (managerBaseUrl: string) =>
  createAuthClient({
    environment: "production",
    transport: createTfRobotAuthTransport({ baseUrl: managerBaseUrl }),
  });

// 在宿主启动时创建并持有 auth，表单提交时调用：
// const result = await auth.login({ identifier, password });
// result.kind === "account-selection-required"：展示候选账号，
//   然后 await auth.selectAccount(用户选择的 accountId)。
// result.kind === "onboarding-required"：转交宿主的账号开通流程。
// result.kind === "authenticated"：才允许创建当前身份的聊天实例。
```

React 宿主可直接挂载默认登录、账号选择、组织切换和过期提示 UI，也可以用 `/react` 的 `useAuthSelector` 实现自己的界面：

```tsx
import type { AuthClient } from "@turingfocus/chat-kit/auth";
import { AuthProvider } from "@turingfocus/chat-kit/auth/react";
import {
  AccountSelectionPanel,
  AuthStatus,
  LoginPanel,
  OrganizationSwitcher,
  SessionExpiredNotice,
} from "@turingfocus/chat-kit/auth/antd";

export function HostLogin({ auth }: { auth: AuthClient }) {
  return (
    <AuthProvider client={auth}>
      <LoginPanel />
      <AccountSelectionPanel />
      <OrganizationSwitcher />
      <SessionExpiredNotice />
      <AuthStatus />
    </AuthProvider>
  );
}
```

`auth.getSnapshot()` / `auth.subscribe()` 提供身份与状态，不包含 Token。`AuthProvider` 不释放外部传入的客户端：退出登录调用 `await auth.logout()`，宿主卸载时调用 `await auth.dispose()`。环境改变时创建新的 `AuthClient`。

### 2. 用 Manager Token 换取 Chat Token

| 凭据               | 获取方式                                                                            | 使用位置                                                   |
| ------------------ | ----------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Manager 用户 Token | 登录、账号选择或组织切换后，由 `auth.createSessionProvider().getSession()` 按需获取 | Manager API，以及 Token Exchange 的 `subject_token`        |
| Chat Token         | 宿主向 Manager 的 `/api/v1/oauth/token` 执行 RFC 8693 Token Exchange                | RobotServer REST 的 Bearer Token 与 Socket auth 的 `token` |

选择机器人后，宿主先读取该机器人的 `connection-info`，解析最终 REST / Socket 地址与路由；交换请求使用 `audience=robot:{robotAccountId}`、`scope=chat:read chat:send`、`token_profile=session`。`subject_token_type` 为 `urn:ietf:params:oauth:token-type:jwt`，`grant_type` 为 `urn:ietf:params:oauth:grant-type:token-exchange`，请求体使用 `application/x-www-form-urlencoded`。

`auth.createSessionProvider()` 返回的是 **Manager 会话**，不能直接交给需要机器人 audience 的 RobotServer。可选公共入口 `@turingfocus/chat-kit/auth/manager` 提供目录、寻址和机器人专属 SessionProvider；`@turingfocus/chat-kit/manager` 与 `manager-react` 负责聊天实例生命周期。用法见 [Manager 集成指南](docs/manager-integration.md)。自有 BFF 或 Token Source 仍可通过现有端口注入；新增入口随本次 Changeset 发布后可从 npm 导入。

### 3. 保持 Chat Token 可用并创建会话工作区

宿主 Token Source 的 `getToken()` 按需返回有效凭据：在内存中缓存交换结果，按返回的 `expires_in` 计算有效期，距过期约 30 秒时重新交换，并合并同一身份的并发请求。这不是后台定时续期，也不保证 Manager 登录永不过期。

下面的工厂只使用公开 API；`RobotTokenSource` 是可由公共 Manager SessionProvider 或宿主实现提供的端口，每个环境、用户、账号、组织和机器人拥有独立实例：

```ts
import type { AuthClient } from "@turingfocus/chat-kit/auth";
import { createTFRobotChatClientFactory } from "@turingfocus/chat-kit/antd";

interface RobotTokenSource {
  getToken(): Promise<string>;
  invalidate(): void;
}

export function createHostRobotChat(
  auth: AuthClient,
  tokens: RobotTokenSource,
  endpoints: {
    baseUrl: string;
    socketNamespaceUrl: string;
    socketPath: string;
  },
) {
  const snapshot = auth.getSnapshot();
  const account = snapshot.account;
  if (snapshot.status !== "authenticated" || account === undefined) {
    throw new Error("请先完成登录与账号选择");
  }
  return createTFRobotChatClientFactory({
    ...endpoints,
    serverProfile: { kind: "current-server" },
    sessionProvider: {
      getSession: async () => ({
        kind: "bearer",
        token: await tokens.getToken(),
      }),
      onSessionInvalid: ({ reason }) => {
        if (reason !== "forbidden") tokens.invalidate();
      },
    },
    messageCreatorProvider: () => ({ uid: account.userId, name: "当前用户" }),
    getDisposeOptions: () => ({ deadlineAt: Date.now() + 10_000 }),
  });
}
```

把稳定的 factory 传给 `OwnedChatProvider`，再挂载 `ChatWorkspace`，即可使用会话列表、分页、创建、切换、历史与实时消息。完整挂载示例见 [宿主 App 接入指南](docs/host-app-integration.md#5-在-react-生命周期中挂载)。上例的 `current-server` 只适用于当前缺少可靠 join / replay ACK 的 Server，保证级别见下节；已提供完整契约的 Server 使用默认 `verified`。

- **Chat Token 401**：Gateway 通知 `onSessionInvalid`，宿主清除匹配的旧凭据并重新交换；Gateway 对支持恢复的操作最多重试一次，宿主不要再套无限重试。
- **403**：表示权限不足，保留有效身份并呈现错误；重新登录或反复交换 Token 不会补齐权限。
- **Manager Token 过期**：通用 `AuthClient` 只在 transport 实现 `refresh()` 时执行单飞刷新。当前 Manager 适配器只读取服务端明确返回的 `expiresAt`，不解析 JWT 来猜测有效期，也没有已确认的生产刷新接口。已知有效期触发按需刷新，或宿主显式通知 Manager 会话失效后，不支持刷新时才会转为 `auth_required`。若有效期未知，Token Exchange 返回的 Manager 401 必须由宿主转交给 `auth.createSessionProvider()` 返回的 **Manager SessionProvider**：`await managerSessions.onSessionInvalid({ reason: "rejected", error })`，再引导用户重新登录。上例的 RobotServer `onSessionInvalid` 只清除 Chat Token，不能代替这一步。
- **跨页面恢复登录**：默认凭据只在当前实例内存中。需要持久化时，由宿主注入 `CredentialStore` 与完整 `credentialScope`（环境、用户、账号及组织），再调用 `auth.restore()` 校验身份；`restore()` 不是延长 Token 有效期。
- **退出或切换身份 / 机器人**：立即停止旧聊天实例的使用，清空其 Token Source，并释放旧 `ChatClient` / factory。Token Source 必须拒绝失效之后晚到的交换结果；新的身份使用新的 factory，避免旧会话、缓存与 Socket 串用。普通 Token 刷新保持同一身份，不必重建聊天实例。

### TFRobotServer 协议档位

TFRobot Gateway 默认使用 `{ kind: "verified" }`：Socket join 必须返回明确 ACK，重连只有在 Server 明确证明 durable replay 完整时才恢复为 `active`。当前未提供 ACK/replay cursor/outbox 的 TFRobotServer 可由宿主显式选择兼容档位：

```ts
const gateway = createTFRobotChatGateway({
  ...gatewayOptions,
  serverProfile: {
    kind: "current-server",
    rebase: {
      deadlineMs: 10_000,
      maxItems: 500,
      maxPages: 10,
      pageSize: 50,
    },
  },
});
```

该档位会先用与 Socket 相同的短期 session 完成 REST 预检，再接受空 ACK；重连时执行有界 REST 历史回补，并进入可操作但有警告的 `degraded`。REST 无法补回未持久化的 `chat_error` 等瞬时事件，因此 `degraded` 永远是 `complete=false`、`assurance=best-effort`、`source=rest-rebase`，不能作为无损恢复证明。认证、租户/owner 授权、Robot 路由和是否启用该档位仍由宿主负责。

当部署的 Server 能为初次 join 返回访问校验 ACK，并在重连 ACK 中提供经过验证的 durable replay cursor/outbox 完整性后，宿主应删除兼容配置，回到默认 `verified`。不要把 `current-server` 当作永久降级开关或在未知 Server 上自动探测启用。

## 文档

- [宿主 App 接入指南](docs/host-app-integration.md)
- [项目章程](docs/project-charter.md)
- [架构决策记录](docs/adr/README.md)
- [工程与发布基线](docs/engineering-baseline.md)
- [受保护 npm 发布手册](docs/baselines/tfck-13/release-process.md)
- [V1 建设与 TFRobotFront 迁移 Epic](docs/epics/001-chat-kit-v1-and-tfrobotfront-migration.md)

## 开发

```bash
nvm install
nvm use
corepack enable
corepack prepare pnpm@10.34.5 --activate
pnpm install --frozen-lockfile
pnpm dev:playground
pnpm check
pnpm pack:workspace
```

`pnpm dev:playground` 会在 `http://localhost:4311` 启动仓库私有演示应用。进入 Playground 后先选择一个独立模块：

- **Chat Kit 调试**：不依赖 Manager 登录。默认进入 Mock ChatKit，用于验证正式 Runtime、React、Ant Design UI、Memory Gateway、会话历史、流式回复、中断、错误、断线和重连；也可以切换到 RobotServer 模式，手工填写地址、Namespace、Robot ID 与凭据，验证真实 HTTP/Socket Gateway。
- **登录与机器人**：专注 Manager 用户登录、staging/正式/自定义环境、组织切换、机器人切换和登出。登录后只展示当前组织/机器人信息与一个“当前机器人快速对话”入口，不承载完整 ChatKit 能力演示。选择包含 `robotAccountId` 的 Manager 机器人后，可以一键读取 `connection-info`，按 RFC 8693 使用 Manager 用户 JWT 换取 `robot:{robotAccountId}` 的 session-profile 用户 Token，再建立一条最小 RobotServer 会话；Manager JWT 不会作为 RobotServer 凭据发送。

自定义 Manager 地址仅属于本地 Playground 宿主，不改变公开 `chat-auth` 的固定环境契约。缺少 `robotAccountId` 的机器人不会提供可用的自动连接；如果 Manager 的 `connection-info` 缺失或不完整，连接时会显示明确错误，需要完整调试时请返回 **Chat Kit 调试** 使用手工 RobotServer 连接表单。
Chat Kit 调试模块还提供会话创建/重命名/删除/切换、历史、中断、错误、断线和重连场景；新增“能力演示”入口提供工具呈现、媒体资源、Markdown、长结果导航和文档引用五组可交互示例，详见 [Playground 验收说明](tests/e2e/acceptance.md#issue-58-capability-demonstrations)。RobotServer 模式使用全中文单列表单，填写 RobotServer 服务地址、
Namespace 与 Robot ID 后，Playground 会推导 API 域名和 Socket namespace/path，并由仅存在于本地
Vite 开发服务中的同源代理为聊天请求注入 RobotServer 路由头。鉴权可使用管理员密码、Admin Token
或用户 Token；管理员密码只用于调用 `/v1/auth/login` 换取短期 Admin Token，不会进入聊天会话。
`platformId`、消息创建者与自定义直连端点位于高级设置中；未使用本地预填时所有字段默认留空。
RobotServer 实测动作只允许重命名或删除标题以 `[tf-chat-kit playground]` 开头的测试会话，且重命名必须保留此前缀；自动化只清理本次运行准确创建的会话 ID，不会批量删除普通会话。正常结束时会在显式删除之外再次执行 best-effort 精确清理；若浏览器进程被强杀或清理期间网络不可用，远端仍可能残留，后续清理也只能按已记录的精确 ID 执行。

仅在 `pnpm dev:playground` 的本地 Vite 服务中，连接表单会尝试读取仓库根目录的 `.debug` JSON
作为内存预填值；文件不存在或为空时仍保持全部字段为空。支持的可选字段为 `serverOrigin`、
`namespace`、`robotId`、`authKind`（`password` / `admin` / `bearer`）、`secret`、
`connectionKind`（`standard` / `direct`）、`httpBaseUrl`、`socketNamespaceUrl`、`socketPath`、
`platformId`、`creatorUid` 和 `creatorName`。高级直连必须同时选择 `admin` 或 `bearer`。
`.debug` 已被 Git 忽略；开发服务按页面加载读取并严格校验，不记录内容、不写入浏览器存储，
生产构建与公开包不会读取该文件。

代理只接受同源请求、受信任的 TuringFocus API 域名或显式测试白名单；聊天路由要求恰好一种
Token 凭据，密码登录路由只接受一个受限长度的 password 字段。代理不转发 Cookie，也不记录
凭据。密码和 Token 只保留在当前 React 页面实例的内存中，不会写入浏览器存储、Cookie、URL、
环境文件或诊断日志。生产构建不包含该开发代理，公共包 API 也未改变。

仓库根目录的 `.nvmrc` 与 GitHub Actions 共用 Node.js 24.x。执行任何安装或门禁前先通过
`nvm install && nvm use` 激活该主版本；错误版本会在依赖安装的 `preinstall` 或 workspace
检查前直接失败。显式使用 `--ignore-scripts` 会跳过前者，但不会绕过 `pnpm check`。

`pnpm check` 会执行架构边界、lint、格式、类型、测试、构建、tarball 内容与安全检查，并在临时
TypeScript 消费者中实际安装、构建和运行七个产物。宿主验证必须使用 tarball、npm prerelease
或 npm 官方 Registry 的正式版本，不得通过源码路径消费。
`pnpm pack:workspace` 可从 clean workspace 直接构建并生成经过内容检查的七包 tarball。

Runtime V1 的时间轴性能门禁覆盖 5,000 个常驻条目上的 1,000 次连续增量更新，以及将 5,000
个历史条目一次归并到 5,000 个当前条目。不可变快照会在每次可观察更新时复制时间轴的顶层数组，
但复用未变化的条目对象；超过 10,000 个常驻条目的宿主应通过历史分页限制内存窗口。扩大这一
规模前需先增加对应基准，并评估批量通知或分块持久化结构。

React 宿主通过 `ChatProvider` 注入自行持有的 `ChatClient`；该 Provider 不会释放外部实例。
需要由 React 生命周期创建实例时，使用 `OwnedChatProvider` 和稳定的 `ChatClientFactory`，
并提供释放失败处理。`useChatSelector` 用于订阅所需切片，避免无关快照更新触发组件渲染；
`useChatSnapshot` 仅适用于确实需要完整快照的消费者。

Ant Design 宿主默认使用 `ChatWorkspace`，由它管理会话列表、分页、创建、可选重命名/删除、当前选择、切换竞态与
错误重试；宿主只需注入当前 Robot 对应的 `ChatClient`。需要完全自定义页面工作流时，仍可组合
受控的 `ChatUiShell` 与 `ChatConversationView`。当前会话视图只通过 `ChatProvider` 的 hooks 和 `ChatClient`
执行历史/实时展示、文本/附件发送、Run 中断与受控 Ask User 回答，不读取 Gateway、SessionProvider、路由或全局 Store。
默认 TFRobot factory 复用既有 endpoint、session 和 fetch 配置自动提供附件上传器，不要求宿主配置 COS
或上传路径；自定义后端仍可通过通用 uploader 端口覆盖。超过可配置阈值的粘贴文本以紧凑草稿占位
展示，查看、编辑、删除与发送均保留完整内容。
Ask User 的“聊聊这个”按具体问题通过显式宿主回调交还给页面草稿流程，不冒充 Gateway answer action。
时间轴默认虚拟化，离开底部后不会抢滚动，并通过提示返回最新消息。渲染器注册表支持宿主覆盖，
文本内容默认按经过清洗的 GFM Markdown 渲染；未知事件和单个渲染器异常均安全降级。自定义文案通过 `labels` 注入，主题沿用宿主的 Ant Design
`ConfigProvider` token。

### Word 宿主：单包认证与新版会话协议

只安装 `@turingfocus/chat-kit`，认证能力通过显式子入口使用：

```ts
import { createAuthClient } from "@turingfocus/chat-kit/auth";
import { createTfRobotAuthTransport } from "@turingfocus/chat-kit/auth/tfrobot";
import { createManagerClient } from "@turingfocus/chat-kit/auth/manager";
import { createManagerChatController } from "@turingfocus/chat-kit/manager";
```

`/auth/react`、`/auth/antd` 分别要求宿主提供相应 React、Ant Design peers。
`/auth`、`/auth/tfrobot`、`/auth/manager` 无需 React/DOM。门面负责声明兼容的 auth 依赖；
`chat-auth` 仍独立发布。已有 SessionProvider 接入不需要创建 AuthClient。

当部署的 Server 使用 JSON 创建会话协议时，在 `chat` 配置中显式设置
`conversationContract: "json-v2"`。默认 `query-v1` 保留旧 Server 查询参数协议；
此选项与 Socket 的 `serverProfile` 无关，SDK 不会通过失败后重试创建来猜协议。
Manager 的 `apiBaseURL` 是 BFF 地址；Word 直连 Server 使用已验证的 `routed-server`
路由及允许来源配置，不能把 BFF 地址当成 Bearer Server 地址。

`await controller.select(robot)` 会读取该 Server 的真实平台列表，并返回
`platform-selection-required` 快照。宿主展示 `snapshot.platforms`，让用户明确选择后调用
`await controller.select(robot, { platformId })`。也可在 chat 配置中注入已知的真实 platformId；
Manager 编排仍会校验该 ID 存在。空列表表示没有可选平台；403 与无效 ID 是错误，
不能当作成功。SDK 不自动创建平台，也不自动选择第一项。

`ManagerChatProvider` 的 `platformId` 属性支持 React 宿主受控选择；改变机器人或平台会
释放原聊天实例。平台读取有 30 秒截止时间，账户变更或释放会中止请求并丢弃迟到结果。
直接使用 SessionProvider 的宿主可从 `chat-kit/headless` 导入
`createTFRobotPlatformClient`，通过 `list({ deadlineAt, signal })` 读取平台，显式选择后
传给 `createTFRobotChatClient`；切换平台时释放旧 client，结束时释放平台 client。
