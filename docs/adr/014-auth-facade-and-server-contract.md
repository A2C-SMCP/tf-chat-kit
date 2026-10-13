# ADR-014：认证门面与显式 Server 会话契约

- 状态：Accepted
- 日期：2026-10-13
- 关联：#111、#122、#123，milestone 0.10.0
- 决策授权：用户确认门面包含 auth 包，并要求 Word 宿主接入及 test 集群验收。

## 决策

`@turingfocus/chat-kit` 依赖独立发布的 `@turingfocus/chat-auth`，提供
`/auth`、`/auth/tfrobot`、`/auth/manager`、`/auth/react`、`/auth/antd` 显式子入口。
实现全部复用 auth 公共导出；根入口及 headless 聊天入口不初始化认证、不引入认证 UI。
宿主仍可直接提供 SessionProvider。凭据存储、登录触发、账户选择及实例释放仍由宿主控制。

本决策仅替代 ADR-012/013 中门面不得安装 auth 的约束，保留身份生命周期、信任边界与
独立版本策略。七个核心包进入 0.10.0；auth 按自身实际变更独立计算版本，不回退到 0.10.0。

Server 创建会话协议独立于 Socket 恢复 profile，通过显式 conversationContract 选择
query-v1 或 json-v2，默认 query-v1 保持兼容。json-v2 使用 JSON title 与正整数 platformId；
协议错误不触发另一协议的创建重试。平台从 Server 公共接口读取，由宿主显式选择或注入，
不硬编码、不自动创建、不任意选择首项。切换平台必须隔离旧聊天实例。

Manager 的 apiBaseURL 属于 BFF，不推断为 Bearer Server 地址。沿用经验证的 routed-server
解析与允许来源约束。Front 不是 Word 接入的运行时依赖。

## 验证与范围

独立消费者仅声明 chat-kit，覆盖 headless 无 React/DOM、显式认证 UI 与已有 SessionProvider。
通过真实本地 HTTP/Socket、打包消费者和 Playwright 验证协议与生命周期，再以
https://user.test.turingfocus.cn 的真实部署完成创建、发送、回复、历史切换和精确清理。
浏览器宿主模拟与真实 Word 验收分开记录。其他仓库部署变更不属于本次代码修改范围。
