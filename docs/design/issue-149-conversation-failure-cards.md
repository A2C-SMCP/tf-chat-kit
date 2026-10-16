# #149：实时与历史业务失败卡片实施计划

- 工作项：https://github.com/A2C-SMCP/tf-chat-kit/issues/149
- 状态：本地实现、最终质量链及隔离审查通过；用户已授权发布 next.5，正在提交与发布。
- 基线：main/develop `799925e2ad3e81d61c251dd679e8130fbf4a545e`。
- 分支：`feat/conversation-failure-cards`。
- 发布：2026-10-16 用户明确要求 next.5 包含本次全部改动，授权必要的提交、PR、合并及受保护 OIDC 预发布；正式版发布仍停止。

## 需求与成功结果

用户在 TFFront 能看到 Token 超限等错误的“本轮生成失败”卡片、原消息和服务端说明，而 Word 中的 chat-kit 主要显示 failed 事件行和待处理问题数量。希望 Kit 在实时接收和历史回看时都能清晰表达失败原因，并允许安全地回填原文。

默认卡片显示标题、时间、脱敏后的用户可见错误说明；仅有权威原消息文本时显示“出错消息”和回填按钮。长内容可展开，卡片留在会话记录中。回填只更新并聚焦输入框，不发送请求；已有草稿需要确认覆盖。

## 范围门与追踪

结论：IN。稳定的业务失败语义、Gateway 适配、实例状态、默认渲染和测试属于 Kit。Word/TFFront 的登录、页面、Store、平台 API 不进入 Kit；外部仓库只读参照。

本项是可独立交付的中型功能，以一个 GitHub Issue 追踪。#82 的安全提示/诊断、#141 的消息身份及 outgoing 语义、#129 的默认 Manager UI 是关联项，不合并或重新打开已有项。#149 已添加 enhancement、in-progress，表示需求/方案工作已开始，用户已确认按本文范围编码。

## 已核实事实

1. `chat-gateway-tfrobot/src/socket.ts` 监听 `chat_error`，调用 domain `error.reported`，未产生业务失败时间线项。
2. `chat-protocol/src/diagnostics.ts` 的 `safeDiagnosticError` 有意移除任意 message；`compact-labels.ts` 继续概括为通用失败文案。诊断不泄露聊天正文的既有安全要求必须保留。
3. Kit 的 `historyDtoSchema`、`mapSnapshot` 和 current-server 回补只映射 messages/events，没有消费 errors。
4. TFFront 的 `ChatErrorComponent`、`reconcile-history` 已消费实时错误及历史 errors[]，恢复历史原消息，并通过宿主专用事件回填输入框。
5. 已读 Server 的 `ChatErrorDto` 声明 error 是用户可见说明，运行时错误允许无 code；`MessagesDto.errors` 含记录 id、code、error、createTimestamp 和原始 message。
6. Server 的实时推送与持久化分别生成时间戳，实时 DTO 不含共同错误 ID。因此正文/时间接近/最近一次发送不能证明同一错误或消息身份。

## 复用与技术裁决

| 候选                                         | 裁决与理由                                                                         |
| -------------------------------------------- | ---------------------------------------------------------------------------------- |
| 直接显示所有 ChatError.message               | 拒绝。会混入网络响应、内部异常或敏感正文，破坏 #82 的诊断安全边界。                |
| 复制 TFFront 组件、Store、window CustomEvent | 拒绝。保留用户体验，复用 Kit 的实例、草稿与 renderer 扩展点。                      |
| 新增 TimelineItem 顶层判别类型或新包         | 当前不需要。复用 AgentEvent/transition 和按 eventType 选择 renderer 的既有能力。   |
| 为业务失败单独保留有界、安全的展示数据       | 采纳。与技术诊断分开，用户可见正文不是任意 raw/details。                           |
| 根据正文或最近消息推断关联                   | 拒绝。历史原消息以 Server errors[].message 为准，实时缺证据时不显示关联引用/回填。 |
| 通过定时读历史等待错误落库                   | 拒绝。只接入现有加载、分页、订阅和重连事件驱动链路，不新增轮询。                   |

新增向后兼容的可选模型/renderer 能力按 Minor 评审，不改变依赖方向、认证所有权或既有字段语义；当前无需新 ADR。不得把 errorId 当作 msgId、runId 或持久化证明。

## 标准模型与分层设计

### Protocol

拟新增只读 `ConversationFailure` 展示数据，内容限于：脱敏用户说明、可选业务码、可选 Server 错误标识/持久记录事实、可选已确认原消息引用与文本、观察/历史来源。

在既有通用 AgentEvent transition 上添加可选失败展示字段，使用标准 eventType `conversation.failure` 和 failed 事件状态。此状态描述该条失败记录，不自动修改当前 Run。

在既有 error occurrence/update 上增加可选时间线关联信息，保留旧错误回调与诊断协议。默认 UI 只在对应业务卡片确实可见时排除同一故障的重复顶部提示/计数。没有新字段的自定义 Gateway 维持原行为。

### Gateway

REST 增加可选 errors[] schema（缺省兼容空），分别校验记录、会话、业务 code 和原消息，复用原有消息标准化及凭据清理能力。首屏、分页、current-server 重连回补共用同一失败映射，并纳入有界条目计数。

Socket `chat_error` 生成标准失败事件及关联的兼容错误 occurrence。业务码只来自明确 code，不解析错误文案。对未知 code 使用默认标题。原消息缺失时不猜关联。

### Runtime / 缓存

复用时间线归并、通知队列、generation 和实例释放保护。历史记录按 Server 记录 ID 独立保留；相同正文但不同 ID 是两条。实时观察使用明确的实例/订阅本地身份，不冒充服务端 ID。

**旧协议限制需用户接受**：实时与历史没有共同 ID 时，不强制将两者合并；可能同时保留标识来源的实时观察和历史记录。即使正文、时间相近，也不删除已观察到的独立错误。完整无歧义合并待 Server 共享错误 ID 契约后另行接入。

缓存仅保留有界脱敏的展示投影，不保存原始错误载荷、凭据、附件对象或待重放动作；恢复不赋予发送权或可靠恢复保证。

保持现有 Run/能力权威来源：迟到的会话级错误、历史错误不能结束新 run；也不能把某条 outgoing 从 accepted/unknown 擅自改为 failed。

### React / UI

新增专用失败卡片 renderer，复用 registry、错误边界、主题、时间格式与中英文 labels。已知业务码映射标题；未知/缺省/null code 显示“本轮生成失败”。正文以纯文本显示，脱敏并限制大小，长内容允许展开。

组合层通过当前会话的受控回调调用既有 `useComposerDraft` / `client.setComposerDraft`，并聚焦对应 ChatComposer。先保存草稿 revision；确认覆盖期间切换会话、身份或草稿已变化时不覆盖新草稿。覆盖检查包括普通文本、长粘贴块、引用与附件。

只有权威且适合回填的原文本才提供操作；非文本原消息、无原文或编辑器不可用时不提供误导按钮。不自动发送，不恢复附件，不开全局消息总线。

## 文件与实施顺序

| 顺序 | 文件/目录                                                                                                                                                                                     | 改动                                                                           |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| 1    | packages/chat-protocol/src/models.ts、internal-schemas.ts、index.ts                                                                                                                           | 可选规范化失败数据、schema、公共导出与 occurrence 关联。                       |
| 2    | packages/chat-gateway-tfrobot/src/dto.ts、mapper.ts、gateway.ts、socket.ts                                                                                                                    | 实时与历史统一映射、边界校验、旧协议兼容、有界回补。                           |
| 3    | packages/chat-runtime/src/timeline.ts、snapshot-state.ts、chat-client.ts、cache-record.ts                                                                                                     | 根据实际需要接入失败字段、错误关联、安全缓存与既有生命周期；不新建聊天状态机。 |
| 4    | packages/chat-ui-antd/src/conversation-failure-card.tsx（新）、renderer-registry.tsx、chat-notices.tsx、chat-conversation-view.tsx、chat-composer.tsx、labels.ts、compact-labels.ts、types.ts | 卡片、国际化、重复提示消除、草稿确认与聚焦。                                   |
| 5    | packages/chat-react/src、packages/chat-kit/src                                                                                                                                                | 仅在确有新增公共导出/组合端口需要时调整，不复制 Runtime 实现。                 |
| 6    | packages/chat-testing/src、tests、tests/e2e/fixtures/manager-ui.ts、docs、.changeset                                                                                                          | 内存夹具、真实传输贯穿测试、打包消费者、兼容文档及变更记录。                   |

具体新增文件实现前再次检查等价实现；只修改确有需要的现有文件。新代码/测试文件形成可审查内容后按精确路径暂存；已有文件、文档、无关文件不擅自暂存。此阶段只生成本计划文档。

## Server 请求草案（不代替上游决策）

- 请求方：tf-chat-kit #149；优先级：P1 精确性补强，不阻塞当前协议下的错误展示。
- 用户价值：同一次失败在实时和历史中只出现一次，并能准确指出失败的原消息。
- 期望契约：同一次失败在实时和历史提供共同、稳定、会话隔离的错误标识；若有原消息/任务关联，明确其字段、身份语义和权限。持久记录标识与“已落库”保证需分别说明。
- 非约束建议：复用一次生成的错误 ID 和发生时间，历史保留原用户消息；具体字段、落库/推送顺序和失败降级由 Server 负责人确认。
- 交付要求：版本化 DTO/样例、鉴权与会话授权不变、未知/可选字段兼容、重复/乱序/落库失败行为和真实传输测试。
- 本次不修改 Server、部署或现有 #141 完成条件，也不根据假想的新字段编造已支持的契约。

## 验证与质量门禁

触发器①②均命中：启用业务失败的用户可见链路，且修改 REST/Socket DTO 映射。须实际运行真实本地 TCP HTTP + Socket.IO，禁止只手工给 UI 塞标准事件后宣称协议通过。

1. Protocol/Memory：旧模型兼容；已知/未知/空 code；不同记录同文案；非法身份；失败 payload 大小/脱敏；多实例和 dispose。
2. 真实本地传输：真实 GET messages errors[] 与 Socket chat_error 驱动正式 Gateway → Runtime → UI；覆盖 Token 超限正文、仅历史错误、errors 缺省、翻页、重连、原消息缺失/非文本、重复历史 ID、不同 ID 同正文、迟到错误和错误会话。
3. UI/浏览器：窄窗格可读、正文展开、键盘操作；仅回填不发送；已有草稿确认/取消、确认期间切会话和草稿变化；重复顶部提示消除；网络/认证/未知发送结果保持原行为。
4. 缓存/打包：安全展示投影、旧缓存兼容、无重放、离线无额外权限；从 tarball 安装的 Office/Manager 近似消费者验证，保留 Headless 无 React/DOM 边界。
5. 定向新增测试拟为 tests/chat-conversation-failure.test.ts、tests/chat-conversation-failure.integration.test.ts；复用 tests/chat-diagnostics.integration.test.ts 的真实 HTTP/Socket 模式和现有 Manager 浏览器设施。
6. 命令：定向 `pnpm exec vitest run <本次相关测试>`；整体 `pnpm check`；定向浏览器/独立 tarball 消费者。执行包产物任务时避免并发清理共享 .artifacts。真实 Word/test 集群验收作为独立观察，未执行不得写成通过。
7. 按 add-feature Phase 5.5 组织完整需求/范围/基线/文件/测试输入包，启动 fork_turns=none 只读 reviewer，加载 code-review rubric；阻塞项清零后才交付。

现有浏览器受控测试夹具需要增加一个失败场景，属于本仓测试数据；不涉及生产 Seed 或其他项目 UAT 定义写入。

## 审批与交付边界

用户已批准的实施范围：仅 Kit 的现协议兼容与测试，接受上文无共同错误 ID 的明确限制；Server 只形成请求草案。若要求实时/历史无歧义合并作为本次交付硬标准，应先补齐上游契约，再修订依赖与验收。

批准实施不等于批准提交、推送、PR 或发布。正式发布保持取消；已有不可变 tag 与部分发布不在本功能中改动，后续版本需另行规划。

## 本地实施记录（2026-10-16）

公共 API 增量为 `ConversationFailure`、`AgentEventTransition.failure`、`ChatErrorOccurrence.timelineItemId` / `error.reported.timelineItemId`，以及 `getConversationFailure`。Protocol 和 Kit headless 门面导出辅助读取能力；无顶层时间线新类型，无新包。UI 增加可选失败文案与业务码标题格式化字段，默认 renderer 支持 `agent-event:conversation.failure`，宿主覆盖方式沿用既有注册表。

Gateway 首屏、分页消费可选 `errors[]`；current-server 有界 REST 回补按既有事件 transition 身份计入 checkpoint 和条目上限。实时错误生成订阅内观察身份及相应 domain occurrence；不猜原消息，不推断当前 Run 或 outgoing 的终态。历史按记录 ID 保持独立事实。已知码和未知/缺省/null 码均有覆盖，特殊未知值 `__proto__` / `constructor` 安全回退。

缓存持久化及读取时都投影为展示数据：保留错误说明、来源、可选业务码及历史记录 ID，清除 `originalMessage`。缓存合并后即使已经联网，也不会把磁盘原文重新赋予回填能力；实际重新读取 Server 记录后可恢复操作。缓存事件状态保持 unknown、只读恢复不授予命令权。错误说明与业务码限制最终脱敏后的长度；原文过大或脱敏后膨胀则不提供回填，不截取部分原文冒充完整输入。

回填走现有实例草稿 API，校验当前客户端/会话范围、草稿对象修订、事件对象、生命周期和发送 capability。已有文字、长粘贴/引用、附件均确认覆盖；取消或过期确认不会写草稿。待处理附件期间回填按钮禁用并说明原因，上传完成后需按已有附件草稿确认替换。无自动发送，未调用发送 POST，不重放附件。

第一轮隔离审查 B1（缓存原文操作权限）通过新增失败复现验真并修复；同时覆盖 W1（上传中的附件）及 W2（脱敏膨胀）。原始复现日志 `/tmp/tfck-149-cache-repro.log`，修复后首次定向 23 项通过日志 `/tmp/tfck-149-final-targeted.log`。按 add-feature 调用 fix-review 处理本功能范围内的修正，第二轮隔离审查与完整质量门禁另行记录结果。

定向真实本地 TCP HTTP/Socket.IO → Gateway → Runtime → 默认 UI 已运行通过，覆盖首屏/分页、current-server 重连补回、跨实例/会话、原文/覆盖/不发送与安全诊断。独立 tarball 安装的 HTTPS Manager 消费者（无工作区别名/Playground代理）在 Chromium、WebKit 共 36 项通过，包含本功能以及原有身份/403/401/组织隔离回归，320/380/480/760 窗格无横向溢出，截图已视觉核验。命令 `TF_CHAT_MANAGER_HOST_PORT=3014 node scripts/verify-manager-browser.mjs`，日志 `/tmp/tfck-149-browser2.log`；先由 `pnpm pack:workspace` 生成本地验证产物，未发布。

Server 只读参照基线 `TFRobotServer@02a4a85c`，TFFront `3696064c`。没有修改外部仓库、生产 Seed 或其他项目 UAT 定义。以上浏览器使用受控服务夹具，不能替代实际 test 集群/Word 宿主验收。本次无新迁移开关，旧 DTO 缺少 errors 字段兼容；旧协议实时/历史精确关联限制保持原裁决。

后续复审发现实时观察 ID 可在新 Gateway 中复用，已通过实际双 Gateway、磁盘往返与历史合并复现后修正：每个 Gateway 生成随机观察命名空间，叠加订阅及观察序号，不使用模块全局计数。另补旧 Server 同名事件但无标准 failure 时沿用原 generic/tool renderer 的兼容回退。

待处理附件已有移除入口，进行中的请求会取消；即使上传端忽略取消并迟到返回成功，也不能再附加到回填后的草稿。失败上传可以放弃后继续回填。最新两个功能测试文件共 27 项，加既有 Gateway 148 项，共 175 项定向通过；日志 `/tmp/tfck-149-final-targeted.log`。第三轮隔离审查使用环境中更新后的 code-review 0.17.2 rubric（原 0.17.0 插件缓存已被环境替换），结果待门禁完成后补记。

本功能涉及真实协议契约，因此新增定向 TCP/Socket.IO 验证及打包浏览器消费者均为交付前置，已实际运行；完整 Playground Playwright 套件与真实 test 集群/Word 实机 UAT 未执行。后续可运行 `pnpm test:e2e` 并由宿主集成方实际复验，本次不把受控测试等同于真实环境验收。

第四轮严格隔离只读审查结论 APPROVE，阻塞项为 0。历史缓存授权、观察身份、上传移除/迟到结果与 checkpoint 同页错误问题均经独立核对。非阻塞建议保留：为同会话 ID 的 ChatClient/身份替换及卸载后的旧确认补直接测试；固定浏览器夹具 `saved-token-error` 的发生时间以供未来重连测试复用。按默认 block 门控不追加测试夹具或生命周期范围扩张，本次仍由生产守卫及既有 Manager 身份隔离回归覆盖。

原 `pnpm check` 曾遇工作区治理用例的默认单用例 5 秒超时。最终等价质量链保留所有断言及构建/包检查，只在调用全量 Vitest 时设置 `--testTimeout=30000`，未修改仓库默认时限。最终日志 `/tmp/tfck-149-quality-final.log`；最终产物消费者日志 `/tmp/tfck-149-browser-final.log`。

最终验证全部通过：工作区/Changesets/依赖边界、lint、格式、类型检查、全量 Vitest 90 文件 1605 项、Playground 构建及 packed artifact 校验。后者实际安装、构建和运行全部 8 个包，并覆盖无 UI 的 headless、认证生命周期及真实 HTTP/Socket.IO 消费者。上述质量链与最终打包浏览器验证顺序执行，进程退出码为 0。

最终两个新增功能测试文件共 29 项（单元 17、真实 TCP 集成 12），联合既有 Gateway 148 和 notices 11，定向共 188 项通过。最终 tarball Manager 消费者在 Chromium/WebKit 共 36 项通过，覆盖 320/380/480/760 窗格，已视觉核验最终 Chromium 760 与 WebKit 320 截图。真实 Word/test 集群 UAT 及完整 Playground E2E 未执行。当前 Server 足以支持本功能；实时/历史缺少共同错误 ID，仍按来源分别展示，不猜测合并。

冻结并验证的代码/测试 diff 指纹（`git diff HEAD -- packages scripts tests | shasum -a 256`）：`980518d253c9bc9faeea2ea2866fc998266a51e3b0b92a6d5f7ac304cb765012`。最终 `git diff --check` 通过，HEAD 保持 `799925e2ad3e81d61c251dd679e8130fbf4a545e`。仅本功能 3 个新增代码/测试文件按隔离审查要求精确暂存；没有暂存已有修改、提交、推送、创建 PR、关闭 #149 或发布。
