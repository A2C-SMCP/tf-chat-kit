# ADR-007：版本与发布治理

- 状态：Superseded
- 日期：2026-07-14
- 替代记录：[ADR-008](008-github-and-public-npm-release.md)（2026-07-17）

> 本记录保留统一版本、SemVer 和 0.x 初始阶段的历史决策。代码托管、许可证、Registry、
> 发布身份与公开范围已由 ADR-008 替代。

## 背景

Protocol、Runtime、Gateway、React 和 UI 经常需要协同变化。V1 如果为每个包维护独立版本，会立即产生复杂的兼容矩阵；同时，该项目尚未建立对公开互联网开发者的支持和安全承诺。

## 决策

所有 workspace 包采用统一版本并在同一发布流程中发布。包名使用 `@tf/*` scope，发布目标为 CNB 私有 npm Registry。

V1 为私有专有软件：仅公司内部和获授权合作方可以使用，不创建开源许可证，也不允许未经授权的公开再分发。

版本遵循 SemVer：

- Patch：不改变公共行为的修复、文档和内部优化。
- Minor：向后兼容的命令、可选模型字段、capability、事件或 renderer 扩展。
- Major：破坏性的公共类型、状态语义、命令行为、标识规则或兼容策略变化。

初始实现使用 `0.x` 版本。在公共契约、迁移门禁和兼容矩阵稳定前，不发布 `1.0.0`。

每次发布必须包含：

- 统一版本的变更记录。
- TFRobotServer 基线和验证结果。
- 已验证宿主及已知限制。
- 破坏性变化的迁移说明。
- Release Owner 与回滚信息。

工程初始化阶段采用 changeset 驱动版本与变更记录，并在 CI 中验证 workspace 版本一致性、包依赖和可安装性。具体 Registry endpoint、凭据和 React/Ant Design peer 版本将在脚手架阶段另行确定。

## 兼容与发布门禁

- TFRobotServer 新增向后兼容字段，不要求 Chat Kit 立即升级。
- 服务端破坏性变化必须由 Core Maintainers、Gateway Maintainers 和 Server Contract Reviewer 共同评审。
- 宿主必须显式升级 Chat Kit 版本，不使用不可追踪的源码复制。
- TFRobotFront 纵向切片通过前，发布物只用于开发验证；通过后才能进入旧模块冻结流程。

## 影响

- V1 的安装、兼容和回滚关系清晰。
- 某个包的小变化也会推动所有包统一升版，换取更低的治理成本。
- 将来只有在包拥有独立消费者和发布节奏后，才重新评估独立版本。

## 未采用方案

- 独立包版本：灵活，但 V1 的依赖矩阵和发布治理成本过高。
- 分组版本：折中方案仍需维护多组兼容关系，当前没有足够收益。
- 单 npm 包：会削弱 Headless、Gateway 和 UI 的安装边界。
- 公开 npm 发布：当前没有公开支持、安全和长期兼容承诺。
