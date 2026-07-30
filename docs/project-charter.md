# tf-chat-kit 项目章程

## 决策与目标

本项目的立项结论为 **GO**：将当前耦合在 TFRobotFront 中的机器人聊天能力建设为独立、可复用、可按宿主定制的 Chat Kit。

目标不是复制现有 `chat-player`，而是建立稳定的聊天语义边界：Gateway 负责与服务端通信，Runtime 负责状态与命令，React/UI 层负责接入和呈现，宿主负责身份、路由和产品工作流。

> **2026-07-30 决策更新**：tf-chat-kit 作为底层独立项目，不依赖任何宿主或服务端项目的源码、
> 构建、部署与任务状态。每个支持的接入形态必须在本仓库有近似的契约型 mock/版本化消费者并
> 作为发布门禁；真实外部 E2E 只补充兼容证据。

## 服务对象

V1 在逻辑能力上支持以下宿主：

| 宿主          | V1 交付方式                                                                              |
| ------------- | ---------------------------------------------------------------------------------------- |
| TFRobotFront  | React 接入层和 Ant Design 成品 UI；仓库内维护 Front 风格版本化消费者                     |
| Tauri 客户端  | React 接入层和 Ant Design 成品 UI                                                        |
| Office Add-in | Protocol、Runtime 和 React 接入层；宿主自行实现 UI                                       |
| 第三方应用    | 通过 npm 官方 Registry 的公开 MIT 包使用 Protocol、Runtime、React 接入层或 Ant Design UI |

“支持”表示核心契约不包含 Next.js、TFRobotFront Store、页面路由或全局浏览器状态等单宿主假设，
并且对应接入形态在本仓库有可重复的兼容测试。它不表示 V1 为每种宿主交付独立视觉适配器，也不
要求真实宿主项目先完成接入。

## V1 成功标准

- Front 风格版本化消费者能通过发布包完成会话加载、历史展示、实时订阅、文本发送、运行状态展示和中断操作。
- 同一宿主可以创建多个相互隔离的 ChatClient 实例，不发生消息、认证或连接串扰。
- Runtime 在内存 Gateway 与受控 TFRobot Gateway 适配器下遵循同一行为契约。
- 未识别的服务端事件能够安全展示为 fallback，不导致聊天主链路崩溃。
- Front、Office 与 Tauri 风格的近似消费者覆盖各自依赖拓扑、peer 下界和生命周期。
- 待发布产物不包含宿主源码、源码路径依赖、开发者路径或凭据。

## V1 非目标

- 不提供 Fluent UI 成品包。
- 不提供 Web Component 或 iframe 嵌入形态。
- 不接入或实现 AG-UI。
- 不承诺为公开包提供账号登录、托管服务或每个宿主的产品级集成。
- 不负责用户登录、账号体系、机器人配置三态或宿主页面导航。
- 不在首批建设中预拆 Browser、Editor、Shell 等独立 renderer 包。

## 维护责任

首批文档采用角色责任，不指定未经确认的个人姓名。

| 角色                     | 责任                                                                        |
| ------------------------ | --------------------------------------------------------------------------- |
| Core Maintainers         | 维护 Protocol、Runtime、共享 React/UI、架构边界和公共 API                   |
| Gateway Maintainers      | 跟踪 TFRobotServer 契约，维护映射、重连和兼容矩阵                           |
| Host Integrators         | 维护各宿主的认证注入、路由、布局和集成测试                                  |
| Release Owner            | 管理统一版本、变更记录、GitHub Actions、npm 公开发布、provenance 和回滚信息 |
| Server Contract Reviewer | 评审会影响消息、事件、认证或连接语义的服务端变化                            |

同一人员可以承担多个角色，但每次发布必须能够识别当次 Release Owner 和受影响宿主的 Host Integrator。

## TFRobotServer 兼容关系

- V1 以开始实现时的当前 TFRobotServer 契约为基线，不要求服务端先完成协议版本化。
- `@turingfocus/chat-gateway-tfrobot` 将 REST DTO 和 Socket.IO 事件转换为稳定模型，Runtime 不直接解释服务端事件名。
- 每次发布维护 Chat Kit 版本、服务端基线、仓库内近似消费者结果和可选真实 E2E 状态组成的兼容矩阵。
- 向后兼容的新增字段或事件由 Gateway 和 fallback 机制吸收；语义破坏必须进入显式版本决策。

## 兼容验证与宿主边界

1. 在本仓库用 Memory Gateway、受控 TFRobot Gateway 和版本化消费者完成最小纵向切片。
2. Front 风格 mock 验证 Feature Flag 新旧路径互斥、失败关闭、回滚和释放，但不拥有真实宿主开关。
3. Office/Tauri 风格消费者验证不同 UI、peer 版本与平台端口拓扑，不导入其源码或锁文件。
4. 真实宿主或服务 E2E 可由独立环境运行；结果进入兼容报告，缺失不阻塞发布。
5. 外部 E2E 发现的 Kit 缺陷必须固化为本仓库可重复的契约测试。

真实宿主的接入、灰度、冻结和旧模块删除由对应项目独立管理，不属于 tf-chat-kit 的完成条件。
