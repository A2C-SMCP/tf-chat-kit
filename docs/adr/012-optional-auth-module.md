# ADR-012：可选认证模块与 Headless 认证契约

- 状态：Accepted（Issue #91）
- 日期：2026-09-18
- 补充：ADR-006、ADR-009 与 ADR-010；不改变现有 Chat Kit 认证关闭路径

## 背景

ADR-006 将登录、账号切换和长期凭证存储留给宿主。Web、Tauri、Office 和受控第三方宿主仍
需要不同的账号体系，但重复实现登录、恢复和会话过期处理会产生不一致的安全边界。因此增加
一个可选认证公共模块，同时不能让聊天 Runtime、Gateway 或默认 UI 接管宿主的身份所有权。

## 决策

新增独立的 `@turingfocus/chat-auth` workspace 包，提供四个入口：`/headless`（无 React、DOM、
Ant Design 或宿主 API 的状态机、端口和模型）、`/tfrobot`（TFRobot HTTP 契约适配）、`/react`
（无样式 Provider 与 hooks）和 `/antd`（可选默认登录、账户选择、组织切换与会话过期 UI）。
Headless 是默认入口；React 与 Ant Design 只作为可选 peer dependency。Chat Kit 不依赖、自动
安装或自动初始化认证包；未安装认证包的现有 SessionProvider 集成、ChatClient API、构建和
消费者保持不变。认证包采用独立 Changesets 版本，现有七包 fixed group 不因安装它而改变。

宿主启动时固定 `staging` 或 `production` 环境，AuthClient 创建后不可修改；UI 不提供任意后端
URL 输入。每个 AuthClient 实例独立持有环境、会话、账户上下文、订阅、generation 和释放生命
周期。不同环境、用户、账户和组织之间不得共享凭证或可变状态。

认证模块只使用宿主注入的短期认证材料和可选 CredentialStore。默认存储为内存，不隐式写入
localStorage、IndexedDB、Cookie、文件系统或 URL。持久化记录按环境/用户/账户/组织 scope
隔离并由宿主决定实现、加密和清理。若使用持久化恢复，宿主必须在创建客户端时提供与当前
环境/用户/账户/组织匹配的 CredentialScope；未有可信 scope 时只能使用内存会话。Token 不能进入 AuthSnapshot、日志、错误文本、raw 数据、
缓存或 UI 渲染树。`createSessionProvider()` 只在聊天 Gateway 请求或连接期间按需取得短期
Session；认证模块不创建 ChatClient、路由、全局 Store 或宿主页面流程。

Headless 状态包括 `signed_out`、`authenticating`、`account_selection_required`、
`onboarding_required`、`authenticated`、`refreshing`、`switching`、`auth_required`、
`disposed` 和
`error`。旧 generation 的迟到结果必须被丢弃；dispose 后订阅静默且不得重启请求。若服务端
没有 refresh endpoint，恢复或过期处理必须安全降级到 `auth_required`，不得保存密码或静默重放
登录。若实现 refresh，并发请求使用单飞并对 401 只做一次自动重试；失败后清理当前会话并进入
`auth_required`，禁止循环重试。

## 兼容与验证

认证关闭与认证启用是两条互不污染的宿主路径。兼容矩阵必须记录关闭认证时现有 Chat Kit/
SessionProvider 消费者未变、Headless 不加载 React/Ant Design/DOM/TFRobotFront、React/Ant Design
只调用 Headless API，以及环境、账户、凭证、generation、dispose、auth-required、packed artifact
和受控本地 HTTP/Socket.IO 设施测试结果。服务端 refresh、rotation、TTL、撤销和错误码仍由
Server Contract Reviewer 确认；确认前只能实现安全降级和可重复的失败测试。

## 影响与迁移

宿主可以渐进安装认证包，也可以继续注入自己的 SessionProvider。认证 UI 是可选默认实现，宿主
可以完全替换 UI 或只使用 Headless。`@turingfocus/chat-kit` 不重新导出认证实现，不承担登录、
路由或账号业务。

## 未采用方案

- 将认证并入 `chat-runtime` 或 `chat-kit`，避免改变现有认证所有权并迫使未启用认证的宿主承担依赖；
- 在 SDK 内保存密码、长期 Token 或使用浏览器全局存储；
- 允许 UI 任意输入环境或后端 URL；
- 在缺少 refresh 契约时用密码静默登录。
