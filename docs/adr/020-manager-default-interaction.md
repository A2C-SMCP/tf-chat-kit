# ADR-020 / ManagerChatApp 默认接入 Interaction

- 状态：Accepted
- 日期：2026-11-25

用户确认宿主只需接入 `ManagerChatApp`，由 Chat Kit 自动建立连接并显示问询。
本决策更新 [ADR-019](019-interaction-channel-ui.md) 第 5 项中 `ManagerChatApp` 的连接所有权，
以及第 9、10 项对该组件默认连接路径的约束。工作区继续使用现有 Interaction Runtime、队列和卡片。

## 决策

- `ManagerChatApp` 在当前聊天就绪后，通过宿主已有的 ManagerClient 为同一个机器人获取单独的
  `action:execute` 会话。组件使用机器人已验证的部署入口并校验 Interaction 机器人身份。
- 默认连接独立于宿主管理的 Socket.IO 连接。需要与 RemoteTool 共用连接的宿主可传入现有 bundle
  的 Interaction client 和身份。Playground 中聊天和 `add` 继续共享它们已有的连接。
- 默认连接在第一次同步成功后启用现有 Interaction 卡片和队列。连接失败、缺少权限或服务端
  未协商 Interaction 时，聊天仍能使用。重新连接后的状态由现有 Runtime 管理。
- 组件释放自己创建的连接。宿主传入 client 时，沿用原有的身份校验和宿主释放责任。传入
  `interactionClient={null}` 可关闭默认接入。省略属性时优先继承已有的外层 Provider，队列仍由宿主管理。其他工作区和 Headless 的组装方式沿用 ADR-019。
