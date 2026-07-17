# ADR-003：Gateway 与 Socket.IO 边界

- 状态：Accepted
- 日期：2026-07-14

## 背景

TFRobot 当前通过 REST 获取部分数据，并通过 Socket.IO 传递实时聊天消息和事件。Socket.IO 是现行基础设施，但它是否长期保持不变并不确定。将事件名和连接对象暴露给 Runtime 会使通信技术变化穿透全部宿主。

## 决策

在 `@turingfocus/chat-protocol` 定义宿主无关的 Chat Gateway 端口，在 `@turingfocus/chat-gateway-tfrobot` 提供当前 TFRobotServer 实现。

TFRobot Gateway 按实例负责：

- 使用 REST 加载会话和历史数据。
- 建立、加入、退出和恢复 Socket.IO 实时连接。
- 将服务端 DTO 与事件转换为标准 snapshot 或增量更新。
- 处理断线、重连、重复事件、错误映射和资源释放。
- 从注入的 SessionProvider 获取当前认证材料。

Runtime 只能看到标准 Gateway 端口，不得看到 Socket 实例、Socket.IO 事件名、namespace 或重连实现。

禁止在 SDK 中维护全局 Socket 单例。宿主提供 endpoint、SessionProvider 和必要的连接配置，Gateway 管理自身生命周期。平台特定网络能力可以通过 Gateway 配置或替代实现扩展，但不能改变 Runtime 契约。

## 兼容策略

- V1 直接适配当前 TFRobotServer，不以服务端先增加协议版本为前置条件。
- REST 或 Socket.IO 的字段、路径和事件名变化由 Gateway 吸收。
- 如果未来迁移到其他实时协议，只替换 Gateway 实现；Runtime 和 UI 语义保持稳定。
- 无法兼容的服务端语义变化需要更新兼容矩阵并按 ADR-007 处理版本。

## 影响

- 当前可以继续使用成熟的 Socket.IO 链路，不需要为了抽象而更换基础设施。
- Gateway 需要承担更多契约测试和边界错误处理。
- 宿主不再负责重复实现 join、reconnect 和 DTO 映射逻辑。

## 未采用方案

- Socket.IO 作为 Core 契约：会让基础设施细节成为公共 API。
- 宿主注入现成 Socket：会在各宿主重复连接协议和重连逻辑。
- SDK 全局连接：无法满足多实例和多认证上下文。
