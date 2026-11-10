# ADR-019：Interaction 通道 UI 接入与单一 pending 源

- 状态：Accepted
- 日期：2026-11-10
- 关联：GitHub #170、#172
- 补充：ADR-002、ADR-003、ADR-005、ADR-010、ADR-017

## 背景

TFRobotFront 已完成 `ask_colleague` Interaction 通道（TFRF-209、ADR v7），kit 的 S1–S3 已引入
Protocol `InteractionRequest` / `InteractionEntry`、Gateway 在共享 `/remote-tool` 上的
Interaction 子协议，以及实例级 Runtime `InteractionClient`。Runtime store 已经负责 EDF、
单活动、上限 10、1 秒 ticker、`now`、pending 快照对账、ack 超时/attempt 与 closed tombstone。

UI 层如果再次实现一套队列或倒计时，会与 Runtime 在抢占、tie-break、过期与墓碑窗口上产生
第二套真相源。另一方面，既有 `AskUserRemoteTool` 与 Gateway `pendingInteraction` 仍会在未启用
Interaction 的宿主中存在，必须避免同一时刻渲染多套 pending 来源。

## 决策

1. **UI 只投影 Runtime store。** `InteractionProvider` 消费宿主注入的实例级
   `InteractionClient`；`getSnapshot()` 的 `entries`、`activeId`、`connection`、`now` 是唯一
   真相源。UI 不排序、不截断、不启动倒计时 ticker，也不把 wire payload 映射为
   `AskUserInteractionRequest`。`InteractionView` 是 Runtime `InteractionEntry` 的 UI 面向
   别名，不是第二套状态模型。
2. **实例所有权。** 每个 Provider 使用自己的 client；不得创建模块级 store 或单例。Provider
   不创建、不释放宿主传入的 client。`interactionClient` 为 `undefined` 时继承外层 Provider，
   为 `null` 时显式禁用，传入实例时以该实例为准。
3. **展示分工。** 活跃项属于当前实际挂载的会话视图时，在消息区上方内联展示；属于其他会话
   或当前视图未挂载（加载、错误、history/settings、fresh 等）时使用全局 Modal；其余 live 项
   进入浮动队列角标。`inlineConversationId` 只在会话视图实际渲染时传入，避免 Modal 被抑制
   却没有任何内联卡片。`ChatConversationView` 默认不内联，需显式传 `interactionInline`；
   默认工作区在显式注入 client 时启用它。宿主隐藏会话表面（例如设置面板）时，应把
   `ChatCompactWorkspace.interactionInlineVisible` 设为 `false`，让队列回退到全局 Modal；
   `ManagerChatApp` 已内置该行为。队列的角标与 Modal 通过 portal 渲染，不受隐藏的会话子树
   影响。
4. **单一 pending 源。** 注入 Interaction client 时，不渲染 legacy `AskUserRemoteTool` 的
   pending 项，也不渲染 Gateway `pendingInteraction`；legacy 已完成的结果历史可以继续展示。
   未注入 client 时，既有 legacy 路径行为不变。`supportsAskUserAdapter` 是传输/服务端能力
   协商，不是 UI 双轨渲染的理由。
5. **默认 UI 的队列所有权。** `ChatWorkspace` / `ChatCompactWorkspace` 只在宿主显式传入
   非 null client 时接入 Interaction UI（内联卡片 + 队列）；`undefined` / `null` 均不继承外层
   Provider，legacy 路径保持不变。自定义 UI 可自行使用 `InteractionProvider` +
   `InteractionQueue`，默认工作区不会与其争夺内联/Modal 展示，避免同一活跃项重复渲染。
   `ManagerChatApp` 只透传宿主持有的 client。
6. **历史展示。** `InteractionHistory` 在现有 tool event renderer 内以只读视图展示
   direction、status、question、answer、answeredBy、error；未知 status 原样展示。不注册新的
   timeline renderer，不改变 ADR-005 的渲染器扩展边界。
7. **版本与边界。** 本变更是向后兼容的 additive minor，不新增 package、不改变依赖方向、
   不改变认证/连接所有权。八包统一版本与发布治理由 #172 处理。

8. **复审后的最终公共面。** `InteractionEntry` 提供可选的 `answeredBy` / `answeredAt`，
   仅用于 closed 状态的可选展示；`InteractionClient` 另提供 `retry()`，v1 UI 不依赖。
   `InteractionStaleReason` 只保留 `ack_timeout`；`already_closed` / `unknown_request` 是
   Runtime 终态，不由 UI 当作 stale 分支展示。宿主已有 `RemoteToolClient` 时必须改用
   `createTFRobotRemoteToolInteractionBundle` 共享同一个 `/remote-tool` owner；仅需要
   Interaction 时使用 `createTFRobotInteractionClient`；standalone RemoteTool 客户端不再接受
   `supportsAskUserAdapter`。UI 只消费这些公共入口，不直接创建 socket 或 transport。

## 未采用方案

- 在 React 层重新实现 EDF/单活动/上限/ticker：会产生与 Runtime 不一致的第二套队列语义。
- 把 wire payload 硬映射为 `AskUserInteractionRequest`：会丢失 requester/target/expiresAt 等
  字段，且混淆两个不同生命周期。
- 注入 Interaction client 时同时渲染 legacy pending：会造成同一问询的多套回答入口。
- 模块级 store 或全局单例：违反 ADR-002 的实例模型与多身份隔离要求。

## 验证

- DOM：Provider 继承/禁用/实例替换/不释放宿主 client；queue 投影使用 runtime
  `activeId`/`now`/`connection`；卡片单选/多选/自由文本、ack 超时重试、连接态；legacy pending
  抑制与已完成历史保留；inline/Modal 在 loading/fresh/history 分支的切换。
- Playwright：fake `/remote-tool` server + 两个独立 browser context，覆盖多 Tab 同收、首答
  生效、失主 `closed(answered)`、早于 connect 的帧序、重连 pending 快照、EDF/上限 10、
  超时/取消与 legacy `supportsAskUserAdapter=false`。
- packed consumer：Front 风格消费者从 `@turingfocus/chat-kit` 编译并运行新的 Provider/hook/
  Queue 导出。
