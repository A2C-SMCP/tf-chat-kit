# tf-chat-kit

TFRobot 聊天能力的可复用模块。项目采用 Headless Runtime、宿主无关协议、TFRobot Gateway 和可替换 UI 的分层方式，使同一套聊天能力可以集成到 TFRobotFront、Office Add-in、Tauri 客户端和受控第三方应用。

## 当前状态

项目处于 V1 纵向切片建设阶段。六包 workspace、统一构建测试配置和本地 tarball 验证已经建立；`@turingfocus/chat-protocol` 提供标准模型、运行时 schema 与 Gateway/SessionProvider 端口，`@turingfocus/chat-testing` 提供内存 Gateway、标准 fixtures 与框架无关契约套件，`@turingfocus/chat-runtime` 提供实例化 ChatClient、不可变快照、历史/实时归并、聊天命令和显式释放，`@turingfocus/chat-gateway-tfrobot` 提供实例隔离的 TFRobotServer REST/Socket.IO、DTO 校验、短期认证注入和安全映射，`@turingfocus/chat-react` 提供无样式 Provider、选择性订阅 hooks 和明确的实例所有权，`@turingfocus/chat-ui-antd` 提供会话壳、虚拟化时间轴、安全 Markdown、文本发送、Run/中断控件、Ask User 交互和可扩展渲染器。真实 Gateway 与真实宿主 E2E 作为可选兼容观察记录；TFRobot `/remote-tool` 的多 Provider 与会话路由完成前，实时 Ask User 回答能力保持关闭。

## V1 承诺

- Protocol、Runtime 和 React 接入层支持 TFRobotFront、Office Add-in、Tauri 和受控第三方应用。
- 提供 React + Ant Design 成品 UI。
- Office Add-in 和第三方应用可以基于 React 接入层实现自己的 UI。
- 在公开的 `A2C-SMCP/tf-chat-kit` GitHub 仓库维护，并通过 npm 官方 Registry 公开发布 MIT 包。
- 以当前 TFRobotServer 契约为兼容基线，由 Gateway 隔离服务端差异。
- 每个支持的接入形态在本仓库维护近似的版本化消费者或受控传输，并作为发布硬门禁；真实外部
  E2E 不构成项目依赖。

V1 不承诺 Fluent UI、Web Component、AG-UI、账号登录系统或为每个宿主提供独立视觉包。

## 初始包

| 包                                  | 职责                                        |
| ----------------------------------- | ------------------------------------------- |
| `@turingfocus/chat-protocol`        | 标准聊天模型、运行时校验契约和 Gateway 端口 |
| `@turingfocus/chat-runtime`         | 实例化 ChatClient、状态机和聊天命令         |
| `@turingfocus/chat-gateway-tfrobot` | TFRobotServer REST 与 Socket.IO 适配        |
| `@turingfocus/chat-react`           | React Provider、hooks 和无样式接入层        |
| `@turingfocus/chat-ui-antd`         | Ant Design 成品 UI 与默认渲染器             |
| `@turingfocus/chat-testing`         | 内存 Gateway、fixtures 和契约测试工具       |

核心依赖方向为：

```text
chat-ui-antd -> chat-react -> chat-runtime -> chat-protocol
chat-ui-antd -------------------------------> chat-protocol
                         chat-gateway-tfrobot -> chat-protocol
                                  chat-testing -> chat-protocol
```

`chat-testing` 不依赖 Runtime 实现；后续 Runtime 通过测试适配器接入其契约套件。

任何 Chat Kit 包都不得反向依赖 TFRobotFront 或其他宿主项目。

## 文档

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
pnpm check
pnpm pack:workspace
```

仓库根目录的 `.nvmrc` 与 GitHub Actions 共用 Node.js 24.x。执行任何安装或门禁前先通过
`nvm install && nvm use` 激活该主版本；错误版本会在依赖安装的 `preinstall` 或 workspace
检查前直接失败。显式使用 `--ignore-scripts` 会跳过前者，但不会绕过 `pnpm check`。

`pnpm check` 会执行架构边界、lint、格式、类型、测试、构建、tarball 内容与安全检查，并在临时
TypeScript 消费者中实际安装、构建和运行六个产物。宿主验证必须使用 tarball、npm prerelease
或 npm 官方 Registry 的正式版本，不得通过源码路径消费。
`pnpm pack:workspace` 可从 clean workspace 直接构建并生成经过内容检查的六包 tarball。

Runtime V1 的时间轴性能门禁覆盖 5,000 个常驻条目上的 1,000 次连续增量更新，以及将 5,000
个历史条目一次归并到 5,000 个当前条目。不可变快照会在每次可观察更新时复制时间轴的顶层数组，
但复用未变化的条目对象；超过 10,000 个常驻条目的宿主应通过历史分页限制内存窗口。扩大这一
规模前需先增加对应基准，并评估批量通知或分块持久化结构。

React 宿主通过 `ChatProvider` 注入自行持有的 `ChatClient`；该 Provider 不会释放外部实例。
需要由 React 生命周期创建实例时，使用 `OwnedChatProvider` 和稳定的 `ChatClientFactory`，
并提供释放失败处理。`useChatSelector` 用于订阅所需切片，避免无关快照更新触发组件渲染；
`useChatSnapshot` 仅适用于确实需要完整快照的消费者。

Ant Design 宿主可以在自己的页面布局中组合 `ChatUiShell` 与 `ChatConversationView`。会话列表、
当前选择和切换回调均由宿主控制；当前会话视图只通过 `ChatProvider` 的 hooks 和 `ChatClient`
执行历史/实时展示、文本发送、Run 中断与受控 Ask User 回答，不读取 Gateway、SessionProvider、路由或全局 Store。
Ask User 的“聊聊这个”按具体问题通过显式宿主回调交还给页面草稿流程，不冒充 Gateway answer action。
时间轴默认虚拟化，离开底部后不会抢滚动，并通过提示返回最新消息。渲染器注册表支持宿主覆盖，
文本内容默认按经过清洗的 GFM Markdown 渲染；未知事件和单个渲染器异常均安全降级。自定义文案通过 `labels` 注入，主题沿用宿主的 Ant Design
`ConfigProvider` token。
