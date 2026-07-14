# tf-chat-kit 项目章程

## 决策与目标

本项目的立项结论为 **GO**：将当前耦合在 TFRobotFront 中的机器人聊天能力建设为独立、可复用、可按宿主定制的 Chat Kit。

目标不是复制现有 `chat-player`，而是建立稳定的聊天语义边界：Gateway 负责与服务端通信，Runtime 负责状态与命令，React/UI 层负责接入和呈现，宿主负责身份、路由和产品工作流。

## 服务对象

V1 在逻辑能力上支持以下宿主：

| 宿主 | V1 交付方式 |
| --- | --- |
| TFRobotFront | React 接入层和 Ant Design 成品 UI，作为首个生产验证宿主 |
| Tauri 客户端 | React 接入层和 Ant Design 成品 UI |
| Office Add-in | Protocol、Runtime 和 React 接入层；宿主自行实现 UI |
| 受控第三方应用 | 通过私有包使用 Protocol、Runtime、React 接入层或 Ant Design UI |

“支持”表示核心契约不包含 Next.js、TFRobotFront Store、页面路由或全局浏览器状态等单宿主假设。它不表示 V1 为每种宿主交付独立视觉适配器。

## V1 成功标准

- TFRobotFront 能通过发布包完成会话加载、历史展示、实时订阅、文本发送、运行状态展示和中断操作。
- 同一宿主可以创建多个相互隔离的 ChatClient 实例，不发生消息、认证或连接串扰。
- Runtime 在内存 Gateway 与真实 TFRobot Gateway 下遵循同一行为契约。
- 未识别的服务端事件能够安全展示为 fallback，不导致聊天主链路崩溃。
- 新实现的关键交互与性能达到或超过 TFRobotFront 已记录的 V1 基线。
- 至少有一个非 TFRobotFront 宿主完成接入验证，以证明核心边界不依赖原宿主。

## V1 非目标

- 不提供 Fluent UI 成品包。
- 不提供 Web Component 或 iframe 嵌入形态。
- 不接入或实现 AG-UI。
- 不发布公开互联网 npm SDK。
- 不负责用户登录、账号体系、机器人配置三态或宿主页面导航。
- 不在首批建设中预拆 Browser、Editor、Shell 等独立 renderer 包。

## 维护责任

首批文档采用角色责任，不指定未经确认的个人姓名。

| 角色 | 责任 |
| --- | --- |
| Core Maintainers | 维护 Protocol、Runtime、共享 React/UI、架构边界和公共 API |
| Gateway Maintainers | 跟踪 TFRobotServer 契约，维护映射、重连和兼容矩阵 |
| Host Integrators | 维护各宿主的认证注入、路由、布局和集成测试 |
| Release Owner | 管理统一版本、变更记录、CNB 发布和回滚信息 |
| Server Contract Reviewer | 评审会影响消息、事件、认证或连接语义的服务端变化 |

同一人员可以承担多个角色，但每次发布必须能够识别当次 Release Owner 和受影响宿主的 Host Integrator。

## TFRobotServer 兼容关系

- V1 以开始实现时的当前 TFRobotServer 契约为基线，不要求服务端先完成协议版本化。
- `@tf/chat-gateway-tfrobot` 将 REST DTO 和 Socket.IO 事件转换为稳定模型，Runtime 不直接解释服务端事件名。
- 每次发布维护 Chat Kit 版本、服务端基线和宿主验证结果组成的兼容矩阵。
- 向后兼容的新增字段或事件由 Gateway 和 fallback 机制吸收；语义破坏必须进入显式版本决策。

## 迁移与旧模块退场

1. 在新仓库完成最小纵向切片，并同时通过内存 Gateway 与真实 TFRobotServer 验证。
2. TFRobotFront 通过 Feature Flag 接入发布包，旧 `chat-player` 与新实现短期并存。
3. 纵向切片稳定后，新聊天功能只进入 tf-chat-kit；旧模块仅修复严重或阻塞性问题。
4. 新实现达到功能和性能门禁后切为默认，并稳定运行一个发布周期。
5. 删除旧实现及切换开关；从冻结到删除的双轨期最多两个迭代。

如果门禁未通过，应修复新实现或回滚默认值，而不是恢复两个实现的长期并行开发。
