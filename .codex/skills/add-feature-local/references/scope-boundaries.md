# tf-chat-kit 范围与归属判定

本参考用于 Phase 0 的范围门和 Phase 2 的分层评审。它把项目章程和 ADR 转成可操作判定；原始文档仍是权威来源。

## 权威顺序

发生冲突时按以下顺序处理：

1. 经批准的新 ADR 及其明确替代关系。
2. 当前状态为 `Accepted` 的 ADR。
3. `docs/project-charter.md` 与 `README.md` 的当前承诺。
4. 本仓库已发布公共契约、代码和测试所形成的兼容事实。
5. 当前 TFRobotServer 契约及真实宿主验证证据。
6. TFRobotFront 旧 `chat-player` 的生产行为、测试和性能基线。
7. TFRobotFront 中的历史计划、占位包、目录结构和实现习惯。

用户可以提出改变 1–3 的需求，但必须通过显式 ADR/章程决策，不能由实现静默覆盖。

ADR-007 已明确把向后兼容的 command、可选模型字段、capability、事件或 renderer 扩展归为 Minor。此类新增仍需正常架构评审、测试和兼容记录，但不自动触发新 ADR；只有改变既有语义、所有权、依赖边界或 V1 承诺时才触发。

## 四种范围结论

| 结论 | 含义 | 动作 |
| --- | --- | --- |
| `IN` | 属于稳定聊天语义或已批准公共接入层 | 在最低正确包实现 |
| `SPLIT` | 同时包含公共能力与宿主产品行为 | Kit 实现窄契约，宿主实现其余部分 |
| `OUT` | 仅服务单一宿主产品/平台流程，或属于明确非目标 | 停止 Kit 实施，转宿主项目 |
| `ADR REQUIRED` | 改变包边界、公共语义、所有权、版本或 V1 承诺 | 先提 ADR，批准后实现 |

不要把“两个宿主都可能用”当作公共性的充分条件。公共能力还必须拥有稳定、宿主无关的语义。也不要机械要求已有两个生产消费者：会话加载、发送、中断、状态归并等核心聊天语义即使先由 TFRobotFront 验证，也属于 Kit；但必须能由非 TFRobotFront 最小消费者验证。

## 包归属矩阵

| 包 | 可以做 | 不可以做 |
| --- | --- | --- |
| `@turingfocus/chat-protocol` | 标准模型、运行时校验、Gateway 端口、command/capability 契约 | 状态管理、网络连接、React、DOM、Ant Design、服务端事件名 |
| `@turingfocus/chat-runtime` | 实例化 ChatClient、状态机、归并/去重、聊天命令、结构化错误 | Socket.IO、REST DTO、DOM、宿主路由、宿主 Store、全局单例 |
| `@turingfocus/chat-gateway-tfrobot` | TFRobotServer REST/Socket.IO、DTO 映射、重连、SessionProvider 使用 | UI、产品页面状态、登录流程、长期凭证存储 |
| `@turingfocus/chat-react` | Provider、hooks、React 生命周期和无样式接入 | Ant Design 视觉、服务端 DTO、Socket、宿主导航 |
| `@turingfocus/chat-ui-antd` | 通用聊天 UI、默认 renderer registry、可裁剪/懒加载 renderer | 认证持久化、网络连接、宿主页面工作流、强制所有宿主使用 Ant Design |
| `@turingfocus/chat-testing` | 内存 Gateway、fixtures、契约/消费者测试工具 | 生产网络行为、生产认证和宿主业务 mock 大杂烩 |

## 明确可以进入 Kit

- 会话加载、历史展示、实时更新、文本发送、中断和运行状态的稳定语义。
- 标准 Conversation、Timeline、Message、Agent Event、Run、error、capability 模型。
- 历史与增量归并、幂等/去重、流式更新、多实例隔离和释放生命周期。
- 当前 TFRobotServer REST/Socket.IO 到标准模型的 Gateway 适配。
- SessionProvider 等认证注入契约、结构化认证错误和敏感字段清理。
- 无样式 React Provider/hooks。
- 通用 Ant Design 聊天 UI、默认事件 renderer、未知事件 fallback 和 renderer 错误边界。
- 内存 Gateway、跨实现契约测试、fixtures 和最小消费者验证工具。

## 明确不能进入 Kit

- 登录页、账号体系、账号切换、租户选择、长期 Token/API Key 存储。
- TFRobotFront 的 Next.js 路由、Zustand 全局 Store、页面菜单、布局、机器人配置三态或产品工作流。
- Office Ribbon/Task Pane 生命周期、Tauri 窗口/系统托盘/文件系统等平台产品逻辑。
- 宿主专用埋点供应商、通知、权限 UI、BFF 路由和部署配置，除非先抽象为已有多消费者证明的窄端口。
- Runtime 中的 Socket.IO 事件、namespace、REST 路径或服务端 DTO。
- UI/renderer 直接访问 Gateway、SessionProvider、Socket 或宿主全局状态。
- 全局 ChatClient、Socket、认证上下文或隐式浏览器持久化。
- 公开 npm 发布、开源许可证、AG-UI、Web Component、iframe、Fluent UI 成品包等 V1 非目标。
- 没有独立安装/依赖/版本需求的 Browser、Editor、Shell 预拆包。

## 常见 `SPLIT` 示例

| 需求 | Kit 部分 | 宿主部分 |
| --- | --- | --- |
| “在 Office 中发送附件” | 标准附件 command/model、capability、状态与错误 | Office 文件选择、权限和 Task Pane 交互 |
| “Token 过期后重新登录” | Gateway 识别失效、调用 SessionProvider、输出结构化错误 | 刷新策略、登录页和账号切换体验 |
| “点击聊天引用跳转机器人配置” | 可选的受控 action/事件语义（仅在确有通用意义时） | URL 构造、路由和机器人配置页面 |
| “Tauri 打开下载文件” | 标准下载事件和宿主 action hook | 文件系统权限、保存位置和系统打开行为 |
| “展示新的 TFRobot 工具事件” | Gateway 标准化、fallback、可选默认 renderer | 宿主品牌视觉或平台专用操作 |
| “聊天页埋点” | 必要时提供语义化生命周期 hook | 供应商 SDK、用户标识、上报策略和同意管理 |

## 迁移旧 chat-player 的判定方法

对每个候选能力记录：

```text
旧行为/入口：
真实用户价值：
稳定聊天语义：
历史宿主耦合：
目标包：
公共 API 或内部实现：
TFRobotFront 兼容验证：
非 TFRobotFront 验证：
性能/交互基线：
迁移与回滚方式：
```

遵循以下规则：

- 从生产 caller、测试和实际服务端载荷交叉验证，不只读计划文档。
- 保留用户可观察行为，不保留实现偶然性。
- 将 Next.js、Store、Socket、认证、路由和 UI 依赖逐项拆开，不使用路径替换式搬迁。
- 旧的 `src/packages/chat-kit` 只是历史占位设计；若与本仓库 Accepted ADR 冲突，以本仓库为准。
- TFRobotFront 的 Feature Flag、旧/新切换和最终删旧代码属于宿主迁移工作；Kit 只提供可发布包、兼容信息和验证证据。

## ADR 触发清单

出现任一项时先走 ADR：

- 新增、合并或拆分 workspace 包。
- 改变固定依赖方向或允许宿主源码依赖。
- 将全局单例变成公共模型，或改变 ChatClient 实例所有权。
- 让 Runtime 感知 Socket.IO/REST/TFRobotServer DTO。
- 改变认证、凭证存储或登录责任。
- 改变已有标准字段语义、标识/顺序规则、既有 command 结果或 fallback 策略；单纯新增向后兼容的可选能力不自动触发。
- 从统一版本改为独立版本，或改变私有发布范围。
- 将章程中的 V1 非目标纳入承诺。

## Phase 2 快速自检

- [ ] 已给出 `IN / SPLIT / OUT / ADR REQUIRED`。
- [ ] 已写清 Kit 与每个宿主的责任。
- [ ] 已选择最低正确包并验证依赖方向。
- [ ] 没有 TFRobotFront/Next.js/Office/Tauri 源码依赖回流。
- [ ] Runtime 不感知传输，UI 不直连 Gateway。
- [ ] 多实例、认证、释放和错误行为可测试。
- [ ] 服务端新增字段/未知事件不会击穿主链路。
- [ ] 公共 API、SemVer、统一版本与兼容矩阵影响明确。
- [ ] 有真实复用证据，没有为假想未来预建抽象。
- [ ] 有非 TFRobotFront 最小消费者或宿主验证方案。
