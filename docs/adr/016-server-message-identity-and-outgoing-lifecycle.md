# ADR-016：服务端消息身份与发送生命周期

- 状态：Accepted
- 批准：用户于 2026-10-15 明确回复“批准”，涵盖方案及 ADR 方向。
- 日期：2026-10-15
- 关联：GitHub #141、TFRS-599
- 补充：ADR-002、ADR-003、ADR-004、ADR-011
- 详细计划：[消息身份实施计划](../design/issue-141-element-id.md)

## 背景

同一用户消息可能先有 Server 分配的 elementId，后有数据库 msgId；也可能永远不持久化。
将稳定身份直接当作“已持久化”会误授权恢复保证。当前临时消息特征配对无法在作者不同等
情况下可靠识别同一消息，默认 UI 的待核对区也不等于独立的发送生命周期。

## 决策

1. 标准 Message 新增可选 serverMessageId，表示当前会话内的服务端稳定身份。
   TFRobot Gateway 从正式 elementId 映射，Runtime 不理解 DTO 或内核内部键。
2. Message.id 继续作为显示/更新时间线的键；MessageProvenance.persisted.id 继续表示
   数据库事实。Server 身份、已接收、已持久化、已完成回复与可靠恢复分别表达。
3. Timeline 和缓存合并优先关联 serverMessageId，允许已有数据库事实作为兼容别名；
   不按正文/作者/时间为有正式标识的用户消息推断身份。旧 Server 保留 #136 路径。
4. Runtime 拥有按实例/会话隔离的 outgoingMessages；请求中的记录不进入正式 timeline。
   POST 身份确认使发送进入 accepted；拿到权威消息元数据后再完成一次正式转正。
   完整原需求所需的 POST 立即转正依赖 Server 回执提供所需元数据。
5. 超时为 unknown，不自动重发。业务终态只接受可关联到对应消息的规范化信号，
   不匹配助手文本、不从历史缺失推断撤回或失败。
6. 缓存可保留稳定身份用于显示合并；outgoing 请求不持久化或重放。缓存不能赋予发送权、
   Server 权威作者或 durable replay 保证。没有完整恢复契约时仍 complete=false。
7. React/UI 从公共 Runtime 快照呈现状态；不建立 UI 私有发送状态机。

不新增包、宿主依赖、轮询、全局实例或认证责任。既有无身份字段的自定义 Gateway 保持可用。

## 前置与替代方案

Server 须确认 POST 的权威时间/用户 DTO 与可关联的拒绝/撤回/繁忙终态。
未确认前只交付已明确的独立 SDK 部分，不声称完整满足 #141。

不采用：将 elementId 当数据库 msgId；按文本跨 UID 去重；从 raw 读取正式身份；
由客户端生成被 Server 信任的 elementId；定时读历史等待临时项消失；客户端时间伪装为 Server 时间。

## 验证与批准

覆盖 Memory Gateway、真实本地 HTTP/Socket.IO、旧/新缓存、公开打包消费者与多实例竞态；
真实 Server 三路一致性及真实 Word 验收分别记录。实现后须完成隔离上下文审查。

本 ADR 已批准，补充现有 Accepted 决策，不改变其持久化、认证与恢复保证边界。
