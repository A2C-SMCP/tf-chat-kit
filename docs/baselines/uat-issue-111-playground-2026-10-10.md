# Issue 111：Playground 宿主 UAT — 2026-10-10

## 环境与证据边界

- 用户要求本地 Playground 模拟宿主接入走查，并明确选择正式 Manager。
- 最新工作区候选源码，分支 `feat/111-manager-integration`，基线 `origin/main` 的 `317dcf1466f2cf2c5032aa363ef3f4da92178c09`；代码尚未提交或发布。
- 可见 Chromium，`http://localhost:4311` → 正式 Manager `https://api.turingfocus.cn` → 正式 RobotServer/Front BFF `https://enaic.turingfocus.cn`。账号由用户在浏览器直接登录；没有把凭据写进报告或工具参数。
- 走查时间：2026-10-10 19:36–20:00（北京时间）。前段包含本地故障注入；真实正式服务验证在用户登录后开始，修正后由用户再次登录。
- 仅创建测试会话 **34、35**；只向 34 发送三条带 `[UAT-111-20261010-A/B/C]` 标记的算术消息，要求不调用工具、不修改外部数据。既有会话只读。

## 发现并修正的问题

| 问题                             | 修正前证据                                                                                                                                                                                     | 根因与本地修正                                                                                                 | 复验证据                                                                                                                |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| JWT 换票响应被拒绝，阻塞真实聊天 | 正式 login、目录、connection-info 与 oauth/token 均 200；换票返回 `token_type=Bearer`、`issued_token_type=urn:ietf:params:oauth:token-type:jwt`、`expires_in=43200`，SDK 报 `invalid_response` | SDK 新解析器只接受 access_token，漏掉 Manager 实际签发的 JWT；改为 jwt/access_token 明确白名单，未知类型仍拒绝 | 真实 HTTP 复现先 FAIL 后 PASS；正式服务重新登录后成功加载会话、建立聊天和发送回复；packed 与浏览器设施改为完整 JWT 响应 |
| 目录服务失败被当成空目录         | 本地注入 503 后下拉框 0 项、Alert 0，只有返回/退出按钮                                                                                                                                         | Playground 吞掉 loadRobots 的异常；增加安全 code/status 提示与手动重试，保留过时请求隔离                       | 新浏览器回归先 FAIL 后 PASS；503→手动重试→真实本地 Socket 聊天成功，不泄漏服务端正文                                    |
| 机器人资格提示不准确             | 本地 stopped 机器人有完整 robotAccountId，仍提示“缺少 robotAccountId”                                                                                                                          | 宿主把全部 canAutoConnect=false 统一写成缺字段；改为复用公共 eligibility 原因                                  | stopped 与不支持模板两个浏览器回归先 FAIL 后 PASS                                                                       |

JWT 响应类型依据 Manager `oauth_token_service.go` 的 `IssuedTokenTypeJWT` 与 [RFC 8693 的 token 类型定义](https://www.rfc-editor.org/rfc/rfc8693.html#section-3)。本次未更改服务端或放宽安全扫描、Origin 与身份隔离规则。

## 正式服务实际走查

| 检查                               | 实际结果                                                                                                                |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| 正式 Manager 用户登录、组织与目录  | HTTP 200；当前真实账号只有一个组织与一个“通用”机器人                                                                    |
| 旧相对 Socket 路径、安全解析与换票 | connection-info 返回 `/socket.io/`；公共适配完成解析；Bearer JWT 换票 200、会话档有效期 43200 秒                        |
| 自动进入聊天                       | 会话列表、status、messages 200；状态已连接、Alert 0                                                                     |
| 新建独立测试会话                   | 34、35 均 HTTP 200 / 业务码 200，保留 `[tf-chat-kit playground]` 时间标题                                               |
| 首次真实发送与回复                 | 34 的 A 输入 POST 200；无需刷新收到 `7×8 = 56` 和 `UAT-111-A`                                                           |
| 手动重连与再次发送                 | status/messages 200；B 输入 POST 200，收到 `72 UAT-111-B`                                                               |
| 单次真实 401 与重新换票            | 仅一次 status GET 的 Bearer 改为合成无效值；真实 Server 401 → Manager exchange 200 → status 200；临时 route 已移除      |
| 401 后最终恢复状态与继续聊天       | REST、Socket 与 Workspace 异步恢复完成后 Alert 0、已连接、输入可用；C 输入 POST 200，收到 `90 UAT-111-C`                |
| 新会话隔离                         | 切到 35 时为“暂无消息”，没有 34 的输入或回复                                                                            |
| 历史切回与唯一性                   | 切回 34，REST messages 中 A/B/C 的 user fact 数各 1，assistant fact 共 3；两条既有回复可见，无重复输入                  |
| 精确 ID 自动清理                   | 在仍登录时返回 Playground，DELETE 34/35 各 HTTP 200 / 业务码 200，返回 ID 与目标相同                                    |
| 完整分页确认清理                   | 重新进入 Manager：第一页 13 条且有 cursor，第二页 0 条且无 cursor；34、35 均不存在                                      |
| 注销与凭据撤销                     | 退出后显示登录入口，消息输入和重连控件均为 0；检查 URL、Cookie、local/session storage 与 DOM 未发现 JWT/Bearer 凭据特征 |

未向已有业务会话发送或删除数据。截图仅为本轮测试聊天区域：本地 `.playwright-mcp/uat-111-real-chat.png`，未纳入发布包。

## 保留的观察与未覆盖项

- **上游历史事件状态限制**：真实回复完成后，status 返回 `working=false`，而 messages.events 中仍存在 `running` 记录（最终读取 12 条），重连会呈现历史事件的 running 状态。SDK 未自行把这些上游事件改成 success。这是当前 Server 事件恢复契约的观察，不能以聊天成功承诺完整事件终态重放；需独立服务端核查。
- **真实回复耗时**：B 从输入到 assistant 最终回复约 67 秒，超过本轮探针的 60 秒窗口，随后正常到达。保留为正式服务性能观察，未做性能归因或 SLA 判定。
- 第一次回复探针错误地选择 literal `article`；实际聊天条目是语义 role=article，故发生等待超时，真实回复早已到达。后续改为语义角色并核对 REST facts。注销探针最初等待“用户登录”，而宿主退出后回到 Mock 登录入口；改用登录标题及聊天控件缺失验证。两项均为测试探针问题，未作为产品失败。
- 401 恢复期间短暂显示错误 Alert。第一次 status 200 早于消息加载、Socket 握手及 Workspace ready；等待最终恢复后 Alert 消失，无持续残留故障。
- 当前正式账号只有一个组织/机器人，因此**没有真实多组织、多机器人切换证据**。本地宿主补充 A→B→A→B 走查最终一个活动 Socket，返回首页后为零；公共消费者另覆盖账号切换和旧凭据撤销。
- 没有验证生产新 domain-alias 路径、自然 12 小时到期、Manager refresh、cookie BFF、服务停启、完整断线重放或 Production Word。浏览器/packed fixture 证据分别列明，不替代正式宿主验收。
- 本轮没有建立 Xray Execution、更新远端 Issue、提交、推送、PR 或 npm 发布。

## 最终质量验证

- 修正后 `CHANGESET_BASE_REF=origin/main pnpm check` 完整通过：**83 文件 / 1473 项测试**，包含 workspace、Changeset、依赖边界、lint、格式、类型、Playground 构建和 packed 制品门禁。
- Playground 浏览器回归：**14 PASS**，包含三条新增异常恢复/资格提示用例。
- 公共 Manager 完整 JWT 响应链：Chromium **1 PASS**；匹配 Playwright 1.62.1 的 Linux WebKit **1 PASS**。本机 macOS WebKit 启动限制沿用开发验证记录；临时 Linux 容器已停止。
- 真实 HTTP 与消费者聚焦回归：**32 PASS**；未知 issued_token_type 仍拒绝。
- 再次隔离只读代码审查：**APPROVE，阻塞项与建议项均为 0**。

结论：本次 UAT 发现的三处 SDK/宿主问题均已本地修正；列明的正式服务聊天接入流程通过。保留上游事件终态与回复耗时观察，继续区分开发验证、真实 Playground 接入和 Production Word 验收。
