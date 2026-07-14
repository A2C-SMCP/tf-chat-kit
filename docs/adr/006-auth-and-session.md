# ADR-006：认证与会话注入

- 状态：Accepted
- 日期：2026-07-14

## 背景

不同宿主拥有不同的登录、Token 刷新、租户和网络代理方式。如果 Chat Kit 接管登录或持久化凭证，就会与每个宿主的账号体系耦合，并放大第三方集成的安全风险。

## 决策

宿主向 TFRobot Gateway 注入 SessionProvider。SessionProvider 按需提供当前请求或连接所需的短期认证材料，并负责宿主侧刷新策略。

Chat Kit 遵循以下安全边界：

- 不实现登录页面、账号切换或长期凭证存储。
- 不向 localStorage、IndexedDB、文件系统或 Cookie 写入认证信息。
- 凭证只在 Gateway 实例内存和实际请求/连接期间使用。
- Session 失效时，Gateway 通知 SessionProvider 并输出结构化认证错误；是否重新登录由宿主决定。
- 日志、错误、raw 数据和遥测不得包含 Token、Cookie、管理密钥或其他敏感认证字段。
- 受控第三方应用使用短期、最小权限会话，不得获得 TFRobot 管理密钥。

宿主可以选择直连 TFRobotServer 或通过自己的 BFF，但两种拓扑都通过同一 SessionProvider 与 Gateway 端口进入 Runtime。认证上下文按 ChatClient/Gateway 实例隔离，不依赖全局登录变量。

## 影响

- Chat Kit 能适配 Web、Office、Tauri 和合作方不同的身份系统。
- 宿主必须实现 SessionProvider 并处理重新登录体验。
- Gateway 契约测试需要覆盖过期、刷新失败、权限不足和实例切换。

## 未采用方案

- SDK 管理 Token：会把账号系统和安全存储责任引入聊天模块。
- 强制所有宿主使用 BFF：安全边界统一，但会不必要地限制 Tauri 和现有客户端拓扑。
- 直接向第三方分发长期 API Key：权限和泄露风险不可接受。
