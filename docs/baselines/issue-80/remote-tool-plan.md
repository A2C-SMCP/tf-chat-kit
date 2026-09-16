# Issue #80：RemoteTool 公共封装方案（已批准）

- 来源：[GitHub #80](https://github.com/A2C-SMCP/tf-chat-kit/issues/80)
- 日期：2026-09-15
- Kit 基线：`dev-0.8.2@dd97f1c876e9b81b7cff7a51c702f0b26c4be523`
- 当前状态：通用 RemoteTool 与会话内 Ask User 已实现，测试与隔离复审通过。按用户最新授权只改 ChatKit，由宿主提供可信会话归属接入口；Server 自动路由与真实部署联调继续外部跟踪。未 commit/push。
- 本项不继承 #83 的 commit/push/关单授权。

## 初始方案与证据（历史，后文记录最新授权与实施）

### 初始范围判定：SPLIT

Kit 负责宿主无关的工具定义、注册/注销、调用校验与执行协调、结果回传、取消/超时、
断线重新注册、诊断和释放。宿主提供业务函数、参数校验、权限策略、SessionProvider
及可选交互 UI。外部仓库只读，不修改 Server 或 Front。

不新增包，不改变依赖方向。Protocol 表达通用工具契约，Runtime 管理执行生命周期，
Gateway 适配 TFRobot Socket.IO，React/UI 提供可选交互，chat-kit 只组合公共入口。
新增能力默认关闭，复用现有 ChatClient 的聊天会话模型；仅在可靠会话路由就绪时启用对应 answerInteraction 能力。

## 已核实证据

- Front 基线 `ce663ae15d1a724377010f1ef0a45b7a36095292`：
  `MainLayout.tsx` 挂载 RemoteToolProvider；RemoteToolClient 在连接时 register，
  stop 时 revoke 并移除监听，Ask User 弹窗属于布局层而非当前聊天会话。
- Front Ask User 转换使用固定 `conversationId: "remote-tool"`，默认等待 1800 秒；
  这不是可信会话路由，不作为 Kit 的兼容承诺。
- Server 本地基线 `6acf3100`；已核对 `origin/develop@236d7c1b` 的 namespace 和协议
  文档与该基线无差异。register/revoke 有明确 ACK，providerId 为连接 SID，
  不同 Provider 的同名工具注册被拒绝。
- Server RemoteToolRequest 只有 requestId/providerId/toolName/params，没有可信
  conversationId、调用者身份、绝对截止时间或远端取消事件。
- Server namespace 转发调用固定等待 120 秒，worker RemoteTool 默认同为 120 秒。
  当前共享同步 worker Socket.IO Client 不支持并行 RemoteTool 调用；客户端增加
  并发机制不能修复 worker 侧的线程安全问题。
- Server 当前为同 Robot 所有者的可信连接模型，不提供互不信任第三方的事件权限隔离。
- TFRS-231 当前待办，是 TFRS-227 下的纯测试回归任务，不是已交付路由契约。
- Kit 已有 Ask User 问题/答案 schema、校验、Runtime 会话交互命令、UI 表单和历史
  映射，但无 RemoteTool Provider 实现。既有 AskUserInteractionCard 及回调包含
  conversationId，直接复用会话内交互；不引入独立弹窗或伪造当前会话。

## 用户已确认的首期范围

1. Ask User 必须在对应聊天会话内展示和回答。切换到 B 会话不能把 A 的提问搬到 B；
   返回 A 后仍可在剩余期限内回答。回答只能结束原调用。
2. 兼容当前 Server：多个 Provider 注册同名工具时明确报告冲突，不承诺同名多窗口。
3. 从本地收到调用起约 110 秒超时并回传失败，预留当前 Server 120 秒等待中的回传
   时间；切换会话不重置计时。不能保证网络延迟下的严格端到端截止时间。

## 上游依赖：可信会话上下文（阻塞会话内 Ask User）

请求方：tf-chat-kit #80。优先级：P0 阻塞该功能交付，不代表生产事故。

期望能力：机器人在哪个会话中提出问题，客户端就能可靠地把问题放回那个会话，并把
答案交回原调用。归属来自服务端真实执行上下文，不由模型参数或用户当前打开的会话决定。

已有 TFRS-227 Epic 和正在进行的 [TFRS-229](https://turingfocus.atlassian.net/browse/TFRS-229)
涵盖调用协议。后者虽写有“conversation 仅作为 invoke 的业务上下文”，但协议示例和
当前 DTO 均未携带归属。优先复用该项提交契约缺口请求，由 Server 负责人确认是否在
该项补齐；不将现有任务描述视为已交付能力。TFRS-231 只负责末端测试。

建议方案（非约束）：从真实执行上下文取得会话归属，经过 worker、namespace 传到
Provider；字段名、可信边界、版本兼容与错误格式由 Server 确认。会话不进入工具身份。

交付要求：

- 请求/响应 schema、完整报文、归属来源、鉴权与当前可信连接边界说明。
- 缺失或无效归属的错误约定及旧客户端兼容规则；普通无会话工具仍可使用。
- A/B 会话隔离、切换期间答复、迟到答复不影响后续调用的服务端测试证据。
- 明确保持现有同名冲突策略和 120 秒等待，记录共享 worker transport 并发限制。

在契约确认并可验证前，Kit 不猜测 wire 字段，不把 params.conversationId 当可信信息，
不启用 TFRobot 实时 Ask User，也不能将 #80 宣称完成。通用执行框架可独立先行。
外部源码保持只读。已提交到 TFRS-229 评论 16422，等待 Server 负责人确认。

## 已批准实施顺序与文件清单

以下新文件名为拟定落点；实现时沿用现有导出与测试组织方式，不新增 package。

| 层级 / 文件                                                                                                                | 改动与公共接口方向                                                                                     |
| -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `packages/chat-protocol/src/remote-tool.ts`（新增）、`src/index.ts`                                                        | 通用工具定义、参数校验/handler、调用上下文、结果、状态及 transport 端口；不暴露 Socket DTO             |
| `packages/chat-protocol/src/gateway.ts`                                                                                    | 为 RemoteTool 增加必要的 SessionProvider 操作用途，认证所有权仍归宿主                                  |
| `packages/chat-runtime/src/remote-tool-client.ts`（新增）、`src/index.ts`                                                  | 实例私有注册表与执行协调器；start/dispose、状态订阅、单次执行/结果、容量限制、110 秒截止与 AbortSignal |
| `packages/chat-gateway-tfrobot/src/remote-tool.ts`（新增）、`src/index.ts`                                                 | 私有 /remote-tool 连接；注册 ACK 名称核对、注销、认证恢复、重连重注册、边界校验和错误脱敏              |
| `packages/chat-runtime/src/ask-user-tool.ts`（新增）、`src/chat-client.ts`                                                 | 内置工具复用同一执行器，接入既有会话交互状态和 answerInteraction；依赖上游可信归属契约                 |
| `packages/chat-gateway-tfrobot/src/remote-tool.ts`                                                                         | 上游确认后增加归属映射和能力启用；缺少有效归属时明确拒绝 Ask User                                      |
| `packages/chat-react/src/hooks.ts`、`src/index.ts`                                                                         | 必要的可选状态订阅，沿用现有会话 UI 绑定；无独立弹窗                                                   |
| `packages/chat-ui-antd/src/ask-user-interaction.tsx`                                                                       | 复用已有卡片，仅补齐本次超时/取消/失效状态所需展示，UI 不直接连接 Socket                               |
| `packages/chat-kit/src/tfrobot-client.ts`、`src/headless.ts`                                                               | 从公开叶子 API 组合可选 RemoteTool；未启用的消费者保持兼容                                             |
| `packages/chat-testing/src/remote-tool.ts`（新增）、`src/index.ts`                                                         | 内存端口与可控调用辅助，复用生产标准契约                                                               |
| `tests/remote-tool-runtime.test.ts`、`tests/remote-tool.integration.test.ts`、`tests/remote-tool-ask-user.test.ts`（新增） | 执行竞态、真实 Socket.IO 闭环、会话内回答与切换隔离                                                    |
| `scripts/verify-packed-artifacts.mjs`及现有消费者夹具                                                                      | 增加非 Front Headless 消费者验证，使用打包产物公开入口                                                 |
| `docs/` 使用文档、当前计划、`.changeset/`                                                                                  | 宿主工具示例、兼容矩阵、上游限制和 Minor 变更说明                                                      |

公共 API 最小形态：宿主提供 definition、validate、handler；执行器提供启动、释放和
状态订阅；handler 获得 AbortSignal，返回统一结果。具体类型命名在实施中按现有规范确定。
注册确认前不 ready；断线使当前调用失效，重连只恢复注册，不自动重放业务执行。
重复调用不能重复执行或重复提交结果；迟到结果丢弃。取消为协作取消，不能撤销既有副作用。
凭证只经 SessionProvider 进入 Gateway，不进入日志、状态快照或持久化。

## 验证与交付门禁

本项同时命中“启用执行路径”和“触及真实设施契约”两个触发器。

- Runtime 确定性测试：注册状态、多实例、重复调用、异常、110 秒超时、协作取消、
  迟到结果、断线/dispose、容量边界。虚拟时钟只用于本地计时语义。
- 真实本地 Socket.IO，经公开入口跑 register → invoke → 宿主 handler → ACK；
  验证冲突、错误 ACK、认证失效、断线恢复、注销和连接释放。测试服务器依据已核对协议，
  此证据不冒充真实部署 Server 的验证。
- 会话 Ask User：A 提问后切到 B 不串会话，返回 A 可回答；后台超时不重置期限，
  重复点击、旧请求回答和 dispose 后回答均不影响新调用。
- 上游交付后使用真实 Server 运行会话归属→显示→回答闭环，记录版本及结果；
  只有测试服务器或伪造归属不满足这一项完成条件。
- 非 Front 消费者从 tarball 运行通用工具闭环，Headless 不依赖 React/DOM/Ant Design。
- 拟运行：`pnpm exec vitest run tests/remote-tool-runtime.test.ts tests/remote-tool.integration.test.ts tests/remote-tool-ask-user.test.ts`，随后 `pnpm check`；使用项目要求的 Node 24。
- 完成后执行 add-feature 要求的全量隔离只读审查，阻塞项清零再交付。
- 评估 TFRS-231 的会话隔离回归场景，不以其待办状态证明已验证；无需新增数据种子。
- 当前通用执行器与 Gateway 已开始实现；测试结果另记。没有 Server 交付证据前 #80 保持未完成。

## 通用部分验证记录（2026-09-15）

- `pnpm exec vitest run --reporter=verbose`：61 文件、1185 用例通过。
- 最后一次复用既有认证映射后，`pnpm exec vitest run tests/remote-tool.integration.test.ts tests/chat-gateway-tfrobot.test.ts tests/chat-connection-reuse.integration.test.ts`：3 文件、174 用例通过。
- `check:workspace`、`check:changesets`、`check:boundaries`、`lint`、`format:check`、`typecheck`、`build:playground` 均通过；最终认证映射调整后再次 typecheck 通过。
- `pnpm pack:check`：7 包制品扫描、publint、类型解析和独立消费者全部通过；新增 Headless tarball 消费者使用真实本地 Socket.IO 完成注册/调用/回答，Office/Tauri/Front 既有消费者通过。
- 首轮打包扫描拒绝重复的认证字段构造，已改为复用现有 `authOf` 映射，保持扫描规则不变；上述最终打包检查通过。
- 全量 `pnpm check` 最初在格式检查停止；格式修正后全量测试独立运行，其他组成门禁逐项运行。上述记录是实际执行结果，不声称某一次完整 `pnpm check` 命令退出成功。
- 当前通用部分进入隔离只读审查。Ask User 内置工具、会话接线与真实 Server 会话联调尚未实现/验证，#80 保持 OPEN/in-progress；没有 commit/push/发布。

实施落点说明：通用 Provider 通过独立 `createTFRobotRemoteToolClient` 公开入口显式持有和释放，尚不改动聊天客户端的会话能力。React/UI 改动依赖会话 Ask User，因此留在后续契约接入阶段。Runtime 取消信号复用已有 `UploadCancellationSignal` 结构，计时经 transport.clock 注入，保持无 DOM/Node 全局依赖。无需数据迁移或新种子；TFRS-231 的会话隔离 UAT/集成覆盖仍需上游交付后评估和执行。

### 隔离审查 B1 与修复

第一轮独立只读审查提出一个阻塞项：临时 `connect_error` 被作为终止错误处理，停止了 Socket.IO 自动重连。真实本地服务停机→至少一次连接失败→同端口恢复的新增回归先失败，状态停在 `error/transport`，确认问题成立。

修复将暂时网络错误与认证/注册/namespace 拒绝分开。Gateway 复用统一连接失效处理，保留原有 Socket.IO 恢复所有权；公开窄 Socket 端口新增可选只读 `active` 标识，由默认适配器提供。恢复后重新注册，新调用成功，旧调用不重放。

修复后 `remote-tool-runtime`、`remote-tool.integration`、`chat-gateway-tfrobot`、`chat-connection-reuse.integration` 四个测试文件共 185 用例通过。先前全量 1185 用例记录对应修复前快照，新增服务恢复回归包含在这次 185 用例中，未宣称重新运行了全量 1186 用例。B1 修复后的打包检查通过；第二轮隔离复审确认 B1 已修复，并提出下述 B2。

### 隔离审查 B2 与修复

第二轮复审发现自动重连的 namespace 握手缺少本地 deadline。新增真实 Socket.IO 回归：首次正常注册后重建同端口服务，第二次 namespace 授权中间件不回 CONNECT。修复前超过配置预算仍为 `disconnected`，用例 RED，确认问题成立。

每次认证回调现在启动连接代次保护的 deadline，覆盖认证材料读取及 namespace 握手；注册、断线、错误和 dispose 清理旧计时。修复后观察到 `timeout`，释放后再完成旧授权不会复活实例。最后四个相关测试文件共 186 用例通过，包含 24 项 RemoteTool 定向用例；typecheck、lint 已再次通过。B2 后最终 typecheck、lint、format:check、check:boundaries 和 pack:check 均通过；第三轮隔离只读审查 APPROVE（仅当前通用部分），没有剩余代码阻塞项。

## 通用部分完成时的交付状态（历史）

- 独立审查 `/root/review_issue80_gate` 已完整复审当前 20 个文件，确认 B1/B2 修复，当前通用部分 APPROVE；未将其视为 #80 整体完成。
- 最终验证：相关 4 文件 186 用例（含新增 RemoteTool 24 用例）、类型、Lint、格式、依赖方向、7 包制品扫描/类型解析与所有打包消费者通过。最终打包日志为 `/tmp/tfck-80-pack-b2.log`；早期全量回归日志为 `/tmp/tfck-80-tests.log`。
- 后续仅剩已保留的功能依赖：Server 可信会话上下文契约、内置 Ask User、对应会话 Runtime/React/UI 接线及真实 Server 会话闭环验收。2026-09-15 回读 TFRS-229，尚无对本次契约请求的回复。
- GitHub #80 保持 OPEN/in-progress；工作区代码与文档待续接，未 commit、push 或发布。外部 Server/Front 源码未改动。

## 用户要求的再次自测（2026-09-15）

- 在 B1/B2 修复及第三轮审查后的当前代码上，使用 Node 24.20.0 完整运行一次 `pnpm check`，退出码 0。61 个测试文件、1187 个用例全部通过，随后 Playground 构建、7 包制品检查及独立宿主消费者验证通过。日志：`/tmp/tfck-80-self-check.log`。
- 额外从已构建的公开 Headless 入口连接真实本地 Socket.IO 服务，不覆盖默认超时时长、不使用虚拟时钟。挂起的宿主调用在 110004 ms 收到 `success: false / error: timeout / done: true`，取消信号已触发；让旧 handler 迟到返回后，新请求仍成功返回 `recovered`。脚本：`/tmp/tfck-80-wall-clock.mjs`；结果：`/tmp/tfck-80-wall-clock.log`。
- 本轮未发现新缺陷，未修改生产代码。上述网络测试使用本地协议测试服务，不代表真实 TFRobotServer 联调；对应会话内 Ask User 仍等待上游契约，#80 尚未全部完成。未 commit 或 push。

## 用户确认的 Ask User 实施调整（2026-09-15）

用户要求“askuser 也需要实现……在会话里以卡片形式呈现”，并明确选择“只改 ChatKit，保留会话归属接入口”。因此不再把 Server 契约交付作为 Kit 内置工具、卡片和回答代码的实现前提；仍不伪造服务端会话归属，也不修改外部仓库。

范围为 IN：复用 Protocol AskUser 模型与校验，Runtime 提供内置工具及按会话保存的临时状态，React 提供宿主拥有的控制器接入和订阅，UI 复用已有卡片与结果视图。宿主提供可信 requestId→conversationId 解析器并持有、释放工具控制器及 RemoteToolClient。无依赖方向、认证所有权变更，无新增包或 ADR 替代。

实施接口为 `createAskUserRemoteTool({ resolveConversationId })`：将 `.tool` 与宿主工具一起注册，把同一控制器通过 `ChatProvider askUser` 传入会话视图；Headless 通过 `getSnapshot/subscribe/answer` 消费。问题采用 Front 发布的 questions/question/header/multiSelect/options 形状。未确认归属返回 `conversation-unavailable`，不读取模型 params 的 conversationId 或当前选中会话。110 秒预算包括异步路由解析，切换会话不重置。最多保留 100 张临时卡片，先移除已结束记录；不写入持久缓存，不声称页面重载后仍可回答。

验证：新增 Runtime 的多会话、错误答案、超时、取消、断线、释放、缺失/迟到路由和多实例用例；真实本地 Socket.IO → 内置工具 → React 会话卡片 → 切换会话/选择答案 → ACK 集成；补充 Headless 打包消费者，执行质量检查和隔离只读审查。测试中的归属由受控宿主映射提供，不代表现有 Server 已自动交付会话信息。

### Ask User 实施与验证结果

- 已实现 `createAskUserRemoteTool` / `AskUserRemoteTool`，复用原有 Protocol 请求/答案校验与 UI 卡片；React 通过 `ChatProvider askUser` / `useAskUserRemoteTool` 接入。控制器与 Provider 由宿主持有和释放。
- 同一控制器按真实宿主映射保存 A/B 请求及未提交草稿。选择、文本及多选答案可验证后回传；取消、超时、断线和释放使旧回答失效并显示结束状态。未知归属明确返回 `conversation-unavailable`。没有新增服务端字段或修改 Server/Front。
- 4 个 RemoteTool 定向文件共 31 用例通过，含真实 Socket.IO → 会话卡片选择/切换/取消 → ACK。`pnpm check` 完整退出 0，63 个测试文件、1194 用例通过，治理、Changesets、依赖边界、Lint、格式、类型、Playground 构建及 7 包制品检查通过；日志 `/tmp/tfck-80-ask-check.log`。Headless tarball 消费者同时注册宿主工具与内置 Ask User，完成无 React 的提问回答闭环，Office/Tauri/Front 消费者保持通过。
- 首轮隔离审查指出多题/历史卡片会挤出 Composer。真实 Chromium 在 600px 宿主中复现：20 题时输入框 y=2388，高度 54，超出可用区域。修复给会话卡片集合增加 40% 高度上限、可收缩布局和垂直滚动；浏览器验证输入框 y=534、高度 54，滚动到全部问题及提交按钮并成功回答。25 条已完成记录后再新增 20 题仍保持同样输入框位置，并再次提交成功。临时验证脚本 `/tmp/tfck-80-layout-probe.mjs`、`/tmp/tfck-80-layout-entry.tsx`，RED/GREEN 日志 `/tmp/tfck-80-layout-red.log`、`/tmp/tfck-80-layout-green.log`。
- 布局修复发生在全量测试执行期间，因此另行在最终布局上运行 Ask User UI 网络集成和既有 UI vertical slice，2 文件 26 用例通过；格式、Lint、diff 检查再次通过，后续打包构建包含最终布局。全量测试结果不替代这一修复后定向验证。
- #80 已同步用户确认的“仅改 ChatKit、保留会话归属接入口”范围，保持 OPEN/in-progress；未 commit/push。Server 自动会话路由与真实部署联调仍由上游契约请求跟踪，不将受控宿主映射测试描述成已完成 Server 集成。

### 最终隔离复审

`/root/review_issue80_askuser_final` 以隔离上下文审查全部 30 个变更文件，结论 APPROVE，无剩余代码阻塞项。确认卡片高度/滚动修复、原网络恢复与握手截止时间修复，以及 Ask User 的归属、草稿、回答、状态和公开接入符合本轮范围。文档建议已落实：顶部改为最新状态，旧“当前交付状态”明确标为历史记录。
