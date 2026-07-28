# tf-chat-kit 工程与发布基线

- 状态：Accepted for TFCK-2 implementation
- 日期：2026-07-14
- 适用范围：六个 `@turingfocus/*` workspace 包的构建、测试、打包与开发验证

## 工具链

| 项目             | 基线                           | 原因                                                              |
| ---------------- | ------------------------------ | ----------------------------------------------------------------- |
| Node.js          | 24.x                           | 当前开发环境与 GitHub Actions 使用同一 LTS 主版本                 |
| pnpm             | 10.34.5                        | 以 Corepack 固定版本，使用 workspace protocol 和严格 peer 校验    |
| TypeScript       | 5.9.3                          | 生成 ESM 与声明文件，保留对现有 TypeScript 5.x 宿主的类型语法兼容 |
| Test             | Vitest 4.1                     | 覆盖工程治理的正常、边界和错误路径                                |
| Lint             | ESLint 9 + typescript-eslint 8 | 使用稳定 flat config，避免把最新主版本迁移混入脚手架任务          |
| Release metadata | Changesets 2.31                | 六包配置为 fixed group，统一 `0.x` 版本                           |

包产物是未打包的 ESM、声明文件和 source map。Protocol、Runtime 与 Testing 编译时不包含
DOM lib；React/UI 才启用 DOM 和 JSX。这样可以在工程层阻止浏览器或 UI 能力回流到 Headless
核心。六个公共包默认也不允许 Node.js built-in 或 `process`/`Buffer` 等 Node 全局；确需平台
能力时必须先在逐包 allowlist 中评审，不得让 Node 专属 API 破坏 Office、Tauri 或浏览器消费者。
首个版本为 `0.1.0`，根仓库和所有包采用 MIT License，发布访问级别为 `public`。

## Peer dependency 基线

| 包                          | Peer       | 范围               | 消费者证据                                                 |
| --------------------------- | ---------- | ------------------ | ---------------------------------------------------------- |
| `@turingfocus/chat-react`   | React      | `>=18.2.0 <19.0.0` | Office 使用 React 18.2；TFRobotFront/Tauri 使用 React 18.3 |
| `@turingfocus/chat-ui-antd` | React      | `>=18.2.0 <19.0.0` | 与无样式 React 层保持一致                                  |
| `@turingfocus/chat-ui-antd` | ReactDOM   | `>=18.2.0 <19.0.0` | 虚拟化 DOM 渲染；与宿主 React 主版本保持一致               |
| `@turingfocus/chat-ui-antd` | Ant Design | `>=5.23.4 <6.0.0`  | Tauri 使用 5.23.4；TFRobotFront 使用 5.28.x                |

React 19 和 Ant Design 6 尚未经过目标宿主验证，不在 V1 支持矩阵中。扩大范围需要独立兼容
验证，而不是直接放宽 peer range。

仓库以支持下界 Ant Design 5.23.4 执行完整声明检查，不启用全局 `skipLibCheck`。该版本及其
传递依赖中有三处已确认的声明生成缺陷（ErrorBoundary 的 ReactNode 返回类型、Cascader 在
`exactOptionalPropertyTypes` 下误用 `Required`、PickerPanel 重复声明 `defaultValue`），由根
目录 `patches/` 中的最小 `.d.ts` 补丁修正。补丁不改变运行时代码，并由锁文件校验及
`pnpm check` 的完整 TypeScript 门禁持续验证；升级 Ant Design 时必须先删除补丁并重新确认
上游声明已修复。`pack:check` 还会在不继承这些补丁的临时项目中，以 5.23.4 和当前 5.29.x
分别安装、编译并服务端渲染已打包 UI，守护公开产物的最低版本兼容契约。

## GitHub 与 npm 官方 Registry

源码仓库为公开的 `https://github.com/A2C-SMCP/tf-chat-kit`。六个 `@turingfocus/*` package manifest
固定使用 `https://registry.npmjs.org/`、`public` access、MIT License 和与源码仓库精确匹配的
repository metadata。

2026-07-17 的认证态探针已确认 `npm whoami` 为 `huruize`，且该账号是 `turingfocus`
organization owner；`turingfocus:developers` 团队存在，当前尚无已发布包。正式发布前仍须重新
验证登录身份、organization 权限和目标包状态；E404 只表示当前不可见，不能单独证明发布权限。
TFCK-42 不执行正式发布；正式版本、dist-tag、兼容矩阵和回滚由 TFCK-13 负责。根脚本继续拒绝
`changeset publish`、`npm publish`、
`pnpm publish` 或 `yarn publish` 等绕过路径，直到 TFCK-13 建立受保护的发布 workflow。

正式发布优先使用 npm Trusted Publishing 与 GitHub Actions OIDC。首次 bootstrap 如确需传统
npm 凭据，只能进入受保护的 GitHub Environment；不得写入仓库、日志、tarball 或 source map，
并应在 trusted publisher 生效后撤销长期写权限。公开 package、公开仓库与 GitHub-hosted runner
共同生成可验证的 npm provenance。

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
GitHub Pull Request 使用 base SHA 计算 merge-base，`main` push 使用 event `before` SHA 覆盖
本次 push 的完整提交范围；workflow 必须 checkout 完整历史，缺失或非法事件基线时门禁直接失败。
npm organization 所有权已验证；Trusted Publishing 绑定与发布前权限复核仍由 TFCK-13 完成。

`pnpm pack:workspace` 是独立可用的制品入口：它会先构建六包，再通过 `pnpm pack --json`
逐包确认 tarball 包含 `dist/index.js`、`dist/index.d.ts` 和 `package.json`。`pack:check` 进一步实际
解包，要求最终 manifest 与源码 manifest 经 workspace 版本解析后的结果完全一致、tarball 文件集合
与 pack 输出一致，并扫描凭证、开发者绝对路径、宿主源码标记和源码依赖协议。即使从 clean
workspace 执行，也不得生成缺少运行时代码或声明文件的空壳包。
