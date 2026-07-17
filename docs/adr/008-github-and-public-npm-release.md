# ADR-008：GitHub 托管与 npm 公开发布

- 状态：Accepted
- 日期：2026-07-17
- 替代：ADR-007 中的代码托管、许可证、Registry、发布身份与公开范围决策

## 背景

ADR-007 以 CNB 私有 Registry 和专有许可证为前提建立统一版本治理。项目现已决定在
`A2C-SMCP` GitHub 组织中公开维护源码，并让 TFRobotFront、Tauri、Office Add-in 和第三方应用
通过 npm 官方 Registry 获取同一组可追踪版本。继续保留 CNB、`restricted` 与 `UNLICENSED`
假设会使 CI、制品元数据和消费者安装路径彼此矛盾。

公开 scoped 包还需要显式的发布访问级别、来源仓库和发布身份门禁。认证态探针确认原计划的
`@tf` scope 已由其他主体持有，当前 Release Owner 无发布权。2026-07-17 已创建 npm
`turingfocus` organization，`npm whoami` 返回 `huruize`，且该账号是 organization owner；
`turingfocus:developers` 团队已存在，当前尚无已发布包。

## 决策

- 源码托管在公开的 `https://github.com/A2C-SMCP/tf-chat-kit`，默认分支为 `main`。
- 六个 workspace 包使用 `@turingfocus/*` scope、统一版本和 Changesets fixed group。
- 根仓库和六个包采用 MIT License。
- 六包以 `public` access 发布到 `https://registry.npmjs.org/`；不使用 GitHub Packages 或 CNB
  Registry 作为正式来源。
- Pull Request 与 `main` push 的工程门禁由 GitHub Actions 执行，并使用完整 Git 历史计算
  changeset comparison base。
- TFCK-42 只建立公开发布基线，不执行正式版本发布。首次正式发布、dist-tag、兼容矩阵和回滚
  由 TFCK-13 负责。
- 正式发布优先使用 npm Trusted Publishing 与 GitHub Actions OIDC。首次 bootstrap 如确需
  传统 npm 凭据，只能存放在受保护的 GitHub Environment 中，完成 trusted publisher 绑定后
  立即撤销长期写权限。
- 公开发布必须保留 npm provenance，使 package、GitHub workflow、source commit、tag 和
  GitHub Release 可相互追溯。
- TFCK-13 建立 `main` 与 `v*` tag 的 GitHub Ruleset：正式 tag 只能由受保护发布环境中的
  Release Owner 从已通过质量门的 `main` commit 创建，禁止移动或删除已发布 tag；npm 发布成功后
  才创建对应 GitHub Release，失败版本不得复用 tag 或覆盖既有 npm version。

ADR-007 的以下决策继续有效：六包统一版本、SemVer 分类、初始 `0.x`、变更记录、服务端基线、
宿主验证、Release Owner 与回滚信息。

## 发布门禁

- 认证态探针确认 Release Owner 是 `turingfocus` organization owner；正式发布前必须重新验证
  登录身份、organization 权限和目标包可发布状态。
- 六个 package manifest 的 `license`、`repository`、`publishConfig.registry` 和
  `publishConfig.access` 与本 ADR 完全一致。
- `pnpm check`、publint、Are the Types Wrong、tarball 内容检查和无认证消费者安装全部通过。
- 仓库、Actions 日志、tarball、source map 和 provenance 中不包含 Token、Cookie 或开发者路径。
- TFRobotFront 纵向切片通过前只允许明确标识的 prerelease，不把开发验证版本提升为 `latest`。
- 发布失败时不得覆盖既有 npm 版本或移动既有 tag。先撤销失败批次新增的 dist-tag，再通过新
  patch 发布替代版本；失败 workflow run 必须关联一个发布事故 Issue，后续成功版本的 GitHub
  Release 链接该 Issue 并记录失败版本、已发布包、dist-tag 处置和替代版本。

## 影响

- 公共源码和公共包使用同一 MIT 授权与可验证来源，第三方消费者不再依赖公司私有 Registry。
- GitHub Actions 成为质量门事实源；CNB 配置和事件变量从活跃工程基线中移除。
- 公开包扩大了供应链、安全披露和兼容沟通责任，但不改变宿主身份、路由和产品工作流边界。
- `turingfocus` organization 所有权已验证；Trusted Publishing 绑定和发布前权限复核仍是正式
  发布门禁，未登录或 E404 不得被解释为已具备权限。

## 未采用方案

- GitHub Packages：会让公开消费者配置额外 Registry，偏离 npm 官方源目标。
- 保持 `@tf/*`：该 scope 已由其他主体持有，当前 Release Owner 无法发布。
- 改名为 `@a2c-smcp/*`：已有 `turingfocus` npm organization 更贴近公共包品牌，无需再引入
  第二个 scope。
- 保持源码私有但包公开：无法获得完整的公开 provenance 与源码审计链路。
- 在 TFCK-42 直接执行正式首发：会绕过 TFCK-13 的宿主验证、兼容矩阵和回滚门禁。
