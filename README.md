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

V1 不承诺 Fluent UI、Web Component、AG-UI、账号登录系统或为每个宿主提供独立视觉包。

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

核心依赖方向为：

```text
chat-ui-antd -> chat-react -> chat-runtime -> chat-protocol
chat-ui-antd -------------------------------> chat-protocol
                         chat-gateway-tfrobot -> chat-protocol
chat-kit -> chat-ui-antd/chat-react/chat-runtime/chat-gateway-tfrobot/chat-protocol
                                  chat-testing -> chat-protocol
```

普通宿主只需安装 `@turingfocus/chat-kit`：非 React 使用 `/headless`，自定义 React UI 使用 `/react`，成品 UI 使用根入口或 `/antd`。高级消费者仍可按需安装叶子包；`chat-testing` 是独立开发依赖，不进入生产门面。

任何 Chat Kit 包都不得反向依赖 TFRobotFront 或其他宿主项目。

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

`pnpm dev:playground` 会在 `http://localhost:3000` 启动仓库私有演示应用。Mock 模式直接组合
正式 Runtime、React、Ant Design UI 与 Memory Gateway，提供会话创建/重命名/删除/切换、历史、流式回复、
中断、错误、断线和重连场景。RobotServer 模式使用全中文单列表单，填写 RobotServer 服务地址、
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
执行历史/实时展示、文本发送、Run 中断与受控 Ask User 回答，不读取 Gateway、SessionProvider、路由或全局 Store。
Ask User 的“聊聊这个”按具体问题通过显式宿主回调交还给页面草稿流程，不冒充 Gateway answer action。
时间轴默认虚拟化，离开底部后不会抢滚动，并通过提示返回最新消息。渲染器注册表支持宿主覆盖，
文本内容默认按经过清洗的 GFM Markdown 渲染；未知事件和单个渲染器异常均安全降级。自定义文案通过 `labels` 注入，主题沿用宿主的 Ant Design
`ConfigProvider` token。
