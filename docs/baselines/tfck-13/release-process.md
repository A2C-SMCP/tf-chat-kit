# TFCK-13 受保护 npm 发布手册

## 发布模型

六个 `@turingfocus/*` 包是不可拆分的 fixed group：同一 release commit、同一 `0.x` 版本、同一
dist-tag。`.github/workflows/release-pr.yml` 在 `main` 更新 Changesets 版本 PR，但不发布。
`.github/workflows/release.yml` 只能从 `main` 手工触发，并引用 `npm-production` Environment；
该引用会产生 GitHub Deployment 记录。发布清单记录 source commit、workflow run、tag、六个
tarball 的 SHA-512 完整性和兼容证据。

`release/compatibility.json` 是机器可读门禁。Front、Office 和 Tauri 风格版本化消费者以及
包级验证对 `next` 与 `latest` 都是硬门禁；`next` 只接受显式 prerelease（如
`0.2.0-next.0`），`latest` 只接受稳定 SemVer。channel 是否允许由仓库内兼容证据状态推导，
配置中不存在可手工放开的 `allowed` 开关。

真实外部 E2E 是非阻塞兼容观察，不能复用 mock/baseline Markdown 冒充。
`tfrobotfrontReal`、`secondHostReal` 和 production Socket 分别只接受
`release/evidence/tfrobotfront-real.json`、
`release/evidence/second-host-real.json` 和 `release/evidence/production-socket.json`。
每个文件必须通过机器校验，记录 evidence kind、关联 Issue、真实 subject、宿主仓库、完整 Git
revision、`staging`/`production` 环境、HTTPS 执行记录、执行时间和 `passed` 结果；缺失、软链接、
越界路径、mock 文档或不匹配内容均不能被报告为真实 E2E。真实 E2E 缺失或失败会保留为兼容风险，
但不改变仓库内兼容门禁的结果。

## GitHub 一次性配置

Release Owner 需要单独审批并完成以下外部变更：

1. 创建 `npm-production` Environment，只允许 `main`，配置 required reviewer，禁止管理员绕过。
2. 建立 `main` Ruleset，要求 CI 成功和 PR 合并；建立 `v*` tag Ruleset，禁止更新和删除正式 tag，
   并只给受控发布主体创建权限。
3. 保持 Actions 默认 token 为只读；仅两个 release workflow 使用文件内声明的最小权限。
4. 首发时把短期 npm granular write token 写入 Environment secret
   `NPM_BOOTSTRAP_TOKEN`。不得写为仓库 secret，不得写入 `.npmrc`、源码或日志。

## 首次发布与 Trusted Publishing

npm 只有在包存在后才能绑定 Trusted Publisher。因此首发采用一次性 bootstrap：

1. 合并版本 PR并确认六包版本完全一致。
2. 在 Actions 手工运行 `tf-chat-kit protected npm release`，输入精确版本，选择 `next` 和
   `bootstrap-token`，由 Environment reviewer 审批。
3. workflow 先执行完整质量门、打包并生成 release manifest，再创建或核对不可移动的 `v<version>`
   tag，随后使用固定的 npm 11.18.0 发布 tarball 并生成 provenance。
4. 六个包在 Registry 完整性和无认证 consumer 验证全部通过后，workflow 才创建 GitHub Release。
5. 确认 Release Owner 的 npm 账号已启用 2FA，然后为每个包绑定 GitHub Actions Trusted
   Publisher：organization `A2C-SMCP`、repository `tf-chat-kit`、workflow `release.yml`、
   environment `npm-production`，allowed action **只选择 `npm publish`**，不授予 stage publish。
   CLI 等价命令为：

   ```bash
   npm trust github <package> \
     --repository A2C-SMCP/tf-chat-kit \
     --file release.yml \
     --environment npm-production \
     --allow-publish
   ```

6. 对六包分别运行 `npm trust list <package> --json`，核对 provider、repository、workflow、
   environment 与 publish permission；删除 `NPM_BOOTSTRAP_TOKEN`，并在 npm 撤销该 token。
   后续发布只允许选择 `oidc`。

任何身份、组织权限、包状态或 Trusted Publisher 核对失败都必须停止，E404 不能证明发布权限。

## 常规发布

1. 合并带 changeset 的功能 PR。
2. 审核自动生成的 fixed-group 版本 PR：仓库内兼容矩阵未通过时不得生成或发布版本；选择
   prerelease 时保持 `.changeset/pre.json` 的 `next` 模式，稳定发布时退出 prerelease mode。
3. 确认 `main` CI 与所有仓库内兼容消费者通过，手工触发 release workflow，填写版本、channel
   和 `oidc`。
4. Environment reviewer 对 commit、版本、兼容矩阵和 channel 进行审批。
5. 下载 GitHub Release 中的 manifest，核对 npm provenance、source commit、tag 和六包 integrity。
6. `latest` 必须发布新的稳定版本，不能把已存在的 `next` 版本原地改标；真实外部 E2E 状态随
   `release/compatibility.json` 进入报告，但不是切换 channel 的前置条件。

Registry consumer 验证固定安装 `@turingfocus/*@<exact-version>`，不依赖 workspace path、缓存或
认证。版本和 tag 都不可覆盖、移动或复用。

## 失败、重入与回滚

发布脚本在每个写操作前读取一次 Registry，并以 tarball integrity 判定同版本是否可安全跳过；
失败后只做一次对账，不轮询。相同 commit 的批准重跑可以补齐 integrity 完全一致且尚未发布的包；
若六包已经全部成功，则跳过写入并继续无认证 Registry consumer 验证。GitHub Release 创建也可重入：
已存在 tarball 必须与当前制品字节一致；manifest 允许重跑产生新的 `runUrl`/`createdAt`，但其余不可变
发布身份必须结构化完全一致。缺失 asset 才会补传，冲突 asset 直接失败。
不能覆盖冲突版本或 Release asset。失败 workflow 会创建或更新 `[Release incident] v<version>` Issue。

Release Owner 应先核对事故清单和 Registry：

- 若尚未撤销 dist-tag，可批准同 commit 重跑以补齐完全一致的部分批次。
- 若决定回滚，仅在事故清单显示 channel 当前确实指向失败版本时操作：存在发布前映射则恢复原
  版本；原来没有该 tag 时才移除。不得凭 `publish-attempted` 状态直接删除 tag。
- 一旦恢复或移除任何 dist-tag，不再重跑旧版本，修复后发布新的 patch，并在后续 GitHub Release
  链接事故 Issue。
- 不执行 `npm unpublish`，不覆盖版本，不移动或删除 `v*` tag。

外部设置、bootstrap、正式发布、dist-tag 变更和事故处置都需要 Release Owner 单独授权。
