# Issue 111：Manager 公共集成开发验证

## 代码与契约基线

- 开发分支：`feat/111-manager-integration`，基于最新 `origin/main` 的 `317dcf1466f2cf2c5032aa363ef3f4da92178c09`。
- 需求：[tf-chat-kit #111](https://github.com/A2C-SMCP/tf-chat-kit/issues/111)，复用子项 #112–#116。
- Manager 本地代码：`dc2a0fe01d00447181d237da1bfff5605ecb19ba` 的 `internal/user/api/dto/connection_info_dto.go` 和 `internal/user/service/digital_employee_service/connection_info_service.go`。
- TFRobotServer 本地代码：`02a4a85c85a631436d9435814e1ee8cb1ec2b36c`。仅阅读上游，未修改跨仓代码或生产配置。
- Node 24.20.0，pnpm 10.34.5，Playwright 1.62.1。

公共入口、路由策略及生命周期契约见 [集成指南](../manager-integration.md) 和 [ADR 013](../adr/013-optional-manager-integration.md)。

## 本地验证

- `CHANGESET_BASE_REF=origin/main pnpm check` 中 workspace、Changeset、依赖边界、lint、格式、类型、Playground 构建通过；Vitest **83 文件 / 1467 测试通过**。
- 打包扫描发现两处字符串误匹配：诊断对象的 `authorization:` 与换票对象的 `token_profile:`。分别改为 Map 与表单键值 tuples；安全扫描规则保持原样。
- 最终 `pnpm pack:check` **通过**：8 个包的发布内容、安全扫描、publint、类型解析，以及从 tarball 独立安装的 Web/Office Manager 消费者真实 HTTP/Socket 链路均完成。既有认证、React/UI、Headless 与 TFRobotFront 风格消费者兼容检查通过。
- 最终 lint、类型、格式、workspace、Changeset 和依赖边界复验通过。
- 上述最终改动后的生命周期、真实消费者、换票回归：**3 文件 / 28 测试通过**；包括 forbidden 的 invalidate 与重建 Provider 恢复语义。
- Chromium 公共消费者完成登录、目录分页、旧相对路径与完整路径、BFF/直连、换票、到期重换、账号切换、Socket 释放和注销。既有 Playground Manager 真实本地换票、发送及回复场景通过。
- WebKit 公共消费者通过相同本地链路，使用 Playwright 1.62.1 Linux WebKit。macOS 14.2 上随该版本安装的原生 WebKit 在启动阶段 BusError，未计入通过证据。
- 独立只读审查结论 APPROVE；此前 Auth dispose 撤销、目录取消误释放聊天、无效 payload 漏诊断均已修复并覆盖回归。

这些 HTTP 与 Socket 测试使用真实 TCP 监听端口及浏览器原生 fetch；服务数据仍是受控本地 fixture。

## WebKit 运行方式

在 Docker 的 `mcr.microsoft.com/playwright:v1.62.1-noble` 中启动匹配的 `playwright@1.62.1 run-server --port 3000 --host 0.0.0.0`，映射到本机 `127.0.0.1:4399`。
临时 Playwright 配置继承仓库配置，显式设置仓库 `testDir`、webServer `cwd`，并设置 `connectOptions: { wsEndpoint: "ws://127.0.0.1:4399/", exposeNetwork: "*" }`。
执行 `tests/e2e/manager-consumer-webkit.spec.ts`；测试结束后停止临时容器。该远程浏览器只用于本地测试设施。

## 发布与外部验收边界

本地 tarball 验证不等于 npm 已发布。Changeset 准备 chat-auth 与 chat-kit Minor 更新，尚未提交、推送、创建 PR 或发布。
Production Word 的真实会话、回复和生产 issuer/audience 验证仍需宿主联调；cookie BFF、Manager refresh 和可靠事件重放没有本轮证明。
#111 及子项保持未关闭；不以 fixture、开发完成或静态审查替代真实宿主验收和发布门控。

## 后续 Playground UAT

正式 Manager 的本地宿主走查发现并修正 JWT 响应类型、目录错误重试与资格提示三处问题；修正后的完整 check 为 83 文件 / 1473 测试通过。真实流程、精确清理与剩余服务端观察见 [UAT 记录](uat-issue-111-playground-2026-10-10.md)。Production Word 与 npm 发布仍未执行。
