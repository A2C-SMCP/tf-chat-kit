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
核心。首个版本为 `0.1.0`，所有包标记 `UNLICENSED`，发布访问级别为 `restricted`。

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

2026-07-14 使用只读 CNB API 查询 `turingfocus` 组织，可见 npm 制品仓库数量为 0；当前本地
Git 仓库也没有 remote。因此不能从源码仓库名推断或伪造发布地址。CNB 官方格式为：

```text
https://npm.cnb.cool/<group>/<artifact-repository>/-/packages/
```

endpoint 确认后，应将 `@tf:registry` 和各包 `publishConfig.registry` 设为同一真实地址，并重新
执行 tarball 安装门禁。认证只允许使用 CNB 内置 `CNB_TOKEN` 或受控 secret；真实 Token、
Cookie、账号密码不得写入仓库、日志或制品。本 Story 不执行正式发布，正式版本、兼容矩阵和
回滚由 TK-12 负责。

## 本地与 CI 门禁

```bash
corepack prepare pnpm@10.34.5 --activate
pnpm install --frozen-lockfile
pnpm check
```

`pnpm check` 验证固定包集合、统一版本、依赖方向、宿主源码零依赖、peer 归属、lint、格式、
类型、测试、构建、tarball 元数据以及临时消费者的离线安装和 ESM 导入。CNB 在 PR 和 main
push 上执行同一门禁；Registry 未就绪不影响本地 tarball 验证，但会阻塞 TFCK-2 最后一项
验收和后续发布。
