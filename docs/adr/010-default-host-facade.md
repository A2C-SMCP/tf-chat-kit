# ADR-010：统一宿主门面与七包边界

- 状态：Accepted
- 日期：2026-08-05
- 替代：ADR-001
- 补充：ADR-008 的公开包集合与 ADR-009 的版本化消费者门禁

## 背景

ADR-001 将协议、Runtime、TFRobot Gateway、React 绑定、Ant Design UI 和测试工具拆成六个公共包，成功阻止了 React、Ant Design、Socket.IO 与宿主源码向 Headless 核心回流。但默认的 TFRobot + React + Ant Design 宿主需要理解所有内部层级，分别声明五个生产包并手动组合 Gateway、ChatClient 和 React 生命周期工厂。

默认宿主本来就需要这五层能力。要求它直接消费全部叶子包没有减少其安装或运行依赖，反而扩大了接入样板、版本声明和生命周期装配错误的空间。Front 风格和 Tauri 风格消费者已经证明该组合是实际支持的公共接入形态，而不是为假想宿主预建的抽象。

## 决策

在原有六个叶子包之上新增第七个公开包 `@turingfocus/chat-kit`，作为 Headless、自定义 React UI 和默认 Ant Design UI 宿主共同使用的生产门面。

公共包职责如下：

| 包                                  | 公共职责                                                              | 禁止承担的职责                              |
| ----------------------------------- | --------------------------------------------------------------------- | ------------------------------------------- |
| `@turingfocus/chat-protocol`        | 标准模型、运行时校验契约、Gateway 端口                                | 状态管理、网络连接、React UI                |
| `@turingfocus/chat-runtime`         | ChatClient、状态机、更新归并和命令协调                                | Socket.IO、DOM、宿主路由                    |
| `@turingfocus/chat-gateway-tfrobot` | TFRobotServer REST/Socket.IO 适配                                     | UI、产品页面状态                            |
| `@turingfocus/chat-react`           | Provider、hooks、React 生命周期绑定                                   | Ant Design 视觉、服务端 DTO 解析            |
| `@turingfocus/chat-ui-antd`         | Ant Design 成品 UI、默认 renderer registry                            | 认证持久化、Socket 连接                     |
| `@turingfocus/chat-testing`         | 内存 Gateway、fixtures、契约测试工具                                  | 生产网络行为、门面生产依赖                  |
| `@turingfocus/chat-kit`             | 分层子路径生产门面、TFRobot Gateway + ChatClient + React factory 组合 | 新的聊天状态、传输、认证、UI 或宿主产品逻辑 |

依赖方向固定为：

```text
protocol <- runtime <- react <- ui-antd
protocol <- gateway-tfrobot
protocol/runtime <- testing

protocol/runtime/gateway-tfrobot/react/ui-antd <- chat-kit
```

`chat-kit` 只能组合或重新导出叶子包的公共 API，不得从叶子包内部路径导入，不得被任何叶子包反向依赖。它提供：

- `createTFRobotChatClient()`：为每次调用创建实例隔离的 TFRobot Gateway 和拥有该 Gateway 的 ChatClient。
- `createTFRobotChatClientFactory()`：为 `OwnedChatProvider` 提供每次创建全新实例、每次清理获取新绝对 deadline 的工厂。
- `@turingfocus/chat-kit/headless`：只导出 Protocol、Runtime、TFRobot Gateway 和 Headless 组合工厂，不加载 React 或 UI 模块。
- `@turingfocus/chat-kit/react`：在 Headless 入口上增加无样式 Provider、hooks 和 React 生命周期工厂。
- `@turingfocus/chat-kit/antd`：在 React 入口上增加成品 Ant Design UI；根入口 `@turingfocus/chat-kit` 与该入口等价。

门面不包含 `@turingfocus/chat-testing`。普通宿主统一安装一个门面包并按形态选择子路径；需要最小安装树、非 TFRobot Gateway 或更低层扩展面的高级消费者仍可直接安装叶子包。

宿主仍负责登录、凭证刷新、SessionProvider、服务端点、Robot 路由、消息创建者、主题、页面状态、实例切换和产品工作流。门面不得持久化认证材料、创建全局 ChatClient/Socket，或读取宿主 Router、Store 和平台 API。

## 版本与发布

- 七包继续使用同一个 Changesets fixed group 和统一 `0.x` 版本。
- `@turingfocus/chat-kit` 使用 MIT、npm 官方 Registry、public access 和与叶子包相同的 provenance、tag、回滚及发布门禁。
- Front 风格 packed consumer 必须只声明一个 Chat Kit 生产依赖并从门面公共入口构建和运行。
- packed consumers 必须分别编译和运行 `headless`、`react` 与默认 Ant Design 入口；Office/Headless 叶子消费者继续验证最小依赖拓扑，Tauri 消费者继续证明非 TFRobotFront 的 UI 组合兼容性。
- 真实宿主和真实服务 E2E 仍是非阻塞兼容证据，不成为本仓库发布依赖。

## 影响

- 所有普通宿主只需理解一个产品包，并按宿主技术栈选择分层入口；内部依赖隔离保持不变。
- 组合工厂集中维护实例、Gateway 所有权和释放约定，减少宿主重复样板。
- npm 不能按导入子路径条件安装依赖，因此单门面安装树仍包含五个生产叶子包；子路径只保证 Headless 运行时和声明入口不加载 React/DOM/Ant Design。React、ReactDOM 和 Ant Design 在门面 manifest 中是可选 peer，具体入口按文档要求宿主提供兼容版本。
- 对安装体积或严格最小 peer 拓扑敏感的高级消费者继续使用叶子包；统一门面优化的是普通宿主的产品入口和装配成本，不伪装成条件安装机制。
- 新增叶子能力不会自动成为门面承诺；门面导出与组合 API 需要显式评审和消费者验证。
- 发布、tarball、Changesets、兼容矩阵和文档中的公共包集合从六包变为七包。

## 未采用方案

- 将五个生产叶子包合并为单包：会重新耦合 Headless、React、视觉和传输边界。
- 让所有形态从同一个根模块静态导出：Headless ESM 加载会解析 React 和 Ant Design 模块；分层子路径能保留运行时隔离。
- 从 `chat-ui-antd` 反向导出 Gateway 和 Runtime：会让视觉包感知传输组合，破坏依赖方向。
- 只在文档中提供宿主侧 helper：仍要求每个宿主声明五包并复制生命周期装配，无法形成版本化公共接入契约。
- 把 `chat-testing` 纳入门面：会让生产默认入口携带测试工具并模糊生产与测试边界。
