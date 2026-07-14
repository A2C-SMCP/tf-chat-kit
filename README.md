# tf-chat-kit

TFRobot 聊天能力的可复用模块。项目采用 Headless Runtime、宿主无关协议、TFRobot Gateway 和可替换 UI 的分层方式，使同一套聊天能力可以集成到 TFRobotFront、Office Add-in、Tauri 客户端和受控第三方应用。

## 当前状态

项目处于工程初始化阶段。六包 workspace、统一构建测试配置和本地 tarball 验证已经建立；聊天协议、Runtime、Gateway、React 与 UI 的公共 API 将由后续 Story 按依赖顺序实现。

## V1 承诺

- Protocol、Runtime 和 React 接入层支持 TFRobotFront、Office Add-in、Tauri 和受控第三方应用。
- 提供 React + Ant Design 成品 UI。
- Office Add-in 和第三方应用可以基于 React 接入层实现自己的 UI。
- 通过 CNB 私有 Registry 向公司内部和获授权合作方发布。
- 以当前 TFRobotServer 契约为兼容基线，由 Gateway 隔离服务端差异。

V1 不承诺 Fluent UI、Web Component、AG-UI、公开 npm SDK 或账号登录系统。

## 初始包

| 包 | 职责 |
| --- | --- |
| `@tf/chat-protocol` | 标准聊天模型、运行时校验契约和 Gateway 端口 |
| `@tf/chat-runtime` | 实例化 ChatClient、状态机和聊天命令 |
| `@tf/chat-gateway-tfrobot` | TFRobotServer REST 与 Socket.IO 适配 |
| `@tf/chat-react` | React Provider、hooks 和无样式接入层 |
| `@tf/chat-ui-antd` | Ant Design 成品 UI 与默认渲染器 |
| `@tf/chat-testing` | 内存 Gateway、fixtures 和契约测试工具 |

核心依赖方向为：

```text
chat-ui-antd -> chat-react -> chat-runtime -> chat-protocol
                         chat-gateway-tfrobot -> chat-protocol
                                  chat-testing -> protocol/runtime
```

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
```

`pnpm check` 会执行架构边界、lint、格式、类型、测试、构建、tarball 检查，并在临时消费者中
实际安装六个产物。宿主验证必须使用 tarball 或后续 Registry 版本，不得通过源码路径消费。
