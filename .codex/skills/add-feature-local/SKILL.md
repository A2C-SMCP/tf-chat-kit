---
name: add-feature-local
description: 分析、设计并实现 tf-chat-kit 的新功能，沿用 add-feature 从需求澄清、追踪、现状与复用审查、方案评审、依赖分析、审批实施、测试、隔离审查到交付的完整流程，并强制执行从 TFRobotFront chat-player 剥离为多宿主公共模块所产生的范围、分层、兼容、认证和迁移约束。当用户在本仓库提出新功能、Feature Request、交互或协议扩展、事件渲染器、Gateway/Runtime/React/UI 能力、迁移旧 chat-player 行为，或询问某项能力是否应进入 tf-chat-kit 时使用。
---

# Add Feature Local

把 `tf-chat-kit` 当作供 TFRobotFront、Tauri、Office Add-in 和受控第三方应用使用的公共产品，而不是 TFRobotFront 的复制品或前端子目录。沿用通用 `add-feature` 流程，同时先证明功能应属于公共模块，再讨论实现。

## 必读上下文

开始 Phase 0 前完整读取：

1. `README.md`
2. `docs/project-charter.md`
3. `docs/adr/README.md` 及其中所有状态为 `Accepted` 的 ADR
4. [references/scope-boundaries.md](references/scope-boundaries.md)

按需读取 `/Users/huruize/TSProject/TFRobotFront` 中旧 `chat-player` 的代码、测试和现状文档，只把它们当作行为、兼容和性能证据。不得把旧目录结构、全局 Store、Socket 单例、Next.js 依赖或早期 `src/packages/chat-kit` 占位设计当作本项目架构依据。

若路径不存在，继续依据本仓库材料工作并明确证据缺口，不要阻塞无关功能。

## 全流程硬约束

1. **公共模块先过范围门**：先输出 `IN / SPLIT / OUT / ADR REQUIRED` 结论。`OUT` 的宿主能力不得塞入 Kit；`SPLIT` 必须分别写清 Kit 契约与宿主实现。
2. **Accepted ADR 优先**：需求或技术建议与 Accepted ADR 冲突时，不得直接实现，也不得悄悄改写原 ADR。提出新 ADR，说明替代关系、迁移影响和宿主影响，等待批准。
3. **宿主依赖零回流**：任何 Kit 包不得依赖 TFRobotFront、Next.js App Router、Office API、Tauri API、宿主 Store、页面路由或宿主全局浏览器状态。平台能力通过窄接口、Gateway 或宿主注入进入。
4. **稳定语义优于源码复刻**：迁移旧 `chat-player` 时提取聊天语义、契约、交互和性能基线，不复制历史耦合。旧实现中的 bug、单例和偶然数据形状不是兼容承诺。
5. **最低正确层级**：把能力放入能完整表达它的最低层包，并遵守 `protocol <- runtime <- react <- ui-antd`、`protocol <- gateway-tfrobot`、`protocol/runtime <- testing`。UI 不得直连 Gateway。
6. **多实例与宿主所有权**：ChatClient、状态、认证和连接按实例隔离并可显式释放。身份、登录、路由、页面布局和产品工作流始终由宿主负责。
7. **兼容与安全是功能的一部分**：服务端 DTO/事件在 Gateway 边界校验和转换；未知事件安全 fallback；`raw` 只作安全处理后的辅助数据；不得存储或泄露凭证。
8. **复用优于新建，根治优于补丁**：先搜索等价能力和最相似实现。不得为了缩小 diff 跨层绕行；最佳方案影响大时交用户评审。
9. **轮询必须审批**：优先事件驱动。确需轮询时，先说明替代方案为何不可行、间隔/退避/上限/资源成本及可验证依据，获得用户批准后实施。
10. **范围不扩张**：不得借公共化之名预建没有真实消费者、独立依赖或独立发布节奏的抽象、包或适配器。

## Phase 0：需求理解与公共性判定

把需求改写为：谁在哪个宿主场景下，需要哪种聊天能力，Kit 提供什么稳定语义，宿主仍负责什么，解决什么问题。

主动读取相关代码与文档，再澄清每轮不超过 3 个会改变方案的问题。至少确认：

- 用户场景、触发行为、成功结果和非目标。
- 受影响宿主，以及非 TFRobotFront 宿主是否可在不引入 TFRobotFront 概念的情况下消费。
- 数据/服务端契约、认证材料来源和 capability 差异。
- 是稳定聊天语义、TFRobot 传输适配、无样式 React 接入、通用 Ant Design UI，还是宿主产品工作流。
- 对公共 API、包体、性能、可访问性、兼容矩阵和迁移门禁的影响。

按 `references/scope-boundaries.md` 输出范围判定：

```text
结论：IN | SPLIT | OUT | ADR REQUIRED
Kit 责任：...
宿主责任：...
目标包：...
受影响宿主：...
依据：章程/ADR/现有公共契约/消费者证据
```

`OUT` 时停止 Kit 实施，指出应落入的宿主项目。`SPLIT` 时只继续 Kit 部分，未经授权不修改宿主仓库。`ADR REQUIRED` 时先完成 ADR 决策。

**准出**：范围结论明确，能够描述公共能力与宿主责任的分界。

## Phase 0.5：工作项追踪

沿用通用 `add-feature` 的最小科学追踪原则：大型使用 Epic→Story→Issue，中型使用 Story，可收敛的小型使用单 Issue；复用已有工作项，不重复创建。

- 输入含 Jira/GitHub/CNB Issue 时读取详情和父级目标，核对层级，并在开始实施前推进最底层工作项到“进行中”。
- 未提供 Issue 但仓库已配置追踪系统且工具可用时，按规模建立最小结构。
- 仓库尚未配置追踪系统或工具不可用时，不得假造编号；记录缺口并与用户对齐是否继续。追踪缺口不得被描述为已完成。
- 父级只承载北极星和聚合进度，不为同一变更复制描述。

**准出**：已有工作项已推进，或追踪缺口已显式处理。

## Phase 1：现状、复用与迁移审查

1. 检查当前仓库状态、工程阶段、包结构、公共导出、测试和未提交变更；不要假设 README 中的“当前状态”仍然有效。
2. 搜索现有等价能力、扩展点、测试工具和最相似实现，选择直接复用、增强或新建。
3. 对照所有 Accepted ADR 确定目标包和依赖方向；检查是否出现宿主源码导入、跨层调用、全局单例或 DTO 泄漏。
4. 涉及旧 `chat-player` 时建立“旧行为 → 稳定语义 → 新包 → 验证方式”映射。先确认旧路径仍有 caller，区分生产行为、测试夹具、过期计划和死代码。
5. 识别是否需要同步改动 TFRobotFront、TFRobotServer、Tauri 或 Office Add-in；外部仓库只读分析，除非用户明确授权改动。

**准出**：每个新增构件都无等价实现；目标包、参照物、迁移证据和外部影响明确。

## Phase 2：技术方案评审

输出文件/包变更清单、公共 API 变化、依赖方向、风险和验证计划。逐条说明外部技术建议是采纳、修改还是拒绝。

方案必须回答：

- 为什么这是 Kit 能力而非宿主功能？
- 为什么放在该包，不在更低或更高层？
- 无 React、无 DOM、非 Ant Design 或非 TFRobot Gateway 的消费者是否被不必要地绑定？
- 多实例、释放、重复事件、未知事件、认证失效和 capability 缺失如何表现？
- 公共契约是否向后兼容？若破坏兼容，版本、迁移和兼容矩阵如何处理？
- 如何用内存 Gateway 和真实 TFRobot Gateway 验证一致行为？
- 如何由至少一个非 TFRobotFront 消费场景证明宿主无关，而不是只改名复用？

新增包、改变依赖方向、改变认证所有权、改变已有标准模型语义或扩大 V1 非目标时，默认判为 `ADR REQUIRED`。新增向后兼容的可选字段、command、capability、事件或 renderer 通常按 Minor 变更评审，不因“公共 API 有新增”自动要求 ADR；若它同时改变既有所有权或边界，仍须 ADR。

**准出**：范围、架构和测试方案与用户对齐。

## Phase 3：上下游依赖分析

无外部依赖时跳过。存在依赖时，为每个外部项目形成独立请求，包含请求方、业务背景、期望能力、优先级、非约束性建议、契约/鉴权/错误/兼容交付要求。

- 服务端字段、事件或认证语义变化由 TFRobotServer 负责人确认；Kit 不替服务端拍板。
- 宿主身份、路由、布局或平台 API 由 Host Integrator 实现；Kit 只提供必要的稳定端口。
- 阻塞项等待外部交付，非阻塞部分可按已批准边界继续；不得用临时跨层耦合绕过阻塞。

## Phase 4：审批计划与实施

先给出按依赖自底向上的计划：Protocol → Gateway/Runtime → React → UI → Testing/Consumer validation。列出每个文件的改动、测试和迁移步骤；用户审批后再编码。

实施时：

- 模仿本仓库已接受模式，不照搬 TFRobotFront 的目录和全局状态。
- 用公共端口和依赖注入隔离宿主差异；保持公共导出面最小。
- 每完成一个逻辑单元运行当前仓库已有的最快相关检查。
- 计划外独立问题建立阻塞工作项；当前上下文小问题先说明并获确认。不得顺手修改宿主代码或扩张 V1。
- 如果仓库仍处于仅文档阶段，先把脚手架、工具链和包边界作为显式方案评审内容，不凭空假定命令或依赖版本。

## Phase 5：测试与质量门禁

按变更层级覆盖核心、边界和错误路径，并优先使用仓库实际存在的命令：

- Protocol：运行时 schema、标准标识/顺序、向后兼容和 unknown event。
- Runtime：内存 Gateway 下的状态机、幂等/去重、流式归并、多实例隔离和 dispose 后静默。
- Gateway：REST/Socket 映射、重连、重复投递、错误映射、认证过期和敏感字段清理。
- React：Provider/hooks 生命周期、实例替换、卸载释放和无 Ant Design 依赖。
- UI/renderer：fallback、错误边界、capability 隐藏、宿主覆盖及重依赖懒加载。
- 跨包：依赖方向、公共导出、统一版本、安装/构建和 tree-shaking/包体影响。
- 集成：同一 Runtime 契约通过内存与真实 Gateway；至少一个非 TFRobotFront 宿主或最小消费者验证。

需要真实凭证、真实服务端、发布或重型 E2E 的测试不自动执行时，给出准确命令、环境前提和未验证风险，不得声称通过。

### Phase 5.5：隔离上下文审查

进入交付前，启动只读独立 reviewer，要求加载 `turingfocus-toolkit:code-review`（可用时），自行读取 skill、Accepted ADR 和 `git diff`，重点检查范围回流、包依赖、公共 API、认证、实例隔离、兼容与测试。按用户指定的 review 模式处理问题；默认修复阻塞项。复审直到阻塞项清零。

若当前环境不能启动独立 reviewer，明确标记门禁未完成并请求用户决定，不得把同一实现者的自查伪装成隔离审查。

## Phase 6：交付

交付摘要必须包含：

- 范围结论及 Kit/宿主责任。
- 新增和修改的包、公共 API 与用途。
- Accepted ADR 合规结果；新增/替代 ADR（如有）。
- 测试命令、通过结果、未运行项和真实环境风险。
- 已验证宿主、TFRobotServer 基线与兼容矩阵影响。
- 迁移状态：旧/新路径、Feature Flag、性能门禁、冻结或退场影响。
- 外部依赖、宿主后续接入和待办项。

代码、lint 和测试通过不代表可提交。未获用户对本次变更的明确授权前，不执行 `git add`、commit、push、发布或创建 PR。获得授权后再提交，并把可用的 commit/分支信息回写追踪系统；只在子项全部完成时关闭父级。

## 反模式

| 禁止 | 应做 |
| --- | --- |
| 把 TFRobotFront `chat-player` 整目录搬进来 | 提取稳定语义并按六包边界重建 |
| 因首个消费者是 TFRobotFront 就依赖其 Store、Router 或 API 层 | 通过 Gateway、SessionProvider、props 或端口注入 |
| 为某个宿主的按钮或页面流程扩大 Runtime | 留在宿主；必要时只增加通用 command/capability |
| Runtime 解释 Socket.IO 事件名或服务端 DTO | 在 `gateway-tfrobot` 校验并标准化 |
| UI/renderer 直接连 Socket 或读取认证 | 只使用标准模型和 Runtime 受控命令 |
| 用全局 ChatClient、Socket 或认证变量省事 | 每实例持有并显式释放 |
| 把 `raw` 当默认 UI 或业务逻辑主输入 | 使用标准模型，`raw` 仅作安全辅助 |
| 为 Office/Tauri 提前创建无消费者适配包 | 先保持宿主适配，真实复用需求出现后评审 |
| 修改 Accepted ADR 以配合实现 | 新建 ADR 并记录 supersede 关系 |
| 只在 TFRobotFront 验证“可复用” | 增加非 TFRobotFront 最小消费者或宿主验证 |
| 测试通过后自动提交或发布 | 等用户明确授权 |
