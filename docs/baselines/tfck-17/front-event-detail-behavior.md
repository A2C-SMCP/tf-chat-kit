# TFCK-17 TFRobotFront 事件详情行为基线

## 证据快照

- 仓库：`/Users/huruize/TSProject/TFRobotFront`
- 参考 commit：`af3b4e2fa8d7a94c458d7c0812435ad17df0eb2e`
- 读取日期：2026-08-01
- 工作区：存在尚未提交的 Chat Kit 宿主接入、依赖和文档改动；本基线没有修改该仓库，也不把这些工作区改动作为 Front 事件详情行为的依据。
- 主要实现：
  - `src/components/chat-player/player/ChatPlayerContent.tsx`
  - `src/components/chat-player/player/conversation/event/ChatEventComponent.tsx`
  - `src/components/chat-player/player/event-detail/EventDetailWrapper.tsx`
  - `src/components/chat-player/player/conversation/event/ChatEventComponent.css`
  - `src/components/chat-player/ChatPlayerContainer.css`
- 主要测试：
  - `__test__/components/chat-player/player/ChatPlayerContent.unit.test.tsx`
  - `__test__/components/chat-player/player/event-detail/ask-user-render/AskUserToolReturnRender.integration.test.tsx`
  - `playwright/stories/chat-player/player/event-detail/EventDetailWrapper.spec.ts`

如果参考 commit 或上述文件发生变化，应重新核对本表，而不是默认旧结论仍成立。

## Front 行为到 Kit 语义映射

| Front 用户可观察行为                                                                              | Front 证据                                                                                                   | Kit 稳定语义                                                                                                                                       | 目标层                     | 自动化验证                                         |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- | -------------------------------------------------- |
| 消息与聚合同一事件 ID 的事件按时间混排；事件是时间线中的一个条目。                                | `ChatPlayerContent.tsx:115-121, 489-518, 585-608`；`ChatPlayerContent.unit.test.tsx:401-558`                 | 所有标准消息继续留在时间线；`agent-event` 与 `unknown-event` 以稳定 ID 各占一个紧凑行，同 ID transition 更新同一行和详情。                         | UI，复用 Protocol 标准模型 | renderer、选择状态、同 ID 更新与虚拟化测试         |
| 事件行可点击，包含类别图标、单行摘要、状态、时间；选中项使用主题色边框和背景，失败/超时视觉明确。 | `ChatEventComponent.tsx:195-312`；`ChatEventComponent.css:9-123, 205-217`；`ChatPlayerContainer.css:302-306` | 鼠标或键盘激活紧凑事件行；用 Ant Design token 表达状态、选中与失败，不复制硬编码 Front CSS。                                                       | UI renderer                | generic、Tool、failed、timeout、unknown 与键盘测试 |
| 桌面主区域为左侧时间线、分隔条、右侧详情；没有选择时右侧显示空态。                                | `ChatPlayerContent.tsx:692-746`；`ChatPlayerContainer.css:34-49, 156-224`                                    | 宽容器的 `auto` 模式解析为约 56%/44% 双栏；未选择时显示安全空态；首版不提供拖拽条。                                                                | UI composition             | 容器测量、双栏比例、空态与模式切换测试             |
| 点击事件设置当前事件；详情按 ID 从当前会话事件集合派生，所以同 ID 更新会反映到详情。              | `ChatPlayerContent.tsx:489-518, 566-608, 729-746`                                                            | 选择由用户激活产生，详情始终从当前 timeline 按 ID 派生，不缓存事件副本。新事件到达不得改变选择。                                                   | UI interaction state       | 点击选择、新事件不抢占、同 ID 原位更新测试         |
| Front 的自动播放会自动选中最新事件并滚动到它。                                                    | `ChatPlayerContent.tsx:247-251, 501-508`                                                                     | **不迁移**。TFCK-17 明确采用仅点击选择；保留 Chat Kit 既有尾部跟随和“返回最新消息”，但它们不驱动事件选择。                                         | UI non-goal                | 新事件与尾部跟随回归测试                           |
| 非 Tool 多段事件按 transition 展示多个 Tab，默认展示最新段；单段文本保留软换行。                  | `ChatEventComponent.tsx:83-154`；`EventDetailWrapper.tsx:73-105`；`EventDetailWrapper.spec.ts:11-52`         | 详情展示所有标准 transitions 并默认突出最新 transition；只消费 normalized summary/error/time，以纯文本保留软换行。                                 | UI renderer                | 多 transition、纯文本与长内容边界测试              |
| Tool 详情按 tool call/return 分发；Ask User、失败和未知形态有独立或 fallback 展示。               | `EventDetailWrapper.tsx:106-158`；`AskUserToolReturnRender.integration.test.tsx:54-160`                      | Tool 详情只消费标准 `toolCall`、`toolReturn`、`interaction`；结果沿用长度上限；Ask User 历史复用公共结果组件；unknown 仅显示类型、安全摘要和时间。 | UI renderer                | Tool、Ask User、失败、unknown、截断与 raw 安全测试 |
| 详情 renderer 包含 Browser/Editor/Shell 等 Next.js dynamic 组件和附件下载。                       | `EventDetailWrapper.tsx:14-69, 160-253`                                                                      | **不迁移**。TFCK-17 不新增重型 renderer 或宿主下载行为；未标准化能力继续使用安全通用详情/fallback。                                                | 非目标                     | 依赖边界与 packed consumer 检查                    |
| Front 用可拖拽宽度、Context 中的 current event/play mode 和全局 Socket 数据驱动播放器。           | `ChatPlayerContent.tsx:47-78, 520-559, 749-799`                                                              | **不迁移**。Kit 状态按 `ChatConversationView` 实例隔离；容器模式与选择支持受控/非受控 API，不读取 Gateway、宿主 Store 或 Socket。                  | UI composition             | 多实例、会话切换、卸载与消费者测试                 |
| Front 的小屏 CSS 保持桌面布局并允许横向滚动。                                                     | `ChatPlayerContainer.css:324-348`                                                                            | **不迁移**。Kit 按组件容器而非 viewport 响应；窄容器使用 Modal，不产生不可用横向布局。                                                             | UI composition             | ResizeObserver 与窄容器测试                        |

## 父 Issue 验收覆盖

| #17 验收标准                                                   | 本基线结论                                                                    | 计划证据                                       |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------- |
| 全部消息 + 紧凑事件行                                          | 保留混排语义，事件行提取 Front 的状态、摘要、时间和选中反馈。                 | renderer + vertical slice                      |
| 宽容器双栏，空态，仅点击选择                                   | 复用 Front 双栏/空态；显式拒绝 auto play 抢占。                               | selection + responsive tests                   |
| 窄容器 Modal，允许手动模式优先                                 | 这是 Kit 的多宿主扩展；Front 无对应窄容器语义。                               | ResizeObserver + controlled/uncontrolled tests |
| generic、Tool、多 transition、Ask User、失败、unknown 安全详情 | 标准模型字段足够，无需 Protocol/Gateway 变更。                                | renderer safety matrix                         |
| 鼠标/键盘/Modal 焦点与失效清理                                 | 点击源于 Front；键盘、Escape、焦点恢复和清理是 Kit 可访问性补全。             | interaction/focus tests                        |
| renderer、虚拟滚动、尾部跟随、命令无回归                       | 选择只包裹事件条目，不改变消息 renderer、Runtime 命令或 tail tracker。        | existing suites + regression additions         |
| Playground 两种 Gateway 模式使用正式组件                       | 同一 `ChatConversationView` 公共 API 覆盖 Mock 与 RobotServer，不复制状态机。 | Playground unit/E2E                            |

## 模型充分性与边界结论

当前 `Message`、`GenericAgentEvent.transitions`、`ToolAgentEvent.transitions`、`AskUserInteractionResult` 和 `UnknownEvent` 已覆盖首版安全详情所需的标识、状态、摘要、错误、时间、Tool 调用/返回及交互历史。没有发现必须从 `raw` 或 TFRobotServer DTO 读取才能满足父 Issue 的详情字段，因此 Protocol/Gateway 不构成阻塞项。

不在本功能中迁移：Next.js dynamic、全局 Store/Context、Socket 单例、原始 DTO、播放器自动跟随选择、拖拽分隔条、附件下载和宿主路由。它们不是多宿主稳定聊天语义。
