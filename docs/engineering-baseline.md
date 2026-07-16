# tf-chat-kit 工程与发布基线

- 状态：Accepted for TFCK-2 implementation
- 日期：2026-07-14
- 适用范围：六个 `@tf/*` workspace 包的构建、测试、打包与开发验证

## 工具链

| 项目             | 基线                           | 原因                                                              |
| ---------------- | ------------------------------ | ----------------------------------------------------------------- |
| Node.js          | 24.x                           | 当前开发环境与 CNB CI 使用同一 LTS 主版本                         |
| pnpm             | 10.34.5                        | 以 Corepack 固定版本，使用 workspace protocol 和严格 peer 校验    |
| TypeScript       | 5.9.3                          | 生成 ESM 与声明文件，保留对现有 TypeScript 5.x 宿主的类型语法兼容 |
| Test             | Vitest 4.1                     | 覆盖工程治理的正常、边界和错误路径                                |
| Lint             | ESLint 9 + typescript-eslint 8 | 使用稳定 flat config，避免把最新主版本迁移混入脚手架任务          |
| Release metadata | Changesets 2.31                | 六包配置为 fixed group，统一 `0.x` 版本                           |

包产物是未打包的 ESM、声明文件和 source map。Protocol、Runtime 与 Testing 编译时不包含
DOM lib；React/UI 才启用 DOM 和 JSX。这样可以在工程层阻止浏览器或 UI 能力回流到 Headless
核心。六个公共包默认也不允许 Node.js built-in 或 `process`/`Buffer` 等 Node 全局；确需平台
能力时必须先在逐包 allowlist 中评审，不得让 Node 专属 API 破坏 Office、Tauri 或浏览器消费者。
首个版本为 `0.1.0`，所有包标记 `UNLICENSED`，发布访问级别为 `restricted`。

## Peer dependency 基线

| 包                 | Peer       | 范围               | 消费者证据                                                 |
| ------------------ | ---------- | ------------------ | ---------------------------------------------------------- |
| `@tf/chat-react`   | React      | `>=18.2.0 <19.0.0` | Office 使用 React 18.2；TFRobotFront/Tauri 使用 React 18.3 |
| `@tf/chat-ui-antd` | React      | `>=18.2.0 <19.0.0` | 与无样式 React 层保持一致                                  |
| `@tf/chat-ui-antd` | Ant Design | `>=5.23.4 <6.0.0`  | Tauri 使用 5.23.4；TFRobotFront 使用 5.28.x                |

React 19 和 Ant Design 6 尚未经过目标宿主验证，不在 V1 支持矩阵中。扩大范围需要独立兼容
验证，而不是直接放宽 peer range。

## CNB npm Registry

实际 endpoint：**待 Release Owner 创建或指定，当前阻塞项**。

2026-07-14 使用只读 CNB API 查询 `turingfocus` 组织，可见 npm 制品仓库数量为 0。源码仓库
已配置为 `https://cnb.cool/turingfocus/tf-chat-kit.git`，但 Git remote 不等同于 npm 制品仓库，
因此不能从源码仓库名推断或伪造发布地址。CNB 官方格式为：

```text
https://npm.cnb.cool/<group>/<artifact-repository>/-/packages/
```

endpoint 确认后，应将 `@tf:registry` 和各包 `publishConfig.registry` 设为同一真实地址，并重新
执行 tarball 安装门禁。认证只允许使用 CNB 内置 `CNB_TOKEN` 或受控 secret；真实 Token、
Cookie、账号密码不得写入仓库、日志或制品。本 Story 不执行正式发布，正式版本、兼容矩阵和
回滚由 TK-12 负责。Registry 和发布身份获批前，根脚本不提供发布命令，workspace policy 也会
拒绝 `changeset publish`、`npm publish`、`pnpm publish` 或 `yarn publish` 等绕过路径。

## 本地与 CI 门禁

```bash
corepack prepare pnpm@10.34.5 --activate
pnpm install --frozen-lockfile
pnpm check
pnpm pack:workspace
```

`pnpm check` 验证固定包集合、统一版本、Changesets 状态、依赖方向、宿主源码零依赖、peer
归属、lint、格式、类型、测试、构建、tarball 最终内容，以及临时消费者的离线安装、TypeScript
构建和 ESM 运行。
公共包变更必须包含描述 SemVer 影响的 changeset；尚未发布且无需升版的工程初始化可以使用带
说明的 empty changeset，但仅在比较基线尚无六包且本次完整创建六包时放行。版本提交必须由
比较基线中被消费的 release changeset 支撑，六包版本必须全部相对基线变化，并且包内只能包含
fixed group 的 `package.json` 和 `CHANGELOG.md` 输出；版本提交必须保持纯净，源码变更另行提交并
提供新的 changeset。根清单、
pnpm override 与六包清单都禁止源码路径依赖；公共包外部依赖采用按 dependency section 划分的
显式 allowlist，React 和 Ant Design 只允许作为 peer，`socket.io-client` 只允许作为
`chat-gateway-tfrobot` 的生产依赖，Monaco/xterm 等重 renderer 只允许作为 `chat-ui-antd` 的生产
依赖。六包必须显式声明 `sideEffects`；当前纯入口使用 `false`，未来引入 CSS 等副作用时改为明确
的文件模式列表。Changesets fixed-group release plan 是版本计算的唯一依据：
待消费计划基于当前全部 pending changeset 计算且不得越过 0.x；已消费计划会在隔离 worktree 中
使用固定版本的 Changesets CLI 在比较基线的全部 pending changeset 上重放，提交中的六包清单、
六个 changelog 及 package 目录触碰文件集合必须与重放结果逐字匹配，不允许手工部分消费。
CNB PR 使用目标分支 SHA 计算 merge-base，main push 使用
`CNB_BEFORE_SHA` 覆盖本次 push 的完整提交范围；缺失事件基线时门禁直接失败。Registry 未就绪
不影响本地 tarball 验证，但会阻塞 TFCK-2 最后一项验收和后续发布。

`pnpm pack:workspace` 是独立可用的制品入口：它会先构建六包，再通过 `pnpm pack --json`
逐包确认 tarball 包含 `dist/index.js`、`dist/index.d.ts` 和 `package.json`。`pack:check` 进一步实际
解包，要求最终 manifest 与源码 manifest 经 workspace 版本解析后的结果完全一致、tarball 文件集合
与 pack 输出一致，并扫描凭证、开发者绝对路径、宿主源码标记和源码依赖协议。即使从 clean
workspace 执行，也不得生成缺少运行时代码或声明文件的空壳包。
