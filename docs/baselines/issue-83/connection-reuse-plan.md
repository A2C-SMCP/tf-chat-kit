# Issue #83：Front 风格会话切换与实例内连接复用

- 需求：[同一机器人切换会话时复用实时连接](https://github.com/A2C-SMCP/tf-chat-kit/issues/83)
- 日期：2026-09-15
- Kit 基线：`dev-0.8.2@f1772a0a6980ac2c0387105b8de011fa99a6a2fb`
- Server 源码基线：`develop@236d7c1b25805b1756546c4ea8cf1c433e6a2c9f`
- Front 源码参照：`ce663ae15d1a724377010f1ef0a45b7a36095292`
- 范围：**IN**；Gateway 持有连接与认证，Runtime 管理缓存/选择/命令，宿主负责身份和路由。
- 状态：实现、完整验证与隔离审查已完成；用户已授权提交、推送并关闭 #83，不包含发布。

## 用户确认与需求修订

用户明确“我的目标就是 Front 那样的切换体验”。本轮已向用户说明并按其确认实现：
同一 Gateway、固定服务端/机器人路由、相同有效认证材料下，健康连接跨会话复用；
缓存即时展示、继续同步历史数据；未就绪前只读，旧会话事件隔离。

**不再要求本次实现可靠服务端退订。** 当前 Server 无 leave 处理器，连接存活期间
可能保留访问过的房间，客户端会继续接收并丢弃旧房间数据。此限制已在用户确认前
明确说明，并写入 #83 更新后的验收标准。客户端订阅、监听和异步回调仍必须清理。
不发送无效的 leave，不把空 ACK 当成明确对象授权证明，也不改变 degraded 的含义。

[TFRS-336](https://turingfocus.atlassian.net/browse/TFRS-336) 中的可靠退订/增强 ACK
作为后续增强保留，不再阻塞 #83；该单描述已修正，指向 #83 的远程链接由 `blocks`
改为 `relates to` 并回读确认。该单保持待办，不改变其完整恢复工作的原范围。

## 当前 Server 与 Front 的事实

- Server 的 `tfrobotserver/socket_namespaces/chat.py` 的 join 仅调用 enter_room，
  没有显式授权成功返回。全 Python 源码无 leave_conversation 处理器，base namespace
  在 disconnect 时退出房间。提取真实 join 函数并注入内存房间记录器，A→B→A 后
  剩余房间为 A、B，三次返回均为 None；这是源码探针，不是生产或完整 Server 实测。
- Front 的 `src/api/socket/SocketClientManager.ts` 缓存同地址/身份/机器人路由的
  Socket；`ChatPlayerContent.tsx` 切换时复用 Socket 并 join，清理本地事件监听，
  发送当前 Server 不处理的 leave，按会话 ID 过滤事件。历史内容仍重新请求。
- 因此“连接复用需要新增 Server 契约”的原结论过宽；只有原先要求的“可靠退出旧房间”
  需要上游支持。Front 体验可基于现有 Server 实现。

## 实施方案与文件

1. `packages/chat-gateway-tfrobot/src/socket-transport.ts`：新增 Gateway 实例私有的
   transport 所有者。每个订阅持有独立 lease（连接使用权及监听集合）；健康连接可在
   订阅释放后保留供缓存切换复用。每种物理事件只装一个分发监听器，不累计旧订阅回调。
2. `packages/chat-gateway-tfrobot/src/socket.ts`：复用已有认证、ACK 校验、REST
   预检、有界 deadline、恢复完整性、脱敏及事件转换。每次选择仍获取当前认证材料；
   材料变化在 REST 预检前就使旧连接失效，避免目标加载失败后仍沿用旧身份。
3. 未连接/不健康的 transport 不用于新订阅复用。没有订阅的连接一旦断线即清理，
   不让空闲连接继续刷新凭证或重连。被新连接替代的旧连接即使恢复健康，在最后一个
   订阅释放时也会关闭，最多保留一个可复用空闲连接。Gateway dispose 清理全部连接、
   监听及凭证引用。
4. 切换过会话的连接要求实时应用事件携带可识别的会话 ID。其他会话事件被隔离；
   缺少归属的未知事件或协议 error 不猜测为当前会话错误。首次单会话连接的安全
   fallback 保持兼容。连接级 connect_error/disconnect 仍按真实连接故障处理。
5. Runtime、React 和 UI 生产代码无需改动：复用现有缓存只读快照、generation、
   候选订阅/已提交订阅交接与 #82 的同步提示。增加 Memory Gateway 迟到同步回归。
6. `tests/support/tfrobot-gateway-contract-harness.ts` 的 hold 移到 join 边界，资源
   释放观测区分本地订阅监听和物理连接；保留 deadline、拒绝和迟到资源释放断言。
7. 新增 `tests/chat-connection-reuse.integration.test.ts`，扩展 Gateway 边界测试、
   `tests/chat-conversation-cache.test.ts` 及 tarball Tauri 消费者；补充宿主接入文档
   和 changeset。

## 兼容与架构

- 无新增公开 API、workspace 包或依赖方向。仅按实例复用，不引入 Front 全局单例、
  localStorage、宿主 Store 或路由依赖。
- 保持 ADR-002/003/006/009/010/011 的所有权与信任语义。ADR-011 的活动订阅指
  Runtime 的当前客户端订阅；本轮明确记录服务端房间保留限制，不把旧房间当作客户端
  活动订阅、缓存同步完成或授权证明。
- verified 档位仍需明确 join ACK；显式 current-server 档位仍用相同 session 的
  REST 预检接受空 ACK。无法完整恢复仍为 degraded，不自动重放发送。
- 身份更换应由宿主更新 SessionProvider 或创建新实例；路由固定在 Gateway 构造时，
  切换机器人/服务端应创建新实例。相同地址不构成跨实例共享理由。
- 无公共字段新增，记录 Gateway Patch changeset，实际统一版本由 Changesets 发布
  流程确定；保留用户目标 0.8.2，不自行发布。

## 验证计划与验收

命中真实设施与执行路径触发器。定向测试以真实本地 HTTP/Socket.IO server/client、
真实 fetch、current-server 空 ACK 和实际房间集合，从 ChatClient.loadConversation
入口运行，不用伪造 leave 或 mock transport 代替服务端缺失能力。

覆盖：缓存开/关 A→B→A、重复选择、立即只读缓存、快速切换/迟到 ACK、预检拒绝、
join 后历史失败、账号变化且目标失败、实例隔离、真实断线中切换、复用后恢复、
旧房间/未知无归属事件、Gateway dispose 清理、旧会话协议错误隔离、目标 join 401
使共享身份失效、已释放订阅的认证取消不破坏新订阅重连、恢复的旧连接不残留。Memory Gateway 覆盖缓存 A 的迟到
同步不能覆盖 C。Tauri 消费者从待发布 tarball 验证连接复用、join 次数、物理监听
数量和最终释放，不导入宿主源码。生产 Socket.IO 适配层通过私有 ACK 回调元数据
传递相同请求期限，启用原生 ACK timeout 清理，并剥离 error-first 前缀以保留空 ACK
语义；注入 Socket 的公开窄接口不变。真实客户端 ACK 注册表回归验证永不 ACK 的
重复超时/取消不会永久保留闭包。

```sh
pnpm exec vitest run tests/chat-connection-reuse.integration.test.ts tests/chat-gateway-tfrobot.test.ts tests/chat-gateway-tfrobot-contract.test.ts tests/chat-conversation-cache.test.ts tests/chat-notices.test.ts
pnpm check
```

测试通过后按 add-feature 的隔离上下文审查门控复审完整变更；存在阻塞项则修复后
重新隔离审查。用户已授权提交、推送并关闭 #83；PR、合并与发布另行处理。

## UAT / Seed 与未验证边界

无 Server 数据迁移或种子变更；宿主可在 Playground 中验证同机器人切换的缓存同步
体验。真实 Front、Office、Tauri 部署及完整 TFRobotServer 未实测；本轮真实本地
设施验证冻结的订阅行为，版本化消费者验证产物接入。全量浏览器 E2E 未自动运行。

## 实施验证记录

- Node `24.20.0`。最终 `pnpm check` **退出码 0**：workspace/changeset/依赖边界、
  lint、格式、typecheck、**59 文件 / 1163 项测试**、Playground 构建均通过。
- 7 个包的打包检查以及 Office、Tauri、Front 风格版本化消费者全部通过；Tauri
  消费者从真实 tarball 导入公共 API，验证 A→B→A 一条连接、独立 join、监听与释放。
- 定向 Gateway、契约、Memory 缓存、Playground 与真实设施测试 **6 文件 / 238 项通过**，
  其中真实本地 HTTP/Socket.IO **20 项**。覆盖身份/路由隔离、旧事件隔离、失败与恢复、
  403 后旧会话继续接收消息和发送真实 HTTP 命令、长期复用的 ACK 回调回收。
- 隔离审查发现的七项问题均经过失败复现与回归修复：旧会话协议错误、共享认证拒绝、
  已释放订阅认证取消、被替代的健康空闲连接回收、新候选失败后继续复用已恢复旧连接、
  会话重连 403 作用域、超时/取消 join 的底层 ACK 回收。
- 最终独立审查 **APPROVE**，无阻塞项；审查为只读静态核对，测试由实施阶段执行。
- 完整执行日志：`/tmp/tf-chat-kit-83-verified-check.log`；定向日志：
  `/tmp/tf-chat-kit-83-ack-regression.log`。真实部署与全量浏览器 E2E 未运行，边界见上节。
- 公共 API、Accepted ADR 和宿主迁移接口不变；不引入 Feature Flag，不修改其他仓库，
  不自动发布 0.8.2。可靠服务端退订/增强 ACK 继续由 TFRS-336 后续推进。
