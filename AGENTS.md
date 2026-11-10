# tf-chat-kit 项目协作说明

本文件是仓库内开发代理的项目入口，适用于整个仓库。先阅读本文件，再按任务阅读对应文档与实现。用户在当前会话中的明确指令优先；不要把历史文档中的旧状态当成当前实现。

## 项目定位

tf-chat-kit 将原 TFRobotFront 的聊天能力建设为宿主无关的公共模块，面向 Web、Office Add-in、Tauri 和第三方应用。源码托管于 `A2C-SMCP/tf-chat-kit`，公开包使用 `@turingfocus/*` scope、MIT 许可证和 npm 官方 Registry。

项目的主要交付是可安装的 npm 包、稳定公共契约和仓库内可重复验证的消费者。宿主的源码、构建、部署和任务状态不是本项目的完成前置条件。已有能力优先复用，不直接复制旧 chat-player，也不为假想宿主预拆包。

宿主负责身份所有权、凭据持久化、环境和机器人选择、路由、主题及产品工作流；Kit 提供聊天、认证接入与可替换 UI 的公共能力。提供默认 UI 不代表接管宿主账号体系或导航。

## 仓库导航

| 路径                              | 内容                                     |
| --------------------------------- | ---------------------------------------- |
| `packages/`                       | 八个公开包的源码、清单与变更记录         |
| `playground/`                     | 使用公共组件接入真实环境的本地页面       |
| `tests/`、`fixtures/`             | 单元、契约、工程治理、消费者与浏览器验证 |
| `scripts/`                        | workspace、Changesets、打包和发布治理    |
| `release/`                        | 发布与兼容策略数据                       |
| `.changeset/`                     | 待发布变更和版本分组配置                 |
| `.github/workflows/`              | CI、版本 PR 和受保护发布流程             |
| `docs/adr/`                       | 架构决策及替代关系                       |
| `docs/design/`、`docs/baselines/` | 设计、实验、验收与发布证据               |

按任务阅读 [README](README.md)、[项目章程](docs/project-charter.md)、[工程基线](docs/engineering-baseline.md) 和 [ADR 索引](docs/adr/README.md)。宿主接入看 [接入指南](docs/host-app-integration.md) 与 [Manager 集成](docs/manager-integration.md)；发布看 [发布手册](docs/baselines/tfck-13/release-process.md)。这些文档可能保留历史包数或独立版本描述，应结合本文件的新决策和实际配置判断。

## 包职责与依赖边界

| 包（均为 `@turingfocus/` scope） | 职责与约束                                                                      |
| -------------------------------- | ------------------------------------------------------------------------------- |
| `chat-protocol`                  | 标准模型、校验与 Gateway 端口；不承担网络、状态管理或 UI                        |
| `chat-runtime`                   | ChatClient、状态机、消息归并与命令；不依赖 Socket.IO、DOM 或宿主路由            |
| `chat-gateway-tfrobot`           | REST/Socket.IO 通信及服务端 DTO 映射；不承担 UI 或宿主页面状态                  |
| `chat-react`                     | 无样式 Provider、hooks 与生命周期绑定；不解析服务端 DTO，不引入 Ant Design      |
| `chat-ui-antd`                   | 成品聊天 UI、工作区与 renderer；通过 React/Runtime 发命令，不直接调用 Gateway   |
| `chat-auth`                      | 独立职责的认证契约、适配器、Manager 能力及可选 UI；不反向依赖聊天包             |
| `chat-kit`                       | 生产门面，重新导出公共 API 并组合客户端和工厂；不复制叶子包实现或新增平行状态机 |
| `chat-testing`                   | 内存 Gateway、fixtures 和契约测试工具；作为开发依赖，不进入生产门面             |

依赖方向以 `dependency-cruiser.config.mjs` 和 `scripts/workspace-policy.mjs` 为可执行约束：Protocol 为基础，Runtime 依赖 Protocol，React 依赖 Runtime，UI 依赖 React/Runtime/Protocol，Gateway 依赖 Protocol；门面组合生产叶子包，叶子包不得反向依赖门面。跨包使用公共导出，不导入另一包的内部源码路径。

普通宿主默认只安装 `@turingfocus/chat-kit`，通过 `/headless`、`/react`、`/antd`、`/auth/*` 和 `/manager*` 等公开入口按需接入。高级消费者可直接安装叶子包。Headless 入口必须能在无 React、Ant Design 和 DOM 的环境中加载；可选 peer 不等于按子路径条件安装依赖。

公共包不引用 TFRobotFront、Next.js、Office 或 Tauri 的宿主源码、Router、全局 Store 或平台 API。平台能力通过端口注入，遵守各包依赖 allowlist。

## 版本管理：按模块拆包，按一个产品管理版本

**2026-11-10 用户确定的原则：所有公开包（包括 auth、testing 和门面）采用同一个版本号、同一个 Changesets fixed group，作为一套产品统一验证和发布。**

- 任一包产生待发布变更，整组一起升版并发布，即使部分包源码没有变化。门面版本代表整套 Chat Kit 版本。
- `chat-auth` 保持职责独立、入口显式和按需使用，但不再以独立版本作为长期策略。模块可选与独立发版是两件事。以后新增公开包默认加入统一组；例外需要明确决策和实际消费者依据。
- 公共包变更提交 Changeset，说明真实行为与兼容影响；版本和 changelog 由固定版本的 Changesets 生成，不手工逐包改号或改写生成结果来凑目标版本。
- 当前 `0.x` 阶段：兼容修复升 patch，兼容新增能力升 minor；破坏性变化也升 minor，并明确标注破坏点与迁移步骤。计划版本必须通过现有治理校验。进入 `1.0` 需要明确决策；之后破坏性变化升 major。
- 普通宿主管理一个门面包版本；直接消费多个叶子包的宿主统一升级到同号版本，并提交 lockfile。workspace 内部依赖使用仓库规定的 `workspace:` 协议，发布时解析为实际版本范围。
- 根 `package.json` 是私有工程清单，其版本不代表对外产品版本，不参与公开包统一升版。

### 当前实现与迁移要求

本次确立统一策略，但不表示发布实现已经迁移：当前 `.changeset/config.json` 仍只有七包 fixed group，auth 仍独立计算版本；发布脚本支持 `all/core/auth` 分组。后续不得继续扩展 auth 独立发版策略，也不能直接按八包同号假设调用旧流程。

落地统一版本时必须一并处理 Changesets、workspace/发布策略、发布分组及标签处理、版本计划校验、消费者验证、相关测试与发布文档/技能。新增 ADR 记录本决策，并标记 ADR-012、ADR-014 中独立版本条款的替代关系；保留认证与安全边界。

统一时选择高于各包现有版本的新公共版本，不回退 auth，不覆盖已发布版本，不移动历史标签；通过 Changesets 计划验证迁移结果。历史独立版本与标签仍作为可追溯记录保留。遇到旧脚本要求 auth 独立版本，应修正实现并验证，不能跳过门禁或只改数字。

## 实例、身份与协议约束

- 每个 ChatClient/AuthClient 有独立状态、订阅、身份作用域和释放生命周期；切换环境、账号、组织、机器人或平台时，按公共契约释放旧实例并使在途结果失效。
- 不创建全局 ChatClient、凭据缓存或 Socket 单例。可共享连接必须由宿主显式创建上下文并注入，遵循 ADR-017；聊天与工具 namespace 分别负责自身认证和生命周期。
- 凭据默认只在内存中；持久化由宿主注入 CredentialStore 并提供完整 scope。不保存密码，不把 Token 放入 URL、日志、公共快照、fixtures 或产物。
- Manager 会话与机器人 audience 的 Chat Token 不混用。401 按契约恢复或要求重新认证，403 不能通过反复登录补齐权限；没有已确认 refresh 契约时安全降级，不猜测或无限重试。
- 服务端 DTO 和 Socket 事件在 Gateway 转为稳定模型，Runtime 不直接解释传输细节。会话协议与连接恢复档位由显式配置选择，不通过失败重试创建来猜协议。
- `current-server` 的 REST 回补只有 best-effort 保证，不能声称无损恢复。未知事件和单个 renderer 异常应安全降级；Markdown 保留清洗边界。
- `ChatProvider` 不释放宿主提供的客户端；由 React 创建并拥有实例时使用 `OwnedChatProvider` 和稳定 factory，处理释放失败。

## 开发与验证

工具链以 `.nvmrc`、根 `package.json`、lockfile 为准。当前要求 Node.js 24.x、pnpm 10.34.5；先激活正确 Node 版本，不用 `--ignore-scripts` 绕过版本或安装校验。

```bash
nvm use
corepack enable
corepack prepare pnpm@10.34.5 --activate
pnpm install --frozen-lockfile
pnpm check
```

缺少 Node 版本时先执行 `nvm install`。常用命令：

| 命令                              | 用途                                                                           |
| --------------------------------- | ------------------------------------------------------------------------------ |
| `pnpm dev:playground`             | 启动真实环境 Playground，默认端口 4311                                         |
| `pnpm exec vitest run <测试路径>` | 执行与变更相关的定向测试                                                       |
| `pnpm check`                      | workspace、Changesets、边界、lint、格式、类型、测试、Playground 构建与产物验证 |
| `pnpm pack:workspace`             | 构建并生成可安装 tarball                                                       |
| `pnpm test:e2e`                   | Playwright 验证，先阅读对应测试和环境要求                                      |
| `pnpm test:manager-browser`       | 打包并运行 Manager 浏览器消费者验证                                            |
| `pnpm changeset`                  | 为公共包变更记录 SemVer 影响                                                   |
| `pnpm changeset:status`           | 查看待发布计划                                                                 |

验证强度与变更相称。代码变更先做定向验证，交付前通过所需 CI 门禁；纯说明文档修改检查格式、链接和事实即可。不要为低影响文本修改新增镜像测试。不要用全局 `skipLibCheck`、放宽 peer 或关闭治理规则掩盖兼容问题。

消费者验证必须安装 tarball 或 Registry 包，并实际构建和运行，不能用源码别名代替。仓库内 Front/Office/Tauri 风格消费者、受控 Gateway 契约和产物独立性是发布硬门禁；真实宿主或真实服务 E2E 是补充证据，不能把未执行的验证报告为通过。外部发现的 Kit 缺陷应固化为仓库内可重复测试。

Playground 展示公共默认组件与真实服务工作流，不加入模拟登录、假消息或 Mock 模式。受控 HTTP/Socket.IO 测试设施留在自动化验证中。真实环境验收明确数据范围并清理本轮创建的数据，不误删既有业务数据。

## 发布与协作

- 开工前查看 `git status`，保留用户已有修改和未跟踪文件；需要隔离时使用独立 worktree，不清理不属于当前任务的内容。
- 版本提交只包含版本工具生成的清单、changelog、依赖调整与已消费 Changeset 等发布元数据；源码功能修改另行提交。
- 版本 PR 与 npm 发布分离。稳定发布从已合入 `main` 的确定提交执行，通过受保护 GitHub Actions 和 npm Trusted Publishing/OIDC，保留 Environment 审批；不本地绕过发布。
- 已发布 npm 版本不可覆盖，源码标签不可移动或复用。修复通过新版本发布；失败批次按发布手册核实已发布产物和 dist-tag 后恢复。
- 发版前先检查本文件“当前实现与迁移要求”，确认版本策略已落实到代码；旧发布技能可能仍按六包或七包描述，不能直接据此认定八包统一发布已经可用。
- 交付说明写清改动、验证结果和仍未完成的事项。提交、推送、PR、合并和正式发布按用户授权范围执行，不把文档初始化理解为执行发布的授权。
