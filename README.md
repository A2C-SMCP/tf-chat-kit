# tf-chat-kit

TFRobot 聊天能力的可复用模块。项目采用 Headless Runtime、宿主无关协议、TFRobot Gateway 和可替换 UI 的分层方式，使同一套聊天能力可以集成到 TFRobotFront、Office Add-in、Tauri 客户端和受控第三方应用。

## 当前状态

项目处于 V1 纵向切片建设阶段。六包 workspace、统一构建测试配置和本地 tarball 验证已经建立；`@turingfocus/chat-protocol` 提供标准模型、运行时 schema 与 Gateway/SessionProvider 端口，`@turingfocus/chat-testing` 提供内存 Gateway、标准 fixtures 与框架无关契约套件，`@turingfocus/chat-runtime` 提供实例化 ChatClient、不可变快照、历史/实时归并、聊天命令和显式释放。TFRobot Gateway、React 与 UI 的实现由后续 Story 按依赖顺序完成。

## V1 承诺

- Protocol、Runtime 和 React 接入层支持 TFRobotFront、Office Add-in、Tauri 和受控第三方应用。
- 提供 React + Ant Design 成品 UI。
- Office Add-in 和第三方应用可以基于 React 接入层实现自己的 UI。
- 在公开的 `A2C-SMCP/tf-chat-kit` GitHub 仓库维护，并通过 npm 官方 Registry 公开发布 MIT 包。
- 以当前 TFRobotServer 契约为兼容基线，由 Gateway 隔离服务端差异。

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
                         chat-gateway-tfrobot -> chat-protocol
                                  chat-testing -> chat-protocol
```

`chat-testing` 不依赖 Runtime 实现；后续 Runtime 通过测试适配器接入其契约套件。

任何 Chat Kit 包都不得反向依赖 TFRobotFront 或其他宿主项目。

## 文档

- [项目章程](docs/project-charter.md)
- [架构决策记录](docs/adr/README.md)
- [工程与发布基线](docs/engineering-baseline.md)
- [V1 建设与 TFRobotFront 迁移 Epic](docs/epics/001-chat-kit-v1-and-tfrobotfront-migration.md)

## 开发

```bash
corepack prepare pnpm@10.34.5 --activate
pnpm install
pnpm check
pnpm pack:workspace
```

`pnpm check` 会执行架构边界、lint、格式、类型、测试、构建、tarball 内容与安全检查，并在临时
TypeScript 消费者中实际安装、构建和运行六个产物。宿主验证必须使用 tarball、npm prerelease
或 npm 官方 Registry 的正式版本，不得通过源码路径消费。
`pnpm pack:workspace` 可从 clean workspace 直接构建并生成经过内容检查的六包 tarball。

Runtime V1 的时间轴性能门禁覆盖 5,000 个常驻条目上的 1,000 次连续增量更新，以及将 5,000
个历史条目一次归并到 5,000 个当前条目。不可变快照会在每次可观察更新时复制时间轴的顶层数组，
但复用未变化的条目对象；超过 10,000 个常驻条目的宿主应通过历史分页限制内存窗口。扩大这一
规模前需先增加对应基准，并评估批量通知或分块持久化结构。
