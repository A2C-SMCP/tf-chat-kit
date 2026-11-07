# ADR-017：可选的跨 namespace 共享连接上下文

- 状态：Accepted
- 日期：2026-11-06
- 关联：GitHub #167
- 补充：ADR-002、ADR-003、ADR-006、ADR-010
- 实施计划：[共享连接方案](../design/issue-167-shared-socket.md)

## 背景

Chat 与 RemoteTool 当前分别建立 Socket.IO Manager。宿主需要在同一身份与 Robot 内复用底层 WebSocket，同时分别控制聊天与工具 namespace 的认证、连接、注册、注销和释放。

ADR-003 规定 Gateway 管理连接生命周期并禁止 SDK 全局 Socket 单例。本提案明确可选共享模式下物理连接与 namespace 的所有权，保留默认独立模式。

## 提议决策

1. Gateway 包提供显式创建的 `createTFRobotSocketConnection`，返回实例私有的 `socketFactory` 和幂等 `dispose`；Kit Headless 门面导出此能力。客户端复用既有 socketFactory 注入端口，不新增平行配置，不向 Runtime 暴露 Socket.IO。
2. 共享上下文管理一个 Manager / Engine.IO 连接，客户端分别管理其 namespace Socket 与业务生命周期。单方释放不整体关闭另一方；最后一个活动 namespace 结束后底层关闭，上下文可再次使用直至整体 dispose。
3. 默认构造不读取认证或连接网络。各 namespace 通过自身 SessionProvider 获取认证，凭证不进入 URL、公共状态、日志或持久化。
4. 不通过模块级缓存自动共享，不跨 connection、Robot 或身份隐式合并。宿主固定端点，并在身份或 Robot 切换时释放旧上下文。各 namespace 的 scope 可以不同。
5. Manager 负责共享重连；Gateway 和 RemoteTool 负责各自恢复。整体 dispose 必须使在途回调失效并停止所有通道恢复。
6. 保留原有独立客户端 API、会话订阅和恢复保证、工具权限、同名冲突、超时、取消与去重语义。不在通用工具注册中增加会话归属，不改服务端协议。

## 影响与验证

新增可选公共 API，按 Minor 记录，不新增 package 或依赖方向。React/Antd 沿用 Headless 的公开装配端口，平台 API 与身份策略继续归宿主。

真实本地 Socket.IO 必须证明两个 namespace 共享 Engine.IO ID、单方失败/释放不影响另一方、最后使用方离开关闭连接、重连分别恢复以及多个上下文隔离；另用独立打包消费者验证公开入口。

## 替代方案

- 仅删除 forceNew，依赖 io() 全局缓存：连接归属不显式，不采用。
- 将工具注册并入聊天会话生命周期：会让工具依赖会话选择，不采用。
- 保持两条独立 WebSocket：保留为兼容默认路径，但无法满足显式共享诉求。

用户于 2026-11-06 明确确认实施计划及本 ADR；实现与测试结果另行记录。
