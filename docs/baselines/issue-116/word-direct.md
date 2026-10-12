# Issue #116：Word 公共直连接入修复

日期：2026-10-12。用户选择纯前端接入方案，正式入口配套支持路由与预检；Front 仅作参考，不修改 Front，不向 Office 移植 Playground 代理。

## 已验证的原因

- SDK 基线为 `origin/main c4462c7b612f5abee77b07a5a99b6bd113e9487f`。
- `routed-api` 生成 `/c/.../api`，Gateway 发送 Server Bearer 和 Server 请求格式；正式该路径进入 Front Cookie BFF。
- Playground 在 `6e10d6d`（2026-09-28）引入 Bearer→Cookie，以适配开发调试；后来还适配创建参数。该设计用于私有调试有其背景，但不能证明公共消费者无代理可用。
- 2026-10-12 09:52:13 UTC，对正式路径的无凭据 OPTIONS 返回 307 登录跳转，无 CORS 允许头。trace-id：`e55c4712b01ad81e27a0e6e5478885a0`。
- `/c/.../v1/chat/conversations` 同样进入 Front；API host 的无凭据预检返回 400 missing routing context。预检不包含实际 Authorization/X-TF 头值，不能依赖这些值寻址。
- 只读查询部署：Operator `0.7.0-rc4`、Front `0.2.12`、本次机器人 Server `0.3.7`。实际 Envoy Lua 与旧实例前缀路由一致：只有 Socket 去前缀转 Server，REST 交 Front。
- 通过本地端口转发直接访问部署中的 Server 0.3.7：Origin=`https://localhost:3002`，预检 POST、authorization/content-type 返回 200 和允许头。Server 自身具备所需 CORS 能力。

## 实现与兼容

- `chat-auth/manager` 新增显式 `http.kind = "routed-server"`，生成不含 `/api` 的机器人实例前缀，Gateway 继续追加 `/v1/chat/...`。
- 保留原 `routed-api`、`direct`、显式 `bff`，不暗中改变已发布配置语义。Origin 信任策略及机器人身份校验不变。
- Playground Manager 直接采用上述公共策略，不再使用私有代理或 Cookie/请求体转换。其他管理员调试模式的代理不作为 Word 验收依据。
- 配套 Operator worktree：`/Users/huruize/VSCodeProject/tfrs-operator-fix-116`，基于 `origin/main b6c40a8814fd0b6595109bf4656275530da125a6`。旧路由只把实例前缀下 `/v1/chat` 家族（含 OPTIONS）去前缀转到 Server，保留 `/api`、页面及 `/v1/chatty`。Server 仍负责 JWT/scope 与 CORS，不在入口放开认证。
- Operator develop 的新域名路由已有 `/v1/` 北向路由；不能把本补丁的旧 namespace 前缀照搬到新路由实现。

## 质量证据

| 验证                                            | 本轮结果                                                                               | 证明范围                                                        |
| ----------------------------------------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| 修复前复现                                      | SDK 新策略 3 个失败；旧入口 OPTIONS/GET/POST/PATCH/DELETE 5 个失败                     | 未修代码不能满足新契约                                          |
| SDK `CHANGESET_BASE_REF=origin/main pnpm check` | 通过；83 文件、1476 测试；lint/types/boundaries/build/packed consumers 均通过          | 本仓库回归与产物                                                |
| 独立 HTTPS tarball 浏览器                       | Chromium/WebKit 均通过；3 策略 × 2 路径格式，含创建、发送、Socket 回复、删除后列表确认 | 真实浏览器 CORS、公共包、受控 HTTP/Socket 服务；不等于正式 Word |
| Playground 全量 E2E                             | 32 项通过；含 Manager 直接访问 Server 路径断言                                         | 宿主 UI 与既有管理员调试路径回归                                |
| Operator cluster 包测试                         | 配置本地 envtest 后通过                                                                | 受影响包完整回归                                                |
| 实际 Envoy 容器                                 | OPTIONS 204、无凭据 GET 401、正确 Bearer GET 200                                       | 真实 Envoy 执行生成的 Lua + HTTP 后端，非字符串断言             |
| Operator vet / golangci-lint                    | 通过，0 issues                                                                         | 受影响包静态检查                                                |

HTTPS 独立测试默认 `https://localhost:3002`；本机该端口已被占用，使用 `TF_CHAT_MANAGER_HOST_PORT=4326`，没有停止或改动既有服务。浏览器运行在 Playwright 1.62.1 Linux 容器。自签证书只用于测试。没有将 token/cookie/凭据写入本报告。

可重复命令：

```sh
CHANGESET_BASE_REF=origin/main pnpm check
pnpm test:manager-browser
# 本机已有 Word 服务占用 3002 时：
TF_CHAT_MANAGER_HOST_PORT=4326 pnpm test:manager-browser
# 可选远程 Playwright runner：TF_CHAT_BROWSER_WS=ws://127.0.0.1:4399/
```

Operator 的实际 Envoy 门禁需显式设置 `TFRO_CHAT_ENVOY_IMAGE=envoyproxy/envoy:v1.32.6`，运行 `go test ./internal/controller/infra/cluster -run TestBrowserChatThroughEnvoy -count=1`；未设置时跳过，目前未接入该仓 CI。

隔离 code-review 初审及写操作覆盖补充后的复审均为 APPROVE、0 阻塞。非阻塞建议：将实际 Envoy 容器测试接入 Operator CI。

## 尚未完成的交付与验收

本轮尚未提交、发布 npm 包、发布 Operator 或修改正式 EnvoyFilter。旧正式入口仍有原问题。

1. 审核并交付 SDK 与入口修复；入口按部署流程发布，避免手工改 Lua 被 Operator reconcile 覆盖。发布前比较目标 Operator 与当前 0.7.0-rc4 的完整差异，本报告不授权把 main 的其他变更直接升级到正式环境。
2. 发布包含 `routed-server` 的 chat-auth，Word 更新依赖及 HTTP 策略；不能让现有 0.10.0 包使用未发布能力。
3. 从真实 Word HTTPS origin 对正式入口完成预检、Manager 换票、REST、Socket、专用会话文本回复及精确清理；记录实际 Word 版本、包版本和镜像版本。
4. 再判定 #111/#113/#116 与 Office #103 是否可关闭。当前不声明正式 UAT 全部通过，不自动更新或关闭远端 Issue。
