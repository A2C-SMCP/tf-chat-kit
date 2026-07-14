# ADR-002：Runtime 实例模型

- 状态：Accepted
- 日期：2026-07-14

## 背景

聊天状态目前与全局 Store 和 Socket 单例耦合。多窗口、多机器人、多账号、Storybook 和测试场景需要彼此隔离的状态与生命周期，因此全局单例不能成为可复用模块的公共模型。

## 决策

公共入口采用实例化 `ChatClient`。每个实例拥有自己的 Runtime 状态、Gateway 引用、订阅关系和释放生命周期。

ChatClient 对外提供以下能力类别，具体 TypeScript 签名在实现阶段定义：

- 获取当前不可变快照并订阅后续变化。
- 加载或切换会话。
- 发送消息、回答交互请求和中断运行。
- 接收 Gateway 的 snapshot 与增量更新并归并为稳定状态。
- 暴露结构化错误、运行状态和能力信息。
- 显式释放订阅、定时器和连接资源。

Runtime 管理 Conversation、Timeline、Run、Composer 和 capabilities 等聊天语义状态。内部可以选用 Store 或 reducer，但内部状态结构和状态管理库不属于公共 API。

Runtime 不依赖 React、DOM、Socket.IO、Ant Design 或宿主路由。`@tf/chat-react` 只负责把 ChatClient 生命周期映射为 Provider 和 hooks。

## 不变量

- 两个 ChatClient 实例不能共享可变聊天状态或隐式认证上下文。
- 同一服务端更新重复到达时，Runtime 必须能够按标准标识归并或去重。
- 批量历史消息和高频流式更新不能强制整条消息列表逐项重建。
- 实例释放后不得继续向订阅者发送更新。

## 影响

- React、Tauri、测试代码和未来非 React 接入可以复用同一 Runtime。
- 宿主必须显式持有并释放实例。
- Zustand 等实现细节可以替换，而不要求宿主同步改造。

## 未采用方案

- 公开 Zustand Store：会把状态形状和状态库变成长期兼容负担。
- 仅提供 React Context：会排除非 React 使用和低成本 Runtime 测试。
- SDK 全局单例：无法可靠支持多实例、测试隔离和账号切换。
