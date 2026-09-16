# Issue #82：会话提示分级与安全诊断实施方案

状态：实现、测试、打包验证、浏览器验收及隔离复审完成，等待提交授权。

来源：[Issue #82](https://github.com/A2C-SMCP/tf-chat-kit/issues/82)，
「[会话提示] 减少状态提示打扰并提供具体错误与可复制诊断」。

分析基线：`dev-0.8.2` / `a0dd631`；初始工作区无未提交修改。
追踪：复用 #82，已添加 `in-progress`；该项无 GitHub parent。
虽然涉及多个包，但围绕同一用户行为统一交付，不另建重复父项。

## 需求与范围

IN。聊天用户需要正常连接与恢复少打扰、阻塞问题持续可见；排障人员需要知道失败
操作、已确认原因与影响，并复制安全诊断关联日志。

Kit 负责标准诊断契约、传输边界采集、实例内记录、React 订阅和通用 UI。
宿主负责登录、应用版本及可选长期日志上报。服务端有 Request ID / Trace ID 时
使用，没有时明确未提供，不要求新增服务端字段。适用于 Front、Tauri、Office
自定义 UI 与第三方 Headless 消费者；不改其他仓库。

遵守 ADR-002/003/004/005/006/008/009/010/011；不新增包，不改变依赖、认证
所有权、连接可操作性或缓存信任边界。`degraded` 仍是尽力恢复，缓存视图不获得
发送权限，发送与交互回答不自动重放。按目前方案无需新 ADR。

## 现状证据与复用

| 当前落点                                                     | 已有能力与缺口                                                                                                  | 决策                                                     |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `chat-protocol/src/models.ts`                                | 有 `ChatErrorOccurrence`、scope、generation；`ChatError` 只有分类、message、retryable、conversationId、details  | 增加可选标准诊断字段，保留旧字段                         |
| `chat-runtime/src/chat-client.ts`                            | 命令错误分配 occurrence，但 command scope 使用错误 ID，返回结果尚无共同关联字段；快照为空时错误不会进入活动快照 | 贯通一次操作与 occurrence，诊断存储独立于活动快照        |
| `chat-runtime/src/snapshot-state.ts`                         | 已支持 `error.reported` / `error.resolved` 和独立活动错误                                                       | 复用精确解决语义，不按恢复状态清空全部错误               |
| `chat-gateway-tfrobot/src/http.ts`                           | 已有 deadline、认证失效处理与凭证脱敏；HTTP 状态在任意 details 中，未标准化请求元数据                           | 在真实请求边界采集，UI 不解析 details                    |
| `chat-gateway-tfrobot/src/socket.ts`、`types.ts`             | 已有 occurrence、生命周期和诊断回调                                                                             | 增强现有通道，错误发生时冻结上下文                       |
| `chat-protocol/src/raw.ts`、Gateway `redaction.ts`           | 已有凭证模式与实际凭证值脱敏；原始数据预算大，不能保证排除聊天正文                                              | 复用脱敏基础，另建窄诊断投影，禁止原始响应透传           |
| `chat-ui-antd/src/use-chat-command-coordinator.ts`           | `sameChatError` 按分类、会话和文案比较；有任意命令失败时直接隐藏快照错误                                        | 替换为 occurrence / scope / operation 关联，独立错误共存 |
| `chat-ui-antd/src/chat-conversation-view.tsx`                | 缓存、存储、生命周期、快照错误和命令错误分别渲染 Alert                                                          | 统一分级，只保留一个会话级故障横幅，操作错误就近展示     |
| `chat-ui-antd/src/chat-workspace.tsx`、`chat-state-view.tsx` | 首次加载期间会话视图可能未挂载，立即显示中心加载态                                                              | 覆盖首次无快照入口，不能只修改已加载会话                 |
| `chat-ui-antd/src/chat-composer.tsx`                         | 附件已有就近错误，但异常可能直接显示原始 message                                                                | 保留就近位置，接入统一安全错误投影                       |

## 用户可见行为

| 场景                             | 状态入口与输入区                                                   | 横幅 / 轻提示                                                   |
| -------------------------------- | ------------------------------------------------------------------ | --------------------------------------------------------------- |
| 首次连接、加入、缓存同步         | 前 2 秒无主动状态提示；输入仍按真实权限禁用；超过 2 秒显示紧凑阶段 | 不显示常驻进度横幅，不把缓存 offline 投影称为断网               |
| 实际连接中断                     | 立即更新工具栏与不可用原因                                         | 故障连续超过 5 秒升级横幅；reconnecting → recovering 不重新计时 |
| 认证失效、订阅失败、终止恢复     | 明确阶段、影响和可用操作                                           | 立即持续显示，直至解决或手动关闭                                |
| 首次进入 degraded                | 状态入口说明恢复能力有限                                           | 不弹“已恢复”                                                    |
| 已向用户展示的故障后实际重连成功 | 按 verified / best-effort 显示真实恢复信息                         | 完整恢复 3 秒，尽力恢复 5 秒；未展示的短暂故障不补弹            |
| 缓存同步失败                     | 保留“内容未更新”，与同一连接故障合并说明                           | 不叠加同因横幅                                                  |
| 后台缓存写失败                   | 诊断中可查                                                         | 不主动弹出                                                      |
| 发送、停止、交互回答、附件失败   | 分别放在输入区、停止操作附近、问题卡片、附件项附近                 | 不进入会话级横幅队列                                            |

“已展示”包括工具栏、输入区或横幅实际提交渲染过的故障状态；不能只依据 Runtime
曾短暂经过某个状态。持续时间按同一故障起点计算。会话切换或重新挂载不补播
历史恢复提示；当前仍未解决的故障可在状态入口查看。

轻提示使用聊天面板内独立区域，不写时间轴、不覆盖输入框；悬停或焦点在提示内部时
暂停剩余时长，二者都结束才继续。使用事件触发的一次性 timeout；切换、恢复、
替换实例、卸载全部取消。状态入口始终可通过键盘访问诊断；自动消失不抢焦点。

横幅按认证/终止阻塞、持续连接故障、其他会话故障排序，最多一个；显示独立故障数量，
详情列出全部故障。同一故障按稳定标识、范围、关联操作合并；同文案的独立故障不得
合并。手动关闭仅影响该故障的呈现；新故障仍可显示，关闭后仍能查看和复制。

## 标准契约与数据流

建议公共 API（名称在实施时与现有导出规范统一，语义按本方案）：

- `ChatError.diagnostic?: ChatErrorDiagnostic`：纯 JSON 的可选标准字段，带运行时
  schema 和长度限制。包含具体原因码、operation、phase、本地 operation/error ID、
  outcome（`not-started` / `unknown` / `failed`）、可取得的安全原始消息、HTTP
  元数据、服务端业务码及服务端 Request ID / Trace ID。连接上下文采用标准生命周期字段。
- 不扩展现有认证用途 `SessionOperation` 的含义。诊断的 `sendText`、`interrupt`、
  `answerInteraction`、`uploadAttachment`、`loadConversation`、缓存读写等操作单独建模。
- Runtime `getDiagnostics(conversationId)` / `subscribeDiagnostics(...)` 提供只读、
  稳定快照；`ChatDiagnosticRecord` 记录本地 record ID、occurrence/scope、首次和最近
  时间、次数、活动/解决状态以及错误发生时的不可变上下文。
- `useChatDiagnostics(conversationId)` 仅订阅 Runtime；Headless 消费者使用相同读取端口。
- `ChatClientOptions.diagnostics` 可携带宿主 appVersion 与安全记录回调；门面显式
  路由到 Runtime。保留 Gateway `onDiagnostic` 和 `onLifecycleDiagnostic` 签名，
  不用 Runtime 回调覆盖宿主已提供的 Gateway 回调。
- `ChatConversationViewProps.noticeTiming` 配置 2 秒/5 秒/3 秒/5 秒默认时长；
  配置值必须有限且有合理上限。`onRequestAuthentication` 为可选宿主回调。
  Workspace 通过现有 `conversationViewProps` 透传；首次无快照视图共享呈现逻辑。

每次命令开始创建稳定本地 operation ID，返回错误与 occurrence 使用同一关联；
Socket 已有 error ID 保留。结构化更新和兼容 observer.error 双投递只记录一次，
不能把双通道重复记为两次故障。真实重复发生增加次数，独立 operation 保留独立记录。
旧 Gateway 无元数据时由 Runtime 分配本地 ID；不以文案补造关联或服务器 Trace ID。

诊断总量为每实例最近 50 条，跨会话共用该上限；建议单条最多 8 KiB、总量最多
128 KiB，按 UTF-8 序列化大小计量。超大字段先裁剪并记录 truncated 标识，超限
淘汰最旧记录；诊断淘汰不解决活动故障。按会话过滤，不把 A 的记录显示给 B。
全局故障保持全局 scope，不借当前会话冒充归属。dispose 清空记录及订阅。

首次加载失败也必须进入诊断，不能依赖 `getSnapshot() !== null`。命令在切换后
结束时按原操作会话和 generation 保留安全诊断，不改变当前会话、不播旧提示。
缓存读写通过 Runtime 内部受限诊断通道记录；附件通过现有 React uploader 端口
记录安全失败，可增加窄记录方法接收标准化的本地操作故障，禁止接收任意日志载荷。

## 采集、脱敏与错误文案

HTTP 捕获实际操作、阶段、方法、安全路由模板、耗时、有效超时阈值、响应状态、
业务码，以及响应白名单中的 Request ID / Trace ID；不复制请求头、任意响应头、
查询参数、URL 用户信息、完整响应或请求正文。浏览器未暴露响应标识头时标记未提供。
Socket 记录实际 join/recovery 阶段、代次、重连次数与完整性，不猜测 HTTP 状态。

统一安全投影供展示、复制和回调使用；Gateway 先按实际凭证值清理，Protocol/Runtime
再次执行字段白名单、字符串清理和预算限制。任意 details/raw 不进入诊断输出。
服务端错误消息可能回显聊天正文，因此不能仅靠 Token 正则：只能保留确认安全的
消息片段，已知请求内容须移除，无法确认安全的内容用说明替代。附件文件名、聊天
文本、完整 tool 数据和任意异常栈均不作为默认诊断字段。

文案按标准 operation/phase/reason/outcome 生成“失败操作、确认原因、影响”；
原始安全消息放详情。未知网络异常只陈述请求未成功与原因未提供，不推断跨域或断网。
发送已提交后超时、ACK 未知时 outcome 为 unknown，明确“结果未知，请先核对记录”，
不提供一键重发、不改变现有草稿与发送结果语义。

所有要求的诊断字段在详情和复制格式中有固定位置；缺失显示“未提供”。Kit 版本由
构建/包版本生成单一来源，宿主版本仅由宿主注入。Request ID、Trace ID 和本地 ID
分别命名。连接恢复后只改变记录解决状态，不覆盖原错误的连接代次和原因。

安全重试仅连接到现有加载/重订阅操作并使用宿主 deadline；认证入口仅调用宿主
回调，未配置时显示说明。复制失败就近提示并保留可手工选择的文本，不污染聊天记录。

## 文件与实施顺序

以下路径除 docs/tests/playground/scripts 外均相对 `packages/`。

1. **Protocol**：修改 `chat-protocol/src/models.ts`、`internal-schemas.ts`、`index.ts`；
   新增 `diagnostics.ts`（标准类型、受限安全投影与导出格式）。必要关联字段放在已有
   Gateway request options 中作为可选本地上下文，不发送成服务端协议字段。
2. **Gateway**：修改 `chat-gateway-tfrobot/src/http.ts`、`socket.ts`、`gateway.ts`、
   `attachment-uploader.ts`、`redaction.ts` 和 `types.ts`；集中采集安全元数据，保留
   现有诊断回调与连接语义，避免每个错误分支自行拼接漏字段。
3. **Runtime**：新增 `chat-runtime/src/diagnostics.ts` 有界实例记录器；修改
   `chat-client.ts`、`snapshot-state.ts`、`conversation-cache.ts`、`index.ts`，覆盖
   加载/命令/订阅/缓存失败、精确解决、不可变上下文和释放。
4. **React / 门面**：修改 `chat-react/src/hooks.ts`、`index.ts` 和必要的 uploader
   绑定；`chat-kit/src/tfrobot-client.ts` 及公共入口转发新增选项和类型。
5. **UI**：新增提示状态协调 hook、状态/诊断入口和错误详情组件；修改
   `chat-conversation-view.tsx`、`chat-workspace.tsx`、`use-chat-command-coordinator.ts`、
   `chat-composer.tsx`、`ask-user-interaction.tsx`、`chat-run-status.tsx`、`labels.ts`、
   `types.ts`、`index.ts`。复用现有 Alert、Modal、按钮和标签覆盖机制，不新增全局通知。
   `chat-state-view.tsx` 的通用用法保持兼容，聊天首次加载路径使用专门的紧凑状态区域。
6. **验证与文档**：新增定向 Protocol/Runtime/React/UI/真实传输测试，扩展版本化
   Office/Tauri 消费者；更新 `docs/host-app-integration.md`、Playground 验收说明、
   必要的本地演示故障触发与 changeset。

## 验证门禁

命中“执行路径”与“真实设施契约”两个触发器。元数据测试运行 Node 本地 HTTP server、
真实 Socket.IO server/client 与真实 fetch；不得只注入 fetch mock。

| 测试层              | 必须覆盖                                                                                                                    |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Protocol / 安全投影 | 旧错误兼容、字段校验、缺失值、凭证/正文/头/查询/原始响应泄漏、超长与大小限制                                                |
| Runtime             | 同 occurrence 双通道、同文案独立操作、先后解决、无快照失败、缓存读写失败、50 条和字节淘汰、A/B/A、两实例、延迟结果、dispose |
| React / UI          | 1999/2000ms、4999/5000ms 边界，首次 degraded，无展示不补弹，真实恢复 3/5 秒，暂停剩余时长，关闭后可查，单横幅与独立错误并存 |
| 操作入口            | 实际发送/停止/交互/上传失败就近展示，发送已接受但响应超时不出现重发，诊断复制失败，认证回调与安全重订阅                     |
| 真实 HTTP/Socket.IO | 401/403/5xx、业务失败、坏 JSON、超时、Request/Trace ID、有敏感回显、ACK 超时、重连恢复、记录保留原代次                      |
| 版本化消费者        | Office 无 Ant Design 读取诊断，Tauri 提示配置及实例释放，旧 Gateway 无新增字段继续工作，tarball 公共入口可编译运行          |

实施时先激活 Node 24；定向命令预计为：

```sh
pnpm exec vitest run tests/chat-diagnostics.test.ts tests/chat-diagnostics.integration.test.ts tests/chat-notices.test.ts
pnpm exec vitest run tests/chat-ui-antd-vertical-slice.test.ts tests/chat-conversation-cache.test.ts tests/chat-gateway-tfrobot-lifecycle.integration.test.ts
pnpm check
```

现有 UI 测试中“所有连接状态立即横幅”“切回会话恢复已关闭提示”等断言需按 #82
更新，同时保留错误隔离与命令竞态回归。新增浏览器定向验收验证键盘、焦点、布局及
复制；全量 `pnpm test:e2e` 按 user-trigger 规则处理，新增定向路径必须当次执行通过。
测试通过后按技能要求拉起 `fork_turns="none"` 只读审查代理，审查完整需求与全部 diff。

UAT/Seed：无需服务端种子或数据迁移；更新仓库 Playground 的提示/诊断验收场景。
真实外部 Front/Office/Tauri 与 RobotServer 未执行时明确未验证；仓库内版本化消费者
与真实本地设施是本次可重复验证证据。

## 风险与版本

- 最大风险是同一故障误合并、独立故障被隐藏，以及错误原始消息携带正文。实施先固化
  关联契约和安全投影测试，再接视觉层。
- 初次加载无快照、缓存显示 offline、终止恢复及切换后延迟结果是必须覆盖的入口。
- 需求标注目标 0.8.2，但当前 manifests 为 `0.8.0-dev.0`，且存在多条 Minor changeset。
  本功能有向后兼容公共 API 新增，按有效 ADR 的 SemVer 分类记录 Minor changeset；
  不自行改版本、发布或承诺 Changesets 自动得出 0.8.2，最终版本由发布流程核对。
- 无外部交付阻塞。若发现必须改变既有生命周期/权限语义，则停止该部分并单独评审 ADR，
  不能通过改状态掩盖提示。

## 评审事项

用户已确认以上分层方案、公开契约方向、默认提示时长、诊断预算与实施/测试范围。
实现、真实测试和隔离复审已完成；commit/push/PR 仍需本次任务的明确授权。

## 实施与验证记录（2026-09-11）

- Protocol 提供安全诊断类型、投影与格式化；HTTP/Socket.IO 采集白名单元数据；Runtime 保存实例级有界记录，覆盖首次失败、运行错误、兼容 Gateway、迟到命令与上传。
- React/UI 实现提示分级、单会话故障横幅、局部命令失败、诊断详情与复制、悬停/焦点暂停；Workspace 重试通过既有选择控制器。
- 兼容全局错误保持 global，不绑定当前会话；工具栏可查看当前会话及全局诊断，不显示其他会话。legacy occurrence ID 与诊断 ID 的解决映射已覆盖。
- `pnpm check` 中全量 Vitest：57 文件、1119 测试通过；最后恢复映射的定向回归：3 文件、113 测试通过。
- 真实本地 HTTP/Socket.IO 覆盖状态码、业务错误、错误响应、超时、服务端标识及回调单次性。
- 隔离复审：`/root/review_issue82_releasegate`，APPROVE，阻塞项清零。非阻塞建议：Gateway 直接回调的 HTTP 操作名仍可能为 read/send；Runtime 诊断已提供具体命令，后续可细化直接 Gateway 消费者的操作名。
- 无服务端迁移或 Seed 改动。外部 Front/Office/Tauri 部署未实测；本次验证范围是仓库内真实本地设施和版本化独立消费者。
- 保留 Minor changeset；没有改发布版本，没有 commit、push、PR 或关闭 Issue。

- 最终 `pack:check` 通过：7 个包的 tarball、类型、导入/渲染、Headless、React、Office、Tauri、Front 版本化消费者验证完成。首次完整检查仅在 Front 旧“必须含 [REDACTED]”断言失败，改为检查安全投影且保留全部凭证不泄露断言后，打包检查重跑通过。
- 最新 `typecheck`、`lint`、`format:check`、`git diff --check` 均通过。
- `TF_CHAT_PLAYGROUND_PORT=3001 pnpm test:e2e tests/e2e/session-diagnostics.spec.ts`：1/1 通过，验证真实剪贴板、键盘打开、关闭后焦点返回、面板布局；截图已人工检查。
- 完整浏览器套件按 user-trigger 规则未运行；需要全量浏览器回归时执行 `pnpm test:e2e`。
