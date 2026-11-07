# Playground 真实环境验收

Playground 直接使用公共 ManagerChatApp 默认 UI，无 Mock 入口、固定聊天数据或本地演示后端。默认连接 https://rest.test.turingfocus.cn。

1. 启动 `pnpm dev:playground`，打开 http://localhost:4311。确认只有 Chat Kit 与 RemoteTool 两区，Chat Kit 为默认绿色紧凑界面。
2. 在默认界面使用真实账号登录，选择组织、机器人和真实平台，创建或打开真实会话并发送消息。验证回复、历史、事件与宿主默认行为一致。
3. RemoteTool 区加载同一组织的真实机器人，显式选择目标并注册 add。可以先注册工具，再选择聊天机器人；工具注册不要求会话 ID。
4. 向相同机器人发送「请调用 add 计算 12 + 30」。确认实际调用记录显示 `add(12, 30) = 42`，机器人收到工具结果。只有真实服务调用才产生记录。
5. 注销 RemoteTool，确认聊天仍可收发；重新注册后关闭 Chat Kit，确认工具仍已注册，可从另一宿主调用。
6. 使用浏览器 Network 检查相同 Robot 的 chat/remote-tool 共用一条 WebSocket；不同机器人或页面身份不共享。
7. 切换组织、退出登录或切换 Manager 环境，确认旧工具注销、旧连接关闭、调用记录清空。刷新页面后重新登录。
8. 权限不足时展示失败，不回退到模拟结果；已存在 add Provider 时按服务端同名冲突规则处理。

## 自动化证据

- `tests/e2e/playground.spec.ts`：默认 UI、test 默认地址、移动端布局；通过真实本地 Manager/RobotServer HTTP 和 Socket.IO 验证两种启动顺序、注册、add ACK、单方释放、环境隔离及权限拒绝。
- `tests/playground-manager-create.integration.test.ts`：真实 TCP 换票验证聊天默认 scopes、工具显式 scopes、配置复制、参数校验、独立连接和注销、在途取消及登出隔离。
- `tests/e2e/fixtures/manager-ui.ts`：打包消费者的完整默认界面和多宽度兼容验收继续保留。
- 原 Mock 页面、手工密码/Token 连接表单、能力演示和本地共享 Socket 演示已退役；底层协议和 Runtime 测试夹具继续用于独立兼容验证。

自动化设施不会成为 Playground 的模拟服务；其通过结果不代表真实账号登录或 LLM 已调用工具。真实机器人和账号由用户在以上流程中验收，不自动使用用户密码、修改机器人配置或清理业务会话。
