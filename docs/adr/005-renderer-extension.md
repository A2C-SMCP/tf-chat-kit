# ADR-005：事件渲染扩展机制

- 状态：Accepted
- 日期：2026-07-14

## 背景

TFRobot 聊天不仅展示文本消息，还包含 Browser、Editor、Preview、Shell、Ask User 和回放等事件。不同宿主的视觉体系、可用能力和包体限制不同，因此渲染器既不能进入无 UI Runtime，也不能全部固化成不可裁剪的 Ant Design 实现。

## 决策

事件渲染扩展位于 React/UI 层，通过 renderer registry 按标准事件类型注册。

每个 renderer 只能接收：

- 标准事件模型和经过清理的 raw 数据。
- 当前展示模式与主题上下文。
- Runtime 暴露的受控命令，例如回答交互请求或控制回放。

Renderer 不得直接访问 Socket、SessionProvider、服务端 DTO 或宿主全局 Store。

`@tf/chat-ui-antd` 提供通用消息和首批默认事件渲染器。Monaco、xterm 等重型依赖只在对应事件实际展示时加载。宿主可以覆盖默认 renderer、增加自定义 renderer 或不注册某种能力；未注册和未知事件统一使用 fallback。

Office Add-in 和需要非 Ant Design 视觉的第三方应用通过 `@tf/chat-react` 构建自己的 UI。V1 不承诺 Fluent UI 包，也不把 renderer registry 放入 Runtime。

## 错误边界

- 单个 renderer 加载或渲染失败不能中断消息列表和输入能力。
- fallback 至少展示事件类别、时间和可安全显示的摘要。
- 宿主未启用某项 capability 时，相应操作必须隐藏或明确不可用。

## 影响

- 重组件可以裁剪和懒加载，降低首屏成本。
- 不同宿主能够共享语义与交互命令，同时替换视觉实现。
- Registry 的输入上下文需要保持精简和稳定。

## 未采用方案

- Renderer 放入 Runtime：会破坏 Headless 边界。
- 所有 renderer 固化进 Ant Design 包：包体大且宿主无法裁剪。
- 所有 renderer 交给宿主实现：会丢失 TFRobot 特有交互的主要复用价值。
