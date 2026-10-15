# #141：Server 消息身份与发送生命周期实施计划

状态：用户于 2026-10-15 批准；正在实施可独立验证的 SDK 部分。
日期：2026-10-15。
基线：`origin/main@5b162fec84660a04e60769d3ffec896b1a044874`（core `0.10.0-next.2`）。
工作区：`tf-chat-kit-141`，分支 `feat/141-element-id`。

## 需求与范围

来源：[GitHub #141](https://github.com/A2C-SMCP/tf-chat-kit/issues/141)。
目标：用户在 Word/Web/Tauri 中发送一次消息后，POST 回执、实时用户消息、历史和缓存
使用 Server 分配的同一个 elementId 关联；连续相同正文仍是两次独立发送。作者展示以
历史为准。旧 Server 继续使用 #136 的 current-server 兼容行为。

范围结论：**IN**；标准消息身份、发送状态、历史/实时归并属于 Kit。
涉及 Protocol、Gateway、Runtime、React/UI、Testing 与打包消费者，无新增包或依赖方向。
Server 生成/保护标识、定义接收与终态契约；宿主提供登录/连接配置、实例生命周期和真实
Word 验收。本轮只修改 tf-chat-kit，不修改 Server、Front、Office 或部署配置。

复用 #141 作为一个可独立交付的 SDK Feature；其上游协调已经存在于 TFRS-599 和子任务中，
不重复创建 Epic 或上游实现任务。#141 已标记 in-progress。

## 已核对事实

- `message-identity.ts` 当前按数据库 msgId 别名及有界 DTO 特征关联；已排除昵称/头像，
  仍保留 UID、内容、时间戳及业务扩展。Issue 关于“昵称仍参与签名”的描述已过时。
- `dto.ts` 是宽松对象 schema，但没有 elementId 的语义声明。未知字段可能进入 raw/签名，
  不等于已支持稳定身份。不得从 raw 或 additionalKwargs 内部键取正式身份。
- `gateway.ts` 的 sendText/sendMessage 只返回 runId。clientMessageId 当前传到 msgId，
  不能把它改称服务端 elementId，也不能声称它提供服务端幂等。
- Protocol 的 Message.id 是显示/更新时间线的键；MessageProvenance.persisted.id 当前
  表示数据库事实。拥有 elementId 不证明持久化，不可将其塞入 persisted.id 偷换语义。
- Runtime 已有按数据库事实对齐显示 ID、历史作者优先、发送在途保护、缓存合并；可增强复用。
- #136 的未关联项仍在 headless timeline 中，默认 UI 按 reviewRequired 分区；这不是发送 outbox。
- `Message.createdAt` 当前要求 Server 时间；缓存只保存显示投影，不保留 raw 或认证材料。

## 上游状态与待确认契约

读取时间：2026-10-15。TFRS-599/600/601/602 当前 Jira 状态均为待办。
TFRS-600 的较新评论记录重投保护的部分实现，PG 集成测试仍待执行；这不是合并、发布或部署证明。
目标 TFRS v0.5.0 尚未 released，版本描述为 DPE 文档与 SDK；该消息身份任务是配套可靠性工作，
不直接实现北极星六项重点，也不扩展为域名迁移、DPE 或存储改造。

已明确的契约：POST 入口覆盖分配 UUID；POST、用户实时消息、历史带同一 elementId；
助手实时消息可为 null；请求体传入 elementId 不可信。TFRS-602 承担三路一致/防伪造集成回归。

### 请求 A：POST 转正所需的权威消息元数据

请求方：tf-chat-kit #141；上游：TFRS-600/601，由 TFRS-599 协调；优先级 P1（阻塞完整转正验收）。

用户需要 POST 已确认接收时显示该条正式消息，实时回执缺失或迟到也不能依靠猜正文找回。
现有计划的 elementId/taskId 足以确认身份，但缺少构造标准 Message 所需的 Server 时间。
建议响应返回 Server 构造的 acceptedMessage（正式用户 DTO，含 createTimestamp），或确认
等价的权威时间字段及与后续 DTO 的关系；具体 wire 形态由 Server 维护者确认。

交付：脱敏请求/响应示例、字段可空性、HTTP/业务错误语义、时间定义、OpenAPI/兼容说明。
不要求扩大现有权限；SDK 不生成或信任客户端指定的 elementId。

未确认前：SDK 可显示“已接收、待同步”的发送记录，但不能伪造 Server createdAt，
也不把这条降级行为称为已经满足“POST 后进入正式时间线”。

### 请求 B：不会写入历史的消息如何收尾

请求方：tf-chat-kit #141；上游：TFRS-599 协调现有子任务归属；优先级 P1（阻塞终态验收）。

用户需要知道某条补充消息被撤回、繁忙拒绝或意外中断，而不是永远处于发送中。
请确认正式终态信号能关联 elementId 或已证实的一一对应命令标识，带稳定机器原因码，
并说明重复/乱序、重连缺失与可否恢复。建议使用现有 Socket/错误通道扩展，Server 自定 wire 契约。
当前读取的旧本地 Server 快照中，chat_error 仅关联 conversation，繁忙是普通助手文本；
不能据此判断最新远端已经或尚未实现终态信号，须上游提供实际交付证据。

没有关联证据时 SDK 显示“结果未确认”，不按中文提示、当前唯一在途项或历史缺失
推断某条发送失败/撤回；不自动重发，不新增轮询。Server 未提供可靠重放时不承诺断线无损收尾。

请求 A/B 只在本文形成待协调请求，尚未发送评论或修改上游 Jira。

## 方案决策（已批准）

1. 新增可选标准字段 `Message.serverMessageId`，Gateway 将 elementId 映射到它；
   `SendTextSuccess`/`SendMessageSuccess` 增加同义可选身份字段。采用 opaque string，
   具体 wire 值校验由 Gateway 负责。现有自定义 Gateway 可继续不提供。
2. 识别键按实例/会话隔离，以 serverMessageId 优先，msgId 已知事实为兼容别名。
   有 elementId 的用户消息绝不走正文、作者、时间戳匹配；没有该字段时走旧 #136 分支。
   同数据库 ID 的旧缓存可以关联新身份；只有内容相同的旧临时项不可凭空绑定或删除。
3. 保留 Message.id 的显示键职责，不静默改成 elementId；也不改变 persisted.id 的数据库含义。
   身份、Server 已接收、数据库持久化、Gateway 恢复证明是四个独立事实。
4. Runtime 提供可选 outgoingMessages 快照，按本地发送 operation ID 管理 sending、
   accepted、failed、unknown；已有 Message 的后续业务终态由规范化关联更新表达。
   pending 放在正式 timeline 之外，UI 读取公共快照，不自己持有另一套发送状态机。
5. POST 身份确认后立即转为 accepted；有权威完整 DTO/时间后进入 timeline 并消解 outbox。
   实时先到、POST 先到、历史先到均按身份收敛为一条；任何通道都不能覆盖较新的历史作者。
   发送超时是 unknown，不是确定失败；不自动重复提交。Server 不保证客户端幂等。
6. 撤回/繁忙只根据已确认的关联信号转终态。终态 wire 字段和优先级须先完成请求 B；
   accepted 不代表推理完成、成功回复或已持久化。
7. 缓存保存经校验的可选身份字段，不保存或重放 outbox/在途请求；恢复时降为显示数据。
   保持版本 1 可选字段向后读兼容，新增记录不能授权发送或提升 recovery.complete。
8. 助手 null-ID 的流式路径不套用户身份规则。保持 verified/current-server 保证边界，
   Server 缺少 durable replay 时仍 complete=false。

本方案增加正式身份及发送状态公共语义，配套 ADR-016 已经用户批准为 Accepted；不修改既有 ADR。
公共 API 采用 serverMessageId 和 outgoingMessages，沿用既有 snapshot hooks。

## 分层文件与实施顺序

| 顺序 | 文件/现有模块                                                                                                     | 变更                                                                                  |
| ---- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| 1    | `chat-protocol/src/models.ts`、`gateway.ts`、`internal-schemas.ts`、公共导出                                      | 可选服务端身份、发送快照/结果与规范化关联更新；兼容旧 Gateway                         |
| 2    | `chat-gateway-tfrobot/src/dto.ts`、`mapper.ts`、`message-identity.ts`、`gateway.ts`、`socket.ts`                  | DTO 校验、正式字段映射、三路身份关联；无字段分支保留旧逻辑；接入已确认的回执/终态契约 |
| 3    | `chat-runtime/src/chat-client.ts`、`snapshot-state.ts`、`timeline.ts`、`cache-record.ts`、`conversation-cache.ts` | 发送状态、竞态合并、缓存字段与旧别名兼容；取消/切换/dispose 安全                      |
| 4    | `chat-react` 现有 snapshot hooks；`chat-ui-antd/src/chat-conversation-view.tsx`、命令协调与 labels                | 公共发送状态展示、错误/未确认/终态；保持现有 draft 与发送入口                         |
| 5    | `chat-testing` 的 memory-gateway、fixtures、Gateway/Runtime contracts                                             | 新旧契约双路径，失败/乱序与身份隔离夹具                                               |
| 6    | 现有身份/缓存/Runtime 测试、manager consumer、真实本地 HTTP/Socket 测试设施                                       | 端到端从公开发送入口驱动合并/收尾；无 source alias                                    |
| 7    | ADR、接入与兼容文档、Changeset                                                                                    | 核心包按实际公共变更计算版本；不指定未经计算的发布版本，不改 auth 版本                |

优先复用现有状态与测试设施；不另建通用消息总线、数据库或独立 outbox 包。
原工作区有其他未跟踪产物，全部保留；实施在本独立 worktree 内完成。

## 验证计划与门禁

命中真实 REST/Socket DTO、跨 ID 映射及发送路径触发器。内存单测之外，新增定向场景
必须实际运行本地 HTTP/Socket.IO；服务承载 wire 契约，不能 mock 掉被改的 Gateway 网络层。
这些可重复测试证明 SDK 契约适配，不代替 TFRS-602 的实际 Server/PG 正确性证明。

- 实时→历史、历史→迟到实时、POST 与实时互换顺序、并发发送、重连、跨实例磁盘缓存。
- 相同 elementId + 不同 UID/昵称/内容更新仍一条；不同 elementId + 相同正文仍两条；
  业务扩展变化不改变身份；无效/空标识与同 msgId 冲突的身份不得静默合并。
- 发送未返回时在 outbox；收到身份后 accepted；完整权威消息到达后一次转正；
  超时 unknown，迟到结果只影响对应身份和会话；切换/注销/dispose 不复活旧发送。
- 繁忙/撤回关联精确，重复终态幂等，错误会话/缺少关联信号不能误结束其它发送；
  异常与历史乱序策略按上游契约明确后加入。
- 旧 Server 无 elementId、助手 null-ID、#136 的作者/临时项保护与旧缓存全部回归。
- 独立打包消费者仅从公共入口安装，Chromium/WebKit 从发送到回复、切换、恢复及终态展示。

审批时的验证命令（实际结果见后续实施验证记录）：

```sh
pnpm exec vitest run tests/chat-gateway-tfrobot-message-identity.test.ts tests/chat-gateway-tfrobot-message-identity.integration.test.ts tests/chat-conversation-cache.test.ts tests/chat-conversation-cache.integration.test.ts
CHANGESET_BASE_REF=origin/main pnpm check
pnpm test:manager-browser
```

如新增定向用例位于其它现有测试文件，实施记录补齐精确命令。Node 24 与 pnpm 10 按仓库约束执行。

完成实现后使用 fork_turns=none 的只读 reviewer，提供完整需求、批准方案、全部 diff/文件及
真实验证证据；阻塞项验真修复后重新隔离复审。默认 review=block。

## 交付与剩余项

风险：中高，涉及公共身份、缓存兼容及发送竞态；已有分层不变，无新增权限、轮询或基础设施。
建议先实现已明确身份契约与 outbox 的可独立验证部分，上游请求 A/B 到位后完成正式转正与终态。
本单包含真实 Word 验收要求，不因本地 SDK 测试通过而关闭 #141，也不转移该要求规避完成条件。

真实 Word UAT 使用同时具备 Server 契约和精确 SDK 版本的目标环境，验证发送、回复、
切换回读、重连、同正文与终态。仅新建并精确清理本轮测试会话，无需修改业务种子数据；
若用户已有 Xray/宿主测试集，新增身份/发送生命周期用例，跨仓测试定义修改另行确认。

用户已批准上述身份/持久化分离与 outbox 方案及 ADR-016 方向，当前实施 SDK 可独立验证部分；
Server 回执元数据与终态契约未确认的部分保持明确未完成。
提交/推送/PR/发布另按用户后续授权执行。

## 实施落点与验证续接

- 复用现有 React snapshot hooks、Memory Gateway 结果 schema 和缓存事件，无需修改其公共方法。
- 新增内部 ChatOutgoingMessages 纯展示组件，欢迎页与正式会话共用，保证首次 POST 等待期间可见。
- 两个 Server profile 都接入正式身份；verified 的无标识路径仍不启用旧启发式。
- 首轮隔离审查 B1（多别名桥接作者回退）与 B2（冲突磁盘记录击穿加载）均已通过新增回归验真并修复，等待新隔离终审。
- 完整初轮质量门通过：88 文件/1554 项测试、打包与独立消费者；修复后定向 86 项与 17 项真实身份链路通过。
- 修复首次发送入口后独立 tarball Chromium/WebKit 32/32 通过；后续增加继续发送及网络 unknown 展示断言，随最终验证执行。
- 最终完整质量门、隔离终审及其精确结果由实施验证记录收敛；没有真实 Server/PG/Word 验收，不关闭 #141。

## Server 联调分支的新证据（2026-10-15）

Issue 新评论称 TFRS-600/601/602 已合并，并提供 `integration/chatkit-element-id`。
本轮只读核实远端与检出代码为 `d2b484b18ec93b04d15ea4d6713ce11399762f3a`；
这补充了此前 Jira「待办」快照，不再用旧 Jira 状态判断实现是否存在。
`chats.py` 入口覆盖并生成 `uuid.uuid4().hex`，POST 回执 DTO 包含 taskId、
conversationTitle、elementId，但无权威消息时间/完整 DTO；用户消息 DTO 带可空 elementId。
`ChatErrorDto` 与 `_emit_chat_error` 仍为会话级关联，未见 elementId 终态字段。
因此正式身份可用的代码证据已具备；本轮尚未启动其 PG/Redis/RabbitMQ/Celery 设施或部署此分支，
也未完成真实 Word UAT。上游请求 A/B 与本次已批准的 SDK 子集边界保持有效。

## 后续审查回归

- 第二轮识别完整显示别名冲突及合法缓存/网络交叉冲突。新增四例先失败，
  然后验证缓存拒绝/网络优先、`invalid-record`、后续发送与实时更新；5 文件 158 项通过。
- 第三轮识别 HTTP 拒绝/成功回执解析失败分类与实时别名桥接作者回退。
  六个新增场景先失败；修复后 5 文件 81 项通过，含真实 TCP POST 的 400/408/429
  与两种 HTTP 200 无效数据，不 mock HTTP。历史作者同时在 Gateway 与 Runtime 全部匹配项中保护。
- 最近完整质量门已通过 88 文件 / 1563 项及打包验证；上述后续修复后完整门重新执行，
  新隔离全量 diff 审查、最终浏览器重跑结果由实施验证记录收敛。

- 第四轮审查识别批量 `createTimelineState` 与单条 upsert 在同一合法多别名输入上
  作者保护不一致。公开 load 与 snapshot.replace 两例先失败，统一遍历全部 matches 后
  4 文件 75 项通过，类型与 lint 通过；等待最终隔离审查及完整门收敛。

- 第五轮审查识别显示 ID 碰撞且一侧无 Server 身份时，缓存可能把旧身份继承给另一数据库事实。
  三个新回归先失败，扩大正式身份分支的数据库冲突检查后，5 文件 79 项通过，类型与 lint 通过。
  同时保留两侧均无 Server 身份时的旧兼容规则；等待新隔离终审。

## 用户后续指示

用户要求「先不用打包，是否开发完成了」。SDK 批准子集代码已完成；不再执行新打包。
该指示到达前最后一轮 Chromium/WebKit 32/32 已通过（43.7 秒）；终审仍在进行，
Server 精确终态、POST 完整元数据和真实 Word 验收未完成，不关闭整单。

最终隔离审查 `/root/review_141_acceptance` 已完成全 29 文件审查，结论 APPROVE，
无新增阻塞或非阻塞项。最后产品修复后的定向 79 项、类型、lint 与最终浏览器 32 项通过；
此前完整 1569 项及打包检查通过，最后两类修复未重新跑包含打包的完整 check，按用户指示停止新打包。
SDK 独立子集完成，完整 #141 仍受上述 Server 契约与真实 UAT 条件约束。

## test 集群真实 Server 验证续接

用户新增授权后，已在真实 test `0.4.3-dev3` 上完成 POST/实时/历史三路身份、
相同正文两条、真实回复、跨会话回读与昵称变化不重复的验证；Worker 三次任务均成功。
[真实联调记录](../baselines/issue-141-live-test-2026-10-15.md)明确受测源码、运行镜像、
测试会话、消息 ID、时间与未覆盖项。没有新打包、发布或变更部署。
Server 核心身份链路已可用；POST 完整元数据、精确业务终态与真实 Word 验收仍待完成。

用户已追加授权：发布新的 next 版本用于 Word 宿主测试，并回复 #141，按剩余验收条件判断是否关单。
按现有 Changesets pre 模式生成核心 `0.10.0-next.3`，auth 独立保持 `0.12.0-next.1`，
执行功能 PR → 独立版本 PR → main 受保护 OIDC 发布；完整终态及 Word 验收尚未完成，不提前关单。
