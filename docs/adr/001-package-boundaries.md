# ADR-001：包边界与依赖方向

- 状态：Accepted
- 日期：2026-07-14

## 背景

现有聊天能力同时包含服务端通信、消息状态、React 绑定、Ant Design 组件和重型事件渲染器。整体复制会把 TFRobotFront 的框架、Store 和连接假设一起带入新项目，无法形成稳定复用边界。

## 决策

采用一个 Git 仓库、六个 workspace 包：

| 包 | 公共职责 | 禁止承担的职责 |
| --- | --- | --- |
| `@tf/chat-protocol` | 标准模型、运行时校验契约、Gateway 端口 | 状态管理、网络连接、React UI |
| `@tf/chat-runtime` | ChatClient、状态机、更新归并和命令协调 | Socket.IO、DOM、宿主路由 |
| `@tf/chat-gateway-tfrobot` | TFRobotServer REST/Socket.IO 适配 | UI、产品页面状态 |
| `@tf/chat-react` | Provider、hooks、React 生命周期绑定 | Ant Design 视觉、服务端 DTO 解析 |
| `@tf/chat-ui-antd` | Ant Design 成品 UI、默认 renderer registry | 认证持久化、Socket 连接 |
| `@tf/chat-testing` | 内存 Gateway、fixtures、契约测试工具 | 生产网络行为 |

依赖方向固定为：

```text
protocol <- runtime <- react <- ui-antd
protocol <- gateway-tfrobot
protocol/runtime <- testing
```

UI 只能通过 React/Runtime 的公共能力发出命令，不得直接访问 Gateway。任何包都不得引用 TFRobotFront、Office Add-in、Tauri 或第三方宿主的源码。

Browser、Editor、Shell 等重型 renderer 在出现明确的独立安装或版本需求前，先作为 `ui-antd` 的可懒加载内部模块存在，不创建空包。

## 影响

- 核心逻辑可以在没有 React、Ant Design 和 Socket.IO 的环境中测试和使用。
- 一次跨层变化可以在同一 PR 中原子修改和验证。
- workspace 和发布流程需要强制检查包间依赖方向。
- 将来拆分包必须由真实消费者或依赖差异驱动，而不是提前预留。

## 未采用方案

- 单仓单包：初期简单，但会弱化依赖隔离并迫使无 UI 消费者承受 UI peer dependency。
- 多个独立仓库：自治更强，但协议、Runtime 和适配器的同步成本过高。
- 预先拆分所有 renderer：会产生没有独立生命周期的空包。
