# #167：Chat 与 RemoteTool 共享底层连接实施方案

- 状态：用户已于 2026-11-06 批准；本地实现、验证与隔离审查完成，待提交。
- 工作项：https://github.com/A2C-SMCP/tf-chat-kit/issues/167
- 分析基线：`6caea4e02f3de9c2a85916611797a80012ecda27`。
- 范围：公共能力 IN；连接所有权的可选扩展已通过 ADR-017 评审。

## 目标与边界

宿主在同一个 Robot、身份和部署入口内显式创建连接上下文，让聊天和 RemoteTool 的 namespace 共用一个 Socket.IO Manager / Engine.IO WebSocket。两个客户端分别控制自己的连接、认证、业务状态和释放，单独使用任一客户端仍可工作。

Kit 提供连接复用、namespace 生命周期与公开装配 API。宿主继续提供服务地址、SessionProvider、工具 handler 和平台权限，并在切换身份或 Robot 时更换连接上下文。不改变 action:execute 权限、同名冲突、通用工具参数、超时和调用去重；不将 conversationId 引入工具注册，不修改 Server 或宿主仓库。

## 现状与复用审查

| 现有构件                                                            | 处理方式                                                                                                                 |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `chat-gateway-tfrobot/src/socket.ts` 的 `createSocketIoFactoryWith` | 默认路径保留；抽取窄 Socket 适配，复用认证回调、监听器和 ACK 超时语义                                                    |
| `chat-gateway-tfrobot/src/types.ts` 的 `TFRobotSocketFactory`       | 复用现有注入端口，不新增第二套客户端 connection 配置                                                                     |
| `chat-gateway-tfrobot/src/socket-transport.ts`                      | 保留 Gateway 内会话订阅/连接租约；验证并补齐与共享 namespace 所有权的交接，不能把 conversationId 放入跨 namespace 连接键 |
| `chat-gateway-tfrobot/src/remote-tool.ts`                           | 保留注册、注销、调用和重连逻辑；释放只针对本 namespace                                                                   |
| `chat-kit/src/tfrobot-client.ts` 与 `tfrobot-react.ts`              | 继续沿用 socketFactory 透传；React 已继承 Headless 选项，无需新 hook 或 UI                                               |
| `chat-connection-reuse.integration.test.ts`、RemoteTool 集成测试    | 复用真实 HTTP/Socket.IO 设施与现有恢复场景                                                                               |

当前工厂设置 `forceNew: true`，两条默认接入路径各自建立 Manager。仅移除该标记会依赖 Socket.IO 模块级缓存，不能保证 SDK 实例隔离，故不采用。

## 公共 API

在 Gateway 包实现、由 Kit Headless 门面公开以下入口（实施时保持命名一致）：

```ts
interface TFRobotSocketConnectionOptions {
  readonly serverUrl: string;
  readonly socketPath?: string;
}
interface TFRobotSocketConnection {
  readonly socketFactory: TFRobotSocketFactory;
  dispose(): void;
}
declare function createTFRobotSocketConnection(
  options: TFRobotSocketConnectionOptions,
): TFRobotSocketConnection;
```

`serverUrl` 固定 Engine.IO 服务 origin，`socketPath` 固定部署的 Engine.IO 路径。namespace 使用现有客户端 `socketNamespaceUrl` / 默认解析结果。检查 origin 和 path 匹配，拒绝凭证、query、fragment 和不匹配端点，不能静默回退为第二条连接。部署路由前缀通过既有显式端点配置传入，不从 REST URL 猜测。

```ts
const connection = createTFRobotSocketConnection({ serverUrl, socketPath });
const chat = createTFRobotChatClient({
  ...chatOptions,
  socketFactory: connection.socketFactory,
});
const tools = createTFRobotRemoteToolClient({
  ...toolOptions,
  socketFactory: connection.socketFactory,
});
tools.start();
// 各客户端独立使用和释放；宿主结束该身份上下文时释放 connection。
```

不暴露原生 Manager、Socket、Token 或全局连接池。构造不读取凭据或连接网络。未注入共享工厂的用户保留原有独立连接行为。向后兼容新增入口按 Minor Changeset 记录，版本号由发布流程决定。

## 所有权与生命周期

1. 每个 connection 私有持有一个 Manager，物理连接的打开/重连只由 Manager 负责；不增加轮询或独立重连循环。
2. 每个 namespace 使用独立 Socket、认证回调和活动状态。不同 namespace 的凭据可不同，不合并 scope，也不要求 Token 字符串相等。业务身份的一致性由创建该上下文的宿主保证，不解析 JWT 猜测身份。
3. namespace 适配句柄分别清理其监听器及 ACK。单方 disconnect 不调用 Manager 的整体关闭；最后一个活动 namespace 结束后物理连接关闭，上下文未 dispose 时可重新使用。
4. 同一 namespace 重新获取时不得残留旧认证回调或被旧句柄释放。需要覆盖现有 Gateway 在连接中、掉线及候选会话切换期间的多租约交接；不能因为 Manager.socket 返回同一对象而直接覆盖 auth。实现复用已有租约模式，并以 generation 隔离迟到回调。
5. 连接上下文不是多个独立 Provider 的注册合并器；不扩展 Server 的同名工具语义。一个宿主身份的 Chat 与 RemoteTool 是本次主要装配场景。
6. tools.dispose 后旧实例不可复活；恢复工具使用同一 connection 创建新 Provider。工具列表仍按现有固定 manifest 语义，替换前先释放旧 Provider；不新增动态工具表或 stop/start 状态机。
7. 网络断开时两方分别接收自己的生命周期事件。Manager 恢复后 Chat 重走既有 join/recovery，RemoteTool 重注册；已注销/释放的 namespace 不重连。不重放已执行工具或迟到结果。
8. namespace 的认证拒绝、注册冲突、握手超时只终止该 namespace；不会主动关闭另一通道。真实物理断线则会同时影响两方，这是共享连接的预期行为。
9. connection.dispose 是幂等的整体终止：通知并关闭仍活动的 namespace，停止重连，清理监听器与适配器保留的资源，使在途认证/ACK 失效。之后不得创建或恢复新连接。正常宿主清理建议先释放子客户端，再释放上下文。

## 文件与实施顺序

| 顺序 | 文件                                                                                               | 内容                                                                  |
| ---- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| 1    | `docs/adr/017-shared-socket-connection.md`、ADR 索引                                               | 经用户审批后记录可选共享连接所有权，补充 ADR-003，不修改既有 ADR 正文 |
| 2    | `packages/chat-gateway-tfrobot/src/socket-connection.ts`（新增）                                   | 实例级 Manager、namespace 句柄、端点约束和整体释放                    |
| 3    | `packages/chat-gateway-tfrobot/src/socket.ts`、`socket-transport.ts`、必要的 `types.ts`            | 提取公共适配细节，保留 ACK 与会话租约语义，处理共享生命周期交接       |
| 4    | `packages/chat-gateway-tfrobot/src/remote-tool.ts`（按需）                                         | 仅调整共享适配下必要的生命周期接线，保留业务执行语义                  |
| 5    | Gateway `src/index.ts`、Kit `src/headless.ts`                                                      | 导出工厂及类型；React/Antd 已经重导出 Headless，无需 UI 变动          |
| 6    | `tests/shared-socket-connection.integration.test.ts`（新增）、现有 Socket/连接复用/RemoteTool 测试 | 真实连接证据及既有路径回归                                            |
| 7    | `docs/baselines/issue-80/remote-tool-consumer.ts`、`scripts/verify-packed-artifacts.mjs`（按需）   | 独立 Headless 打包消费者运行共享连接闭环                              |
| 8    | 宿主接入指南、RemoteTool 指南、`.changeset/`                                                       | 公开接法、生命周期、身份切换、兼容说明和 Minor 变更记录               |

无新增 workspace 包、依赖方向或业务包依赖。Protocol、Runtime 和 React/UI 不引入 Socket.IO 概念。不自动改造 Manager 工作区或外部宿主的装配流程。

## 测试与交付门禁

本功能同时命中“改道执行路径”和“真实 Socket.IO 契约”触发器。以下新增用例必须实际运行，不能用 mock Manager 代替连接复用证据。

- 真实本地 HTTP + Socket.IO，通过公开 Headless 入口加载聊天并接收消息，同时注册宿主工具、调用 handler 并收到正确结果；服务端断言两个 namespace 的 `socket.conn.id` 相同且只有一个活动 Engine.IO 连接。
- chat 先启动、tools 先启动、仅 chat、仅 tools；任一方释放后另一方继续成功收消息/执行工具；注销、同上下文重建 Provider 不增加第二条连接。
- 聊天 A/B 切换、候选失败、恢复期间切换和 React StrictMode 客户端替换，保留现有会话交接语义，工具无误注销或断线。
- tools namespace 的 403/注册冲突/握手挂起，不影响 chat；反向测试 chat 拒绝时工具仍可用。
- 强制关闭真实 Engine.IO transport 后恢复：两方重新就绪，新消息与工具调用成功，旧调用不重放；故障期间释放的一方不复活。
- 最后一个 namespace 结束，底层活动连接数归零；重新使用未 dispose 的上下文成功；整体 dispose 后认证/ACK 迟到不建立连接或执行 handler。
- 两个 connection 即使地址相同也保持不同 Engine.IO ID；端点不匹配明确失败，不自动跨 Robot 复用；新旧 namespace 句柄互不误释放。
- tarball 消费者无 React/DOM，通过真实本地服务验证公开 API、连接 ID 和两个业务结果；既有独立消费者继续通过。

使用 Node 24，拟运行：

```sh
pnpm exec vitest run tests/shared-socket-connection.integration.test.ts tests/chat-gateway-tfrobot-socket-factory.test.ts tests/chat-connection-reuse.integration.test.ts tests/chat-gateway-tfrobot-lifecycle.integration.test.ts tests/remote-tool.integration.test.ts tests/remote-tool-runtime.test.ts
pnpm check
```

完成后按 add-feature 的 Phase 5.5，使用 `fork_turns="none"` 的只读 reviewer 审查全部本单变更，验真并修复阻塞项，重新隔离审查至阻塞清零。只精确暂存本单新增代码/测试文件以纳入审查；不暂存无关文件或已有修改，不自动 commit/push/PR/发布。

## 风险、外部依赖与状态

主要风险是会话租约与 namespace 句柄两层释放的交接，以及重连时旧认证回调误用。以真实网络、generation 和跨层生命周期测试验证。物理网络故障同时影响两个 namespace 是明确行为，不提供链路故障隔离保证。

无需新增 Server 契约或外部交付。不访问生产凭据，不修改测试种子。当前源码的 31 个 RemoteTool 用例通过仅为旧路径基线，不计作本单验收。真实部署及 Word/Tauri UAT 尚未执行，本单以仓库受控真实设施和独立打包消费者为交付验证。

#167 已置为 in-progress。用户已批准本计划及 ADR-017。本地实现、验证与四轮隔离审查已完成，最终 APPROVE；实际结果与兼容边界见 [验证记录](../baselines/issue-167/verification.md)。提交及远端交付仍需另外的明确授权，#167 保持 in-progress。

## 用户追加的 Playground 验收（2026-11-06）

用户要求「需要在playground中增加 效果 我要验收」，并要求真实登录默认增加 test 集群，主要连接 test 机器人。
本轮只扩展私有 Playground：新增首页共享连接验收模块，开发服务提供隔离的本地 HTTP/Socket.IO 设施，页面通过正式 SDK 展示真实连接数量、聊天与宿主工具、独立释放和恢复；不改公共 SDK 或真实 Server。真实登录增加 test 预设并默认指向 `https://api.test.turingfocus.cn`，仍保留 staging/正式/自定义。公共 AuthClient 的环境枚举不变，由 Playground 以独立 transport 地址映射到 staging 语义。

验证包含真实浏览器的共享连接/业务闭环、375px、多窗口隔离，以及默认 test 和 staging 切换；具体操作见 `tests/e2e/acceptance.md`。真实 test 账号登录由用户验收，不自动使用页面凭据。
