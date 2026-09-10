# 架构决策记录

本目录记录 tf-chat-kit 的重要架构决策。首批 ADR 已完成决策确认，当前状态见下表。

| ADR                                             | 决策                       | 状态       |
| ----------------------------------------------- | -------------------------- | ---------- |
| [001](001-package-boundaries.md)                | 包边界与依赖方向           | Superseded |
| [002](002-runtime-instance-model.md)            | Runtime 实例模型           | Accepted   |
| [003](003-gateway-and-socketio.md)              | Gateway 与 Socket.IO 边界  | Accepted   |
| [004](004-normalized-chat-model.md)             | 标准聊天模型与 raw 数据    | Accepted   |
| [005](005-renderer-extension.md)                | 事件渲染扩展机制           | Accepted   |
| [006](006-auth-and-session.md)                  | 认证与会话注入             | Accepted   |
| [007](007-versioning-and-release.md)            | 原版本与私有发布治理       | Superseded |
| [008](008-github-and-public-npm-release.md)     | GitHub 托管与 npm 公开发布 | Accepted   |
| [009](009-independent-compatibility-testing.md) | 独立项目与仓库内兼容测试   | Accepted   |
| [010](010-default-host-facade.md)               | 统一宿主门面与七包边界     | Accepted   |
| [011](011-conversation-cache.md)                | 会话缓存与恢复信任边界     | Accepted   |

## 状态规则

- `Proposed`：仍在讨论，不能作为实现约束。
- `Accepted`：已批准，实施必须遵循。
- `Superseded`：被后续 ADR 替代，保留作为历史记录。
- `Rejected`：经过讨论但未采用。

已接受 ADR 的实质性变化应通过新的 ADR 完成，并在原记录中标记替代关系；不要直接改写历史决策。
