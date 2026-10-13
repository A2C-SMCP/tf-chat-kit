# Manager 公共集成（Issue #111）

可选入口：`@turingfocus/chat-kit/auth/manager`、`@turingfocus/chat-kit/manager`、
`@turingfocus/chat-kit/manager-react`。它们复用现有 AuthClient 与 ChatWorkspace。
宿主仍可以直接注入 SessionProvider，不初始化 Manager 集成。

```ts
import { createManagerClient } from "@turingfocus/chat-kit/auth/manager";
import { createManagerChatController } from "@turingfocus/chat-kit/manager";

// auth 为已创建的 AuthClient。部署配置由宿主维护，不向用户询问 Token 或路径。
const manager = createManagerClient({
  auth,
  baseUrl: deployment.managerOrigin,
  fetch: globalThis.fetch,
  routing: {
    allowedOrigins: deployment.trustedOrigins,
    http: { kind: "routed-server" },
  },
});
const first = await manager.loadPage(1, 20);
if (first.hasMore) await manager.loadPage(2, 20);
const owned = createManagerChatController({
  manager,
  chat: {
    messageCreatorProvider: () => ({
      uid: auth.getSnapshot().account!.userId,
      name: "User",
    }),
    // Only select this profile for an explicitly compatible current Server.
    serverProfile: { kind: "current-server" },
    // 显式匹配部署的 Server REST 契约（旧版保持默认 query-v1）。
    conversationContract: "json-v2",
  },
});
await owned.select(first.items.find((robot) => robot.eligibility === "ready"));
// json-v2 先返回 platform-selection-required；宿主展示 platforms，
// 再以用户选择的真实 ID 调用 owned.select(robot, { platformId })。
// 只有 ready 快照才提供 client；不自动创建或选择平台。
const chat = owned.getSnapshot().client;
// Render with ChatProvider + ChatWorkspace, or use ChatClient commands headlessly.
await owned.dispose();
await manager.dispose();
```

`loadPage` 返回 items、page、pageSize、total、hasMore；目录快照合并不同页并按 employeeId
去重。`refresh()` 清空累积页并重新加载首页；`cancel()` 中止当前 Manager 请求；请求均可提供
AbortSignal/deadlineAt。单次默认 10 秒、有界到 60 秒；不自动重试分页、换票或聊天发送。
Playground 使用相同 API，在宿主包装层以 100 页限制完整目录展示。

资格原因包括 missing_employee_id、missing_robot_id、missing_robot_account_id、not_running、
unsupported_template、ready。目录 key、employeeId、robotId、robotAccountId 为不同语义。
连接信息中的 rid 必须匹配所选 robotId；目录有 namespace 时也必须匹配。

## 部署与鉴权矩阵

| 连接契约              | Socket transport path                                    | 应用 namespace | HTTP 策略               |
| --------------------- | -------------------------------------------------------- | -------------- | ----------------------- |
| 旧相对格式            | `/socket.io/` 严格解析后加 `/c/{type}/{namespace}/{rid}` | `/chat`        | 独立配置                |
| 旧完整格式            | `/c/{type}/{namespace}/{rid}/socket.io/` 原样保留        | `/chat`        | 独立配置                |
| domain-alias 完整格式 | `/c/{type}/{rid}/socket.io/` 原样保留                    | `/chat`        | 独立配置                |
| 本地直连              | 显式 `socket: "direct"` 与相对 `/socket.io/`             | `/chat`        | `http: {kind:"direct"}` |

`http: {kind:"routed-server"}` 是浏览器直连 Server 策略：按明确的路径格式生成
`/c/{type}/{namespace}/{rid}` 或 `/c/{type}/{rid}`，随后追加 `/v1/chat/...`。
入口必须按该路径将 REST 和无凭据 OPTIONS 转给同一 Server，由 Server 处理 CORS、
Bearer 与 scope。它不依赖 Cookie、宿主代理或浏览器不能在预检中发送的路由头。

兼容保留的 `http: {kind:"routed-api"}` 按对应已知路由契约生成 `/c/.../api`，Gateway 后续追加
`/v1/chat/...`。`direct` 使用 origin；`bff` 使用宿主显式 baseUrl，例如 `https://host/api`。
这三项属于部署配置，不能由 Socket transport path 自动决定。所有目标 origin（含 BFF）
必须在 allowedOrigins 内或通过宿主 isTrustedOrigin 策略。URL 凭据、查询、片段、穿越、
未知路径、其他机器人类型与不一致 routingHeaders 均拒绝。

Manager 请求用用户 Bearer；换票 body 使用 RFC 8693 subject_token、
`audience=robot:{robotAccountId}`、`scope=chat:read chat:send`、`token_profile=session`。
公共 Gateway 向 Robot REST/BFF 发送换票后的 Bearer，Socket.IO 通过 auth.token 接收同一短期票据。
浏览器不使用自定义 WebSocket Header。cookie-only BFF 没有受支持契约，需要另行评审。
ManagerClient 的 HTTP 禁用重定向和隐式 cookie。Gateway 的 BFF 安全策略仍由宿主部署保障。

## 生命周期与 React

AuthClient 环境/用户/账户/组织的身份变化会取消请求、清空目录并撤销全部 Robot Provider。
机器人切换会取消旧连接并释放旧 ChatClient，因此历史、草稿和内存缓存不跨实例复用。
默认缓存为实例内存；若宿主配置持久化缓存，仍需按 ADR-011 自行隔离 scope。
ManagerChatController 不拥有 AuthClient 或 ManagerClient，宿主最后分别释放它们。

`useManagerChat(controller)` 订阅宿主持有的实例，适合隐藏窗格仍保留聊天的策略。
`ManagerChatProvider` 使用稳定 create factory 在 React effect 内创建编排实例，卸载时释放；
提供 `robot`、children 和可选 fallback(snapshot)。其中可直接挂载 ChatWorkspace。
没有选择为 idle、正在连接为 connecting、失败为 error；目录空、未开户、身份不可用和资格
原因由 AuthSnapshot/ManagerDirectorySnapshot 展示。默认不新增产品选择 UI。

注销后凭据立刻撤销；Playground 的测试会话精确清理属于 best-effort，注销后不能继续持有
旧票据用于 DELETE。生产会话不因视图关闭自动删除。

## 诊断与验证

`getDiagnostics()` 保留最近 50 条安全 operation/code/status/path 与已验证 UUID requestId，成功恢复不清除故障证据。
`onDiagnostic` 接收相同白名单；不携带异常 cause、原始响应、Header、Token、Cookie 或正文。
401 交回 AuthClient；403 权限拒绝不触发重新登录；402/404/409/429 分别分类。
未知网络错误不被解释为 CORS，未知契约返回 unsupported_contract。
`chat-kit/manager` 的 `managerDiagnosticToChatError` 可将这些记录接入已有
`ChatClient.recordDiagnostic` 与 `formatChatDiagnostic`；不需另造聊天诊断格式。
AuthClient 的可选 `onDispose` 专用生命周期事件让 Manager 即时撤销资源，同时保留已有
AuthSnapshot 订阅者在 dispose 时静默的行为。目录取消不会改变 identityRevision 或释放聊天。

版本化支持证据：Manager 本地代码 `connection_info_dto.go`、`connection_info_service.go` 的
namespace 元数据/domain-alias 路径，#111 提供的 Production 相对路径观察；聊天协议仍采用
现有 TFRobotServer Gateway 基线。`current-server` 重连为 degraded/best-effort，不保证可靠重放。

本次门禁覆盖真实本地 HTTP/Socket、React StrictMode 与 tarball Web/Office 风格消费者，
Chromium/WebKit 使用浏览器原生 fetch 完成目录、两种路径、BFF/直连、换票和释放。
Production Word 真正会话/回复、生产 issuer/audience、cookie BFF、Manager refresh 与可靠重放
没有由这些 fixture 证明。Manager 公共入口已发布于 chat-auth 0.10.0 / chat-kit 0.9.0；
本次新增的 routed-server 尚未发布，不能让旧包消费者提前使用。宿主无需 UAT Seed 变更，本地设施不写生产数据。

## Issue #116：Word 直连验收边界

Playground Manager 模式现在直接使用公共 `routed-server`，不经过 `/__tfrobot_proxy`。
旧管理员调试模式的代理不作为 Manager/Office 验收证据。

| 场景                                        | 证据与限制                                                                                                   |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| 已发布 0.9.0/0.10.0 + 旧正式入口 routed-api | 2026-10-12 Word 失败；无凭据 OPTIONS 307 登录跳转，缺少 CORS 头                                              |
| 旧正式 API host + X-TF 路由头               | 无凭据预检 400 missing routing context；不适合浏览器接入                                                     |
| Server 0.3.7 自身                           | 端口转发直达真实 Server，来自 https://localhost:3002 的 POST/authorization,content-type 预检 200，返回允许头 |
| 新 routed-server + 配套入口修复             | 需独立 HTTPS packed 消费者、入口部署、正式 REST/Socket/回复与真实 Word 分别验收                              |

不能通过 `no-cors`、客户端写 Cookie、自动猜测 API 域名或复制 Playground 代理解决入口问题。
入口未升级时，新策略不能让现有部署自动可用。部署及真实 Word 未通过前，#111/#113/#116 保持未完成。

## 0.10.0 单包接入与 test 验收

认证入口随 chat-kit 一起安装，auth 叶子仍独立发布。React 的 ManagerChatProvider 支持
受控 platformId；JSON 会话的平台查询、空列表、403、失效 ID 与切换释放遵循
[ADR-014](adr/014-auth-facade-and-server-contract.md)。

测试登录入口为 https://user.test.turingfocus.cn；本次确认的 Manager API 为
https://rest.test.turingfocus.cn。实际机器人来源必须根据账户的 connection-info 配置允许列表。
登录 Portal Cookie 不能直接作为 Word 的认证方案；宿主需显式调用 auth 或注入 SessionProvider。
本次浏览器测试的认证恢复与真实 Word 登录验收分别记录，见
[验收记录](baselines/word-010-test-2026-10-13.md)。
