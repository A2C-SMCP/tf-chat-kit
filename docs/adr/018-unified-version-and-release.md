# ADR-018：八包统一版本与发布治理

- 状态：Accepted
- 日期：2026-11-10
- 替代：ADR-012「认证包采用独立 Changesets 版本，现有七包 fixed group 不因安装它而改变」与 ADR-014「保留独立版本策略，auth 按自身实际变更独立计算版本」的版本条款；ADR-012/014 的认证安全、门面入口与 Server 契约决策继续有效
- 补充：ADR-008、ADR-010 的公开包集合与版本描述

## 背景

项目此前把七个 core 包放在同一个 Changesets fixed group，`@turingfocus/chat-auth` 作为可选认证模块独立计算版本。该模型在认证包首次发布时避免了核心包被迫升版，但也带来了两套版本、两套发布组、两套标签和消费者版本对账；随着 `@turingfocus/chat-kit` 门面显式导出 auth 入口，宿主实际把八个包当作一套产品安装和验证。

owner 于 2026-11-10 决定：所有公开包（包括 auth、testing 和门面）采用同一个版本号、同一个 Changesets fixed group，作为一套产品统一验证和发布。模块可选与独立发版是两件事：auth 仍保持职责独立、入口显式和按需使用，但版本与发布统一。

## 决策

八个公开包组成唯一的版本与发布组：

```text
@turingfocus/chat-protocol
@turingfocus/chat-runtime
@turingfocus/chat-gateway-tfrobot
@turingfocus/chat-react
@turingfocus/chat-ui-antd
@turingfocus/chat-kit
@turingfocus/chat-testing
@turingfocus/chat-auth
```

- `.changeset/config.json` 与 `scripts/workspace-policy.mjs` 的 `FIXED_PACKAGE_NAMES` 必须精确包含以上八包。
- 任一包产生待发布变更时，整组一起升版并发布；门面版本代表整套 Chat Kit 版本。
- 发布组统一为 `all`：不再提供 `core`、`auth` 独立发布批次，也不再有 auth 专用的版本覆盖参数。
- 新版本使用不可移动的 `v<version>` 标签。历史 `chat-auth-v*` 标签保留为可追溯记录，不移动、不复用，也不再产生新 auth 标签。
- release manifest 始终记录八包与八份 tarball；`consumerPackages` 始终与发布包同名同版本。
- 普通宿主管理一个门面包版本；直接消费多个叶子包的宿主统一升级到同号版本，并提交 lockfile。

## 版本与标签迁移

- 统一后的公共版本为 **0.13.0**：高于迁移前 core 七包 0.11.0 与 auth 0.12.1，不回退 auth，不覆盖已发布版本。
- 版本号与 changelog 由固定版本的 Changesets 生成；不手工逐包改号，也不改写生成结果来凑目标版本。
- 0.x 阶段：兼容修复升 patch，兼容新增能力升 minor；破坏性变化也升 minor，并明确标注破坏点与迁移步骤。进入 1.0 需要明确决策。
- `check:changesets` 继续使用固定版本 Changesets CLI 在比较基线的全部 pending changeset 上重放，提交中的八包清单、八个 changelog 及 package 目录触碰文件集合必须与重放结果逐字匹配，不允许手工部分消费。
- release-plan 校验随八包 fixed group 收紧：不再允许独立包发布计划，并修复空计划误接受；`check-changesets.mjs` 入口与版本重放路径不变。

## 一次性迁移路径

S6 治理 PR 只落发布治理改动，不包含 0.13.0 版本输出。原因：`check:changesets` 的版本提交重放使用比较基线的 `.changeset/config.json`；迁移 PR 同时修改 config 时，重放使用旧七包 fixed group，与统一八包 0.13.0 输出不一致，且严格文件清单会拒绝治理文件。这是基线问题，不是迁移缺陷。

为使治理 PR 在版本提交生成前可合入，`check:workspace` 保留一个精确的一次性过渡放行：

- 仅当 fixed group 恰为上述八包、七个 core 包全部为 `0.11.0`、`@turingfocus/chat-auth` 为 `0.12.1` 时，允许固定组版本不一致。
- 任一版本变化、仍为七包、auth 为 0.12.x 其他值、core/auth 角色互换或其他任何不一致都失败。
- 该分支由正向与反向测试守护，并在 `scripts/workspace-policy.mjs` 注释中记录移除条件。

**移除触发条件**：0.13.0 版本提交在 `main` 生成后移除该过渡分支；若 owner 明确决定保留，也必须在 ADR 或发布记录中写明。跟踪 GitHub #172；届时不处理则另立清理单。`check:changesets` 的入口脚本与版本重放路径不改；release-plan 校验按上述收紧。

迁移完成后，授权的发布流程把 develop 合入 `main`，changesets/action 基于含新 config 的 `main` 生成 0.13.0 版本 PR；该版本 PR 的重放使用同一 config，现有严格文件清单与八包输出自然匹配。若迁移前旧的 `changeset-release/main` 分支被合并或发布，auth 0.13.0 会被提前占用，统一目标须改为更高的新版本。

## 兼容与验证

- 本次迁移不改变任何包的公共 API、依赖方向、认证所有权或安全边界；只改变版本、fixed group、发布组、标签与发布脚本。
- 迁移验收：`pnpm check` 全绿；八包 0.13.0 的 Changesets 本地重放在临时 worktree 中成立；历史标签未移动；未创建/触发版本 PR、未合 main、未发布。
- 仓库内 Front/Office/Tauri 风格消费者、受控 Gateway 契约与产物独立性仍是发布硬门禁；真实宿主 E2E 仍是非阻塞兼容观察。
- `release/compatibility.json` 的功能性声明（包括 Realtime Ask User 状态）由对应功能交付与验证决定，不在本治理迁移中提前改写。

## 影响

- 宿主与消费者只需理解一个产品版本；跨包版本对账、发布组选择和 auth 专用标签退出日常流程。
- 发布脚本、workflow 输入、manifest、测试与文档中的 `all/core/auth` 分组与 auth 独立版本参数被移除；旧 runbook 传入退休参数会 fail-closed。
- 迁移期的精确过渡放行是一段一次性门禁代码，必须在 0.13.0 版本提交生成后清理或显式保留。
- 历史独立版本与 `chat-auth-v*` 标签仍作为可追溯记录保留。

## 未采用方案

- 在 S6 治理 PR 中直接携带 0.13.0 版本输出：会与旧基线重放和严格文件清单冲突，并把版本元数据与治理源码混在一个提交。
- 保留 `all/core/auth` 分组或 auth 独立标签：与「一套产品、一个版本」的目标冲突，继续产生两套版本与消费者对账。
- 手工把八包改成 0.13.0 而不经 Changesets：`check:changesets` 会拒绝，且无法证明版本输出可重放。
- 删除或移动历史 `chat-auth-v*` 标签：违反已发布标签不可变原则。
