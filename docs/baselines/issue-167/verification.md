# #167 验证记录

## 实现与范围

`createTFRobotSocketConnection` 经现有 socketFactory 端口提供显式连接复用。聊天和工具
各自拥有 namespace 生命周期，宿主拥有固定身份和 Robot 的连接上下文。Server、权限、
同名冲突、通用工具参数与会话归属均未改变。ADR-017 已由用户批准。

## 验证基线

- Node 24.20.0。
- 隔离审查前完整 `pnpm check` 退出 0：92 文件、1630 测试通过，随后 Playground、制品
  扫描、类型解析及独立消费者验证通过。日志：`/tmp/tfck-167-check-final.log`。
- 该结果对应 B1 修复前快照；不将它作为修复后完整检查结果。

## 隔离审查 B1

独立只读审查发现：工具 CONNECT 已发送但认证未完成时，本地 disconnect 不会发送
namespace DISCONNECT。服务端迟到成功后会遗留 namespace，重试可能发生协议冲突。
真实 Node Socket.IO 延迟 middleware 用例先稳定失败：超时重试和释放后新建 Provider
均导致原聊天断线。RED 日志：`/tmp/tfck-167-b1-red.log`。

共享层现维护退役握手：继续接收迟到成功/拒绝或物理断线，成功时清理旧 namespace，
使新所有者不接收旧 CONNECT。没有已发送 CONNECT 时仍可立即取消认证；整体释放使在途
结果失效。没有逻辑活动使用方时关闭底层连接，不为退役握手额外保活。

如果服务端永远不完成旧认证，原生协议无法取消这个 CONNECT；工具重试仍有本地截止时间，
不会以关闭聊天连接换取恢复。待服务端返回或底层自然重连后可恢复。没有后台轮询或任意延迟重试。

## Python Socket.IO 兼容观察

使用与本机 TFRobotServer 环境相同的协议库执行隔离本地探针，没有运行或修改业务 Server：

- python-socketio 5.13.0、python-engineio 4.12.2、uvicorn 0.31.1。
- 真实 TCP/WebSocket：先打开聊天，工具握手等待本地超时，再允许旧认证完成并立即 retry。
- 实测：`chat_connects=1`、`chat_disconnects=0`、`tool_connects=2`、
  `registrations=1`、`engines=1`；工具 ready，聊天 active。
- 结果不是生产部署或 Word/Tauri UAT 证明。日志：`/tmp/tfck-167-python-probe.log`。

可复现资源为同目录 `python-socket-server.py` 与 `python-socket-probe.mjs`。准备一个安装
上述 Python 库及 WebSocket 支持的 Python 环境，先构建 workspace，再运行：

```sh
pnpm build
TFCK_PYTHON=/path/to/python node docs/baselines/issue-167/python-socket-probe.mjs
```

探针只使用本地临时服务和固定测试凭据，不依赖外部仓库路径，不进入发布硬门禁。

## Node 测试服务的边界

Node Socket.IO 4.8.3/4.8.4 把收到的 DISCONNECT 延后到 nextTick 处理，却同步检查 CONNECT；
同一批数据中立即再次连接同一 namespace 可能关闭 Engine.IO。原生 DISCONNECT 没有 ACK，
microtask、drain 或固定 sleep 都不是远端完成证明。这与 Python 实现的 namespace 处理有差异。

因此 Node 延迟认证回归在观测到其真实 disconnect 事件后重试，验证迟到 namespace 确实
被清理、聊天保持在线及新工具可执行；立即重试路径另用上述 Python 探针验证。Gateway 的
服务目标仍为 TFRobotServer，不把这份测试记录描述成任意 Node Socket.IO 服务均兼容。

## 收尾状态

第二轮隔离审查发现 B2：自动重连可能在新物理连接已经就绪后收到前一次认证的结果。
真实连续两次断线、旧认证挂起、新认证先完成的回归先失败（工具请求超时），见
`/tmp/tfck-167-b2-red.log`。修复为每次原生 auth 调用绑定 attempt 与 Engine.IO 实例，
成功及失败分支均校验代次；Gateway 会话连接的认证元数据也按代次更新，防止旧结果覆盖。

- B1 后完整检查的全量测试为 92 文件、1632 用例通过；制品阶段仍在运行，日志
  `/tmp/tfck-167-check-b1.log`。此全量测试快照早于 B2 修复。
- B2 后 6 个定向文件、68 用例通过，包括旧认证成功/失败迟到以及随后继续切换会话；
  日志 `/tmp/tfck-167-b2-targeted.log`。最终类型、Lint、diff 检查通过。
- 仓库内 Python 探针也已实际运行，输出与上述兼容观察一致，日志
  `/tmp/tfck-167-python-final.log`。

第三轮隔离审查发现 B3：旧认证仍可能在 lease 内覆盖 REST rebase 使用的 Session，
外层代次检查不足以保护这些副作用。真实 current-server + 延迟 join ACK 用例先失败，
见 `/tmp/tfck-167-b3-red.log`。修复为每次订阅认证拥有独立 AbortController，在新的认证、
断线及清理时取消前一次等待；被取消的结果不修改恢复凭据、错误状态或脱敏集合。

- B3 后扩大到全部 Gateway 与 RemoteTool 相关回归：13 文件、291 测试通过，包含新增
  current-server 恢复窗口；日志 `/tmp/tfck-167-b3-targeted.log`。
- B3 后最终 typecheck、Lint 通过。
- B2 的最终打包验证已通过，且单独打包文件中包含认证 attempt/engine 及 Gateway
  认证代次保护；日志 `/tmp/tfck-167-pack-b2.log`。B3 的最终制品验证仍待执行。

- B3 后 workspace、Changesets、依赖边界、格式及 Playground 构建通过。
- B3 后最终 `pnpm pack:check` 退出 0，安全扫描、类型解析、独立 Headless/React/UI、
  Office/Tauri/Front 风格消费者通过。Headless 消费者验证真实聊天消息与宿主工具结果、
  同一个 Engine.IO 连接，以及工具释放后聊天仍可收消息。日志 `/tmp/tfck-167-pack-b3.log`。
- 已逐一比较归档与当前 dist 的 `socket-connection.js`、`socket-transport.js`、
  `socket.js` 的 SHA256，全部一致，确认上述制品包含 B3 最终代码。
- B3 后仓库内 Python 探针再次退出 0，仍为聊天无断开、一个 Engine.IO 连接，工具 ready；
  日志 `/tmp/tfck-167-python-b3.log`。

第四轮隔离只读审查 `/root/review_shared_socket_release_gate` 已完整审查本单 17 个文件，结论 APPROVE，无剩余阻塞或建议项，确认 B1–B3 均有实现保护与对应真实回归。
没有 commit、push、PR 或发布。真实宿主无需迁移即可继续使用独立连接，启用共享需要显式
传入新 socketFactory；不涉及 Seed 或生产数据变更。

## Playground 追加验收

用户追加要求在 Playground 验收，并将真实登录默认环境设为 test。现新增首页「共享连接验收」模块及仅在 Vite 开发服务运行的隔离本地 Socket.IO 设施，真实调用 SDK；同时增加 test 预设（`https://api.test.turingfocus.cn`），保留 staging、正式、自定义。

- 共享连接 Chromium 3 项通过：真实单条 WebSocket、两个 namespace 同 Engine.IO ID、聊天及宿主工具回传、独立释放和重入、物理断网恢复、375px、多窗口隔离、重置删除失败时仍关闭真实连接并清空状态。
- Manager Chromium 4 项通过：默认 test、staging 切换登录、目录错误重试、test Manager 换票接入本地 HTTP/Socket.IO；日志 `/tmp/tfck-167-manager-browser.log`。
- Playground 4 文件、12 个单元/真实 HTTP 集成用例通过，日志 `/tmp/tfck-167-playground-tests.log`。
- 最终 typecheck、Lint、Playground 构建及 diff 检查通过；构建日志 `/tmp/tfck-167-playground-build.log`。
- 提交前再次执行 `pnpm test`：92 文件、1635 用例通过，日志 `/tmp/tfck-167-precommit-tests.log`。
- 隔离复审 `/root/review_playground_final` APPROVE，无阻塞；重置状态清理及 UTF-8 分块解码建议已修复并验证，环境说明及场景数量文案已同步。

开发服务运行在 `http://localhost:4311`。本地演示不操作真实机器人；未自动使用用户凭据，真实 test 集群账号与机器人由用户验收。未提交、推送或发布。
