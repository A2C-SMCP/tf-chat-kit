# tf-chat-kit 运行时复用决策实验记录

- 日期：2026-07-14（Asia/Shanghai）
- 状态：Completed
- 关联决策：是否应修改 EPIC-001 的六包架构，改用 AG-UI、AI SDK 或 assistant-ui 承担协议、无头运行时或 React 接入层
- 最终结论：`GO`——保留 EPIC-001 当前六包边界；本轮不以候选库替换任何一个完整包

## 决策摘要

三种候选都提供了可复用能力，但没有一个满足预注册的“完整替代”门槛：

- AG-UI 能表达消息/事件快照、Run 生命周期和未知原始事件，但没有覆盖 TFRobot 的 SessionProvider、历史分页和 task-aware stale interrupt 命令端口。
- AI SDK 能处理一次请求内的消息流、message parts 和 abort，但独立 REST 历史与 Socket 更新仍要求 tf-chat-kit 持有规范快照、归并、Run、中断和 Gateway 生命周期；把外部更新写回 `Chat.messages` 会形成一层影子状态。
- assistant-ui 能提供 React runtime context、消息/组件 primitives 和 capability callbacks，但仍要求自定义 ChatClient-to-React 订阅适配器，并依赖外部规范状态、历史/实时归并、认证隔离和 Gateway 生命周期。

因此，当前 `@tf/chat-protocol`、`@tf/chat-runtime`、`@tf/chat-gateway-tfrobot`、`@tf/chat-react`、`@tf/chat-ui-antd`、`@tf/chat-testing` 的职责切分不需要改写。assistant-ui 可在以后作为 `chat-react`/`chat-ui-antd` 的内部 UI 依赖单独评估，但不能成为规范状态或无头 Runtime。

## 待验证假设与预注册门槛

### 假设

AG-UI、AI SDK 或 assistant-ui 至少有一个可以替代 EPIC-001 中的一个完整目标包，从而减少自研与长期维护成本。

### 候选通过条件

候选必须同时满足：

1. 替代一个完整目标包，而不是只提供若干类型或 UI primitives。
2. 不要求应用同时维护候选状态和 tf-chat-kit 规范状态。
3. 在它声称替代的边界内通过以下守护行为：
   - 历史与独立实时更新归并；
   - 重复、乱序和未知事件；
   - 多实例、会话和认证隔离；
   - stale interrupt；
   - dispose 后停止通知并释放资源。
4. 不把 Next.js、Ant Design、全局 Store、Socket 单例或宿主认证带入无头核心。

### 预注册结果映射

- 有候选满足门槛：`GO（Hybrid）`，重写受影响包和 Jira Story。
- 没有候选满足门槛：`GO（Current Architecture）`，保留自定义协议端口与无头 Runtime。
- 第二宿主边界无法消费：`DEFER`，缩小纵向切片后再验证。
- 结果冲突或无法区分：`DEFER`，补充实验。

本次结果命中第二条：`GO（Current Architecture）`。

## 实验环境与安全边界

- 工作目录：`experiments/decision-lab-runtime-reuse/`
- Node.js：`v24.14.0`
- pnpm：`10.14.0`
- 系统：Darwin arm64
- 固定依赖：
  - `@ag-ui/core` / `@ag-ui/client` `0.0.57`
  - `ai` `7.0.26`、`@ai-sdk/react` `4.0.27`
  - `@assistant-ui/react` `0.14.26`
  - React `18.3.1`、TypeScript `5.7.3`、Vitest `4.0.18`
- 依赖使用 `pnpm install --ignore-scripts` 安装；未运行依赖生命周期脚本。
- 只使用脱敏 fixture；未访问真实服务、真实凭证或用户数据。
- `node_modules` 约 129 MB，仅代表三套候选与开发工具的联合安装体积，不作为产品 bundle 指标。

## 实验实现

### 自定义参考边界

[`src/canonical.ts`](src/canonical.ts) 实现最小规范模型、Gateway port、稳定标识归并、实例化 ChatClient、中断和 dispose；[`src/fixtures.ts`](src/fixtures.ts) 提供历史、重复/乱序更新、未知事件和 Run 完成 fixture。

### 候选探针

- [`src/agui-adapter.ts`](src/agui-adapter.ts)：使用真实 `EventSchemas` 验证 Activity、Run 和 Raw event 映射。
- [`src/ai-sdk-adapter.ts`](src/ai-sdk-adapter.ts)：使用真实 `Chat` 和 `ChatTransport` 验证请求内流，并注入独立 Gateway 更新以观察状态所有权。
- [`src/assistant-ui-adapter.tsx`](src/assistant-ui-adapter.tsx)：使用真实 `useExternalStoreRuntime`，验证初始快照、实时订阅、取消回调和外部职责。
- [`src/tauri-consumer-smoke.tsx`](src/tauri-consumer-smoke.tsx)：不依赖 Next.js/Ant Design 的 React 18 消费代码，纳入严格 TypeScript 检查。
- [`src/assessment.ts`](src/assessment.ts)：输出机器可读的替代范围评估。

## 结果

### 自动化结果

- TypeScript 严格检查：通过。
- Vitest：4 个测试文件、12 个测试全部通过。
- 测试总耗时：518 ms（最终 verbose run）。
- 机器可读结果：[`artifacts/vitest.json`](artifacts/vitest.json)。

“候选探针测试通过”表示真实公开 API 成功复现了候选能力与缺口，不表示候选通过整包替代门槛。

| 守护行为/职责 | 自定义参考 | AG-UI | AI SDK | assistant-ui |
| --- | --- | --- | --- | --- |
| 历史 + 独立实时更新 | 通过 | 只表达事件，不负责加载/归并 | 需规范快照和自定义桥 | 需外部 Store 和订阅桥 |
| 重复、乱序、未知事件 | 通过 | Raw 可保留 unknown，去重/排序仍在 Runtime | 仍在自定义归并层 | 仍在外部 Store |
| 多实例/认证隔离 | 通过 | 不提供 SessionProvider | 依赖自定义 Gateway 实例 | 依赖外部 ChatClient/Gateway |
| stale interrupt | 通过 | 无对应 TFRobot command port | 仍由自定义 Runtime/Gateway 处理 | 仅把 cancel 回调转给自定义 Runtime |
| dispose/资源释放 | 通过 | 不拥有 TFRobot 连接 | 仍由桥接层释放 Gateway | 仍由宿主/Provider 所有权规则处理 |
| 替代完整目标包 | 是（参考实现） | 否 | 否 | 否 |

### 代码规模观察

- 最小自定义参考：159 行。
- AI SDK 桥：129 行；仍保留规范快照与 Gateway 生命周期。
- AG-UI 映射：85 行；仍缺命令、认证与分页端口。
- assistant-ui 适配：72 行；仍包含 ChatClient-to-React 订阅桥。

这些数字只描述实验探针，不用于估算生产实现工期；它们显示候选并未消除核心边界代码。

## 失败与调整记录

1. 安装期间 npm registry 出现数次临时 `EPROTO`，pnpm 自动重试后成功；未更换版本或 Registry。
2. 首次类型检查失败：
   - AI SDK data part 在 `exactOptionalPropertyTypes` 下不能显式写入 `undefined`；改为仅在存在时展开 `raw`。
   - assistant-ui 的 generic ExternalStore 要求显式 `convertMessage`；按公开类型补充 converter。
   - ES2022 不含 `Array.prototype.toSorted`；改为 `slice().sort()`，保持不修改原数组。
3. 初始 assistant-ui 探针只覆盖初始快照和 cancel，没有证明实时 React 订阅。按照原定“历史 + 实时更新”门槛补上 `useSyncExternalStore` 和实时更新断言；这反而确认了自定义 React 订阅桥仍然必需。

以上修改都没有改变核心指标、依赖版本或通过门槛。

## 生命周期与架构影响

- 继续自研的长期成本集中在 TFRobotServer DTO/Socket 适配、规范归并和实例生命周期；这些也是候选无法替代且最具项目特异性的部分。
- AG-UI 若直接成为规范协议，会迫使项目在其通用事件模型之外继续维护 TFRobot command/session/page 侧协议，形成双协议边界。
- AI SDK 若成为 canonical runtime，会同时存在请求内 `Chat.messages` 与独立实时规范快照，状态所有权更复杂。
- assistant-ui 适合作为可选 UI/runtime primitives 来源，但采用它仍需保留 `chat-react` 的稳定订阅和实例所有权规则，并会让公共 React 层承诺其 API/升级节奏。
- 现阶段六包方案使 Tauri、Office Add-in 和自定义 UI 只选择所需层级，符合从 TFRobotFront 剥离公共模块的业务约束。

## 限制与剩余风险

- 本实验使用可判别 fixture，不是对真实 TFRobotServer 的端到端验证；真实 REST/Socket 契约仍由 EPIC-001 的 TK-02/TK-06 验证。
- Tauri smoke 只证明 React 18 + TypeScript 边界不需要 Next.js/Ant Design，没有替代真实宿主安装、启动和释放验收；实际宿主仍是 Epic 完成门禁。
- 未进行候选的生产 bundle、渲染性能、可访问性或视觉体验对比，因为它们不会改变本轮“能否整包替代协议/Runtime/React 边界”的判定。
- assistant-ui 的产品体验价值仍可能成立，但应在 `chat-ui-antd` 进入详细设计时以独立需求评估，不能借此扩大无头核心职责。

## 复现

```bash
cd experiments/decision-lab-runtime-reuse
pnpm install --ignore-scripts
pnpm typecheck
pnpm test
pnpm test:json
pnpm assess
```

## 后续动作

1. 以当前 EPIC-001 六包边界继续 Jira Story 拆分，不因候选库改写 package ownership。
2. TK-01～TK-05 先形成最小纵向切片；真实 TFRobot Gateway、TFRobotFront Feature Flag 和第二宿主验证继续作为后续独立交付与集成门禁。
3. 在 `chat-react`/`chat-ui-antd` 详细设计阶段，如果希望采用 assistant-ui，再单独评估 bundle、样式体系、可访问性、API 稳定性和宿主自定义成本。
4. 保留本目录作为架构决策证据；临时外部源码 clone 是否清理由用户确认。
