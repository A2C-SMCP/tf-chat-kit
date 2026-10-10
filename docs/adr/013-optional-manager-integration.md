# ADR-013：可选 Manager 集成入口

- 状态：Accepted
- 日期：2026-10-10
- 决策来源：Issue #111 要求产品化公共 Manager 接入；本次开发授权覆盖该可选边界扩展。
- 补充：ADR-006、ADR-009、ADR-010、ADR-012。

## 决策

`chat-auth/manager` 提供独立 Headless ManagerClient：机器人目录分页、资格判定、
connection-info 校验、明确部署策略的目标解析与 RFC 8693 Robot SessionProvider。
认证继续由注入的 AuthClient 拥有；不重复实现登录、刷新或持久化。
ManagerClient 不创建 ChatClient，不导入其他 Kit 包、React、Ant Design 或平台 API。

`chat-kit/manager` 通过结构化 ManagerChatSource 端口接入可选集成，不静态依赖、安装或
重新导出 chat-auth。该入口拥有 ChatClient、连接和释放过程。`chat-kit/manager-react`
只绑定 React 生命周期，复用 ChatProvider；宿主在其内部使用 ChatWorkspace 或自定义 UI。
已有 headless/react/antd 入口、SessionProvider 与纯聊天消费者不改变。

该决策扩展 ADR-012 的可选服务适配范围，保留其认证与聊天实例所有权隔离。
登录、平台工具、导航、组织选择策略和隐藏窗格时的实例保留策略仍归宿主。
没有新增包、固定版本组或核心依赖方向变化。

## 契约与安全边界

employeeId、robotId、robotAccountId 不互换。目录只有 running + tfrserver 且身份完整
才标记 ready。资格是客户端提示，访问控制始终由 Manager/RobotServer 执行。
目录快照按身份取消并清空；响应校验错误不能冒充空目录。

仅接受明确列举的相对路径、旧完整 namespace 路径和新 domain-alias 完整路径。
REST 部署策略独立声明为 routed-api、direct 或显式 BFF baseUrl，不通过 Socket 后缀猜测。
宿主配置 origin 白名单或信任函数；默认没有 vendor 域名信任。BFF 必须支持换票后的
Bearer REST 凭据；Socket 使用 auth.token，浏览器不依赖自定义 WebSocket Header。
cookie-only BFF、未确认的其他部署路径需要新的契约，不能自动兼容。

Token 在每个 Provider 私有内存内按需单飞换取，提前 30 秒失效。TTL 小于 30 秒时
每次按需重新换票。Manager 身份变化、机器人释放、显式 invalidation 与 dispose
撤销缓存和在途请求；迟到结果不能交付。403 不自动换票重试；401 交回 AuthClient，
没有 refresh 契约时安全进入 auth_required。没有定时刷新、登录重放或消息重发。

## 验证与外部范围

本仓库真实 TCP HTTP/Socket.IO、React StrictMode、Chromium/WebKit 与独立 tarball
消费者形成可重复门禁。它们不代表 Production Word、生产 issuer/audience 或任意 BFF
已通过。新 domain-alias 连接信息来自本地 Manager 代码的明确 DTO/路由生成器；
生产 `/socket.io/` 观察来源为 #111。生产服务部署差异应单独验收。
