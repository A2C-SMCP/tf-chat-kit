# EPIC-001：建设 tf-chat-kit V1 并迁移 TFRobotFront ChatPlayer

- 状态：Draft
- 日期：2026-07-14
- 外部工作项：[TFCK-1](https://turingfocus.atlassian.net/browse/TFCK-1)
- 目标版本：`0.x` 首个可供生产验证的统一版本
- 主要角色：Core Maintainers、Gateway Maintainers、Host Integrators、Release Owner、Server Contract Reviewer

## Epic 摘要

从 TFRobotFront 当前 `chat-player` 中提取稳定的聊天语义和用户可观察行为，按照已接受的六包架构建设可复用 `tf-chat-kit`。先完成“会话加载 → 历史时间轴 → 实时更新 → 文本发送 → 运行状态 → 中断 → 事件 fallback”的最小纵向切片，再通过 TFRobotFront Feature Flag 和至少一个非 TFRobotFront 消费者验证公共边界，最终形成可发布、可回滚、可逐步替代旧实现的 V1。

本 Epic 不以复制旧目录为目标。旧实现用于确认行为、服务端契约、交互和性能基线；其中的 Next.js、全局 Store、Socket 单例、宿主认证、平台管理和产品工作流不进入 Chat Kit 核心。

## 范围判定

```text
结论：SPLIT
Kit 责任：标准协议、ChatClient Runtime、TFRobot Gateway、React 接入、Ant Design 通用 UI、测试与发布物
宿主责任：登录与凭证刷新策略、路由、页面布局、平台管理、Feature Flag、产品工作流和旧模块删除
目标包：@tf/chat-protocol、@tf/chat-runtime、@tf/chat-gateway-tfrobot、@tf/chat-react、@tf/chat-ui-antd、@tf/chat-testing
受影响宿主：TFRobotFront、Tauri、Office Add-in、受控第三方应用
ADR：无需新增；本 Epic 落实 ADR-001～007。若实施中改变既有边界或 V1 承诺，再单独提出 ADR
```

## 背景与证据

### 本仓库基线

本 Epic 以项目章程和 ADR-001～007 为架构真源。当前仓库只有文档，没有 workspace、实现代码、测试或发布配置，因此工程脚手架本身属于首个交付项。

### TFRobotFront 参考基线

- 仓库：`/Users/huruize/TSProject/TFRobotFront`
- 分支：`develop`
- 参考提交：`324509928552487df35d8e4d9feb59d54ea7f502`
- 现状说明：`docs/chat-player-current-state/README.md`

旧实现已经证明业务链路可用，但职责混合明显：

| 证据 | 当前职责混合 | 本 Epic 的处理 |
| --- | --- | --- |
| `src/components/chat-player/player/ChatPlayerContent.tsx`（806 行） | UI 内直接加载历史、获取 Socket 配置、连接 Socket、解析 DTO、归并消息/事件、管理播放和布局 | 通信移入 Gateway，归并移入 Runtime，React/UI 只消费标准状态和命令 |
| `src/components/chat-player/player/input/ChatInputComponent.tsx`（1043 行） | 文本发送、附件上传、文件序列化、知识库同步、无上限轮询、中断和 UI 状态混在一起 | V1 只提取文本发送与中断；附件公共语义另行评审，知识库/文件产品流程留在宿主 |
| `src/components/chat-player/sider/ChatSider.tsx`（482 行） | 会话分页/CRUD、平台选择、Ant Design 交互和宿主 API 直接耦合 | 会话命令可进入 Gateway/Runtime；平台管理和宿主提示策略留在 TFRobotFront |
| `src/api/socket/SocketClientManager.ts` | 以 URL 为键缓存全局 Socket 单例和认证上下文 | 改为每 Gateway/ChatClient 实例独立持有和释放 |
| `src/context/ChatPlayerContext.tsx` | 聊天语义、滚动、分栏、播放和连接 UI 状态共用一个 Context | Runtime 只管理稳定聊天状态；布局/滚动等留在 React/UI |
| `src/api/dto/conversation/*.ts` | 服务端 DTO 直接成为 UI 模型，Tool 类型依靠返回形状嗅探 | Gateway 边界校验并转为标准模型，未知类型进入 fallback |
| `src/components/chat-player/player/event-detail/EventDetailWrapper.tsx` | 依赖 Next.js dynamic/Image、宿主 Theme、服务端 Tool DTO 和 Ant Design | renderer 只接收标准事件、清理后的 raw 和受控命令；重依赖在 `ui-antd` 内懒加载 |
| `src/store/chat/input.ts` | 会话草稿与附件状态通过 Zustand persist 写入浏览器存储 | 不把宿主持久化策略或认证材料带入 Runtime 公共 API |

旧实现中的行为不是全部自动成为 V1 承诺。V1 固定范围以项目章程为准；未进入固定范围的能力必须先做公共性和迁移必要性评审。

## 用户与业务价值

### 主要用户

- TFRobotFront 用户：在迁移期间获得不低于旧纵向切片的聊天体验，并能安全回滚。
- Tauri 与 Office Add-in 集成方：复用同一聊天协议和 Runtime，不依赖 TFRobotFront 或 Next.js。
- 受控合作方：通过私有 Registry 使用明确版本、兼容基线和最小权限认证入口。
- 维护者：只在 Gateway 处理 TFRobotServer 差异，只在 Runtime 维护聊天状态语义。

### 业务结果

- 新聊天能力只实现一次，由多个宿主按需接入。
- TFRobotServer 字段或实时传输变化不再穿透所有 UI。
- 多窗口、多机器人和多账号场景不再共享隐式状态或认证。
- TFRobotFront 旧 `chat-player` 能在有门禁、有回滚的双轨期后退出，而不是长期双实现。

## 成功标准

Epic 完成时必须同时满足：

1. 六个 workspace 包按固定依赖方向构建、测试和统一版本发布。
2. TFRobotFront 能通过发布包完成会话加载、历史展示、实时订阅、文本发送、运行状态展示和中断。
3. 同一进程内两个 ChatClient 使用不同会话或认证时无消息、连接和凭证串扰。
4. 内存 Gateway 与真实 TFRobot Gateway 通过同一 Runtime 契约测试。
5. 重复事件可幂等归并；未知服务端事件可通过 fallback 展示且不破坏主链路。
6. ChatClient 释放后不再发出更新，并释放订阅、连接和内部资源。
7. 至少一个非 TFRobotFront 真实宿主完成加载、订阅、发送和释放验证；最小消费者只能作为更早的边界探针，不能替代宿主验收。
8. TFRobotFront 的关键交互和性能达到经记录的旧实现基线；未达标时保持或回滚 Feature Flag。
9. 发布记录包含统一版本、TFRobotServer 基线、宿主验证结果、已知限制、Release Owner 和回滚信息。
10. 旧实现只有在已确认的功能/性能门禁全部通过并稳定一个发布周期后删除；双轨期不超过两个迭代。

## 固定范围

### V1 必须交付

- 六包 monorepo 脚手架、严格 TypeScript、构建/测试/lint、changeset 和依赖边界检查。
- Conversation、Timeline、Message、Agent Event、Run、error、capability、snapshot 和增量更新的标准模型。
- 实例化 ChatClient、不可变快照、订阅、加载/切换会话、文本发送、中断和 dispose。
- 历史消息与事件统一时间轴、稳定排序、分页归并、重复投递去重和流式增量更新。
- TFRobotServer REST/Socket.IO Gateway、SessionProvider、重连、join/leave、状态事件和错误映射。
- React Provider/hooks 和无样式接入层。
- Ant Design 会话/时间轴/输入/运行状态 UI，以及 renderer registry、文本/通用事件 renderer 和 unknown fallback。
- 内存 Gateway、fixtures、跨 Gateway 契约测试和最小消费者。
- TFRobotFront Feature Flag 接入、真实服务端验证、兼容矩阵和私有 Registry 发布流程。

### 必须拆分的宿主工作

| 能力 | Kit 部分 | TFRobotFront/其他宿主部分 |
| --- | --- | --- |
| 认证 | SessionProvider、认证错误、凭证清理 | 登录、刷新、账号切换、凭证持久化和跳转 |
| 路由与布局 | 可组合组件、受控回调 | `/chat-player` 页面、菜单、导航和页面级布局 |
| 平台/实例选择 | 可选过滤参数或 capability（确有稳定语义时） | 平台 CRUD、上次选择持久化和产品提示 |
| 下载/打开资源（若后续版本纳入） | 经范围评审批准的标准资源模型和可选 host action port | 浏览器下载、Office/Tauri 文件系统权限和打开方式 |
| Feature Flag | Kit 提供稳定公共入口 | 双轨开关、灰度范围、回滚和旧代码删除 |
| 主题与品牌 | 主题 token/renderer 覆盖入口 | 宿主品牌、全局 ThemeProvider 和产品文案 |

### 不进入本 Epic

- 登录系统、账号体系、机器人配置三态和宿主页面导航。
- Office Ribbon/Task Pane、Tauri 窗口/托盘/文件系统等平台产品能力。
- 公开 npm、开源许可证、AG-UI、Web Component、iframe 和 Fluent UI 成品包。
- 为 Browser、Editor、Shell 预建独立发布包。
- TFRobotFront 中“文件同步到知识库”“文件序列化后引用”等跨业务工作流。
- 将旧附件序列化的无总时限轮询迁入 Kit；未来确需该能力时优先要求服务端事件推送，轮询方案必须单独审批。

## 旧能力迁移分类

| 旧能力 | 结论 | V1 处理 |
| --- | --- | --- |
| 会话加载与切换 | `IN` | 进入 Gateway/Runtime；列表 UI 进入 `ui-antd` |
| 会话创建、重命名、删除 | `DEFER`（公共能力候选） | 不属于章程固定的 V1 纵向切片；后续以向后兼容命令单独立项 |
| 历史消息与事件混排 | `IN` | 由 Gateway 标准化、Runtime 排序归并 |
| Socket 实时消息/事件 | `IN` | 进入按实例 Gateway，禁止暴露 Socket.IO 给 Runtime |
| 文本发送 | `IN` | V1 必须交付 |
| 运行状态与中断 | `IN` | V1 必须交付，覆盖 stale taskId |
| 智能滚动、新消息计数、分栏宽度 | `IN` 到 React/UI，不进入 Runtime 公共状态 | `ui-antd` 提供默认行为，宿主可覆盖 |
| 自动/手动事件回放 | `DEFER` | 先记录旧基线；不是 V1 纵向切片门禁，另行确认公共语义 |
| Ask User 交互 | `IN` 候选 | 通过标准交互请求和受控 answer command 设计，不复用宿主事件对象 |
| 文本/Markdown renderer | `IN` | 提供安全通用 renderer，容器策略与渲染逻辑分离 |
| Browser/Editor/Preview/Shell/Download renderer | `IN` 到 `ui-antd` 内部候选 | 在真实事件契约明确后逐个迁移并懒加载，不拆独立包 |
| Tool 返回形状嗅探 | `DEBT` | Gateway 做兼容映射；标准模型使用明确事件类型，未知类型 fallback |
| 附件与 multipart 发送 | `DEFER / SPLIT` 候选 | TK-02 先确认公共语义和服务端边界；未完成评审前不预设标准模型、command 或 action port |
| 文件序列化、同步 Memory | `OUT` | 留在宿主或相应业务模块，不扩张 Chat Runtime |
| 平台选择与平台 CRUD | `OUT`（UI/产品流程） | 留在 TFRobotFront；仅在服务端契约需要时给 Gateway 注入过滤条件 |
| 输入草稿 localStorage 持久化 | `OUT`（策略） | 宿主决定；Runtime 不隐式写浏览器存储 |

## 目标架构

```text
TFRobotFront / Tauri                Office Add-in / custom React UI
          |                                      |
          v                                      v
  @tf/chat-ui-antd                         @tf/chat-react
          |                                      |
          +------------------+-------------------+
                             v
                     @tf/chat-runtime
                             |
                             v
                     @tf/chat-protocol
                             ^
                             |
                @tf/chat-gateway-tfrobot

          @tf/chat-testing -> protocol/runtime contracts
```

运行时数据路径：

```text
TFRobotServer DTO / Socket event
  -> Gateway runtime validation + sensitive-field scrubbing
  -> normalized snapshot/update
  -> ChatClient merge/dedupe/state transition
  -> immutable snapshot/subscription
  -> React hooks
  -> host UI or ui-antd renderer registry
```

## 交付工作流与子 Story

| 编号 | Jira |
| --- | --- |
| TK-01 | [TFCK-2](https://turingfocus.atlassian.net/browse/TFCK-2) |
| TK-02 | [TFCK-3](https://turingfocus.atlassian.net/browse/TFCK-3) |
| TK-03 | [TFCK-4](https://turingfocus.atlassian.net/browse/TFCK-4) |
| TK-04 | [TFCK-5](https://turingfocus.atlassian.net/browse/TFCK-5) |
| TK-05 | [TFCK-6](https://turingfocus.atlassian.net/browse/TFCK-6) |
| TK-06 | [TFCK-7](https://turingfocus.atlassian.net/browse/TFCK-7) |
| TK-07 | [TFCK-8](https://turingfocus.atlassian.net/browse/TFCK-8) |
| TK-08 | [TFCK-9](https://turingfocus.atlassian.net/browse/TFCK-9) |
| TK-09 | [TFCK-10](https://turingfocus.atlassian.net/browse/TFCK-10) |
| TK-10 | [TFCK-11](https://turingfocus.atlassian.net/browse/TFCK-11) |
| TK-11 | [TFCK-12](https://turingfocus.atlassian.net/browse/TFCK-12) |
| TK-12 | [TFCK-13](https://turingfocus.atlassian.net/browse/TFCK-13) |
| TK-13 | [TFCK-14](https://turingfocus.atlassian.net/browse/TFCK-14) |
| TK-14 | [TFCK-15](https://turingfocus.atlassian.net/browse/TFCK-15) |

### TK-01：初始化 monorepo 与工程治理

**结果**：六个 workspace 包可构建、测试、打包，依赖方向受自动检查保护。

**验收**：

- 建立六包目录、统一 TypeScript/lint/test/build 配置和根命令。
- 所有包使用统一 `0.x` 版本；changeset 可生成变更记录。
- 能生成本地 tarball 或版本化开发验证包，供宿主在正式发布前验证，禁止用源码路径替代包消费。
- React、Ant Design 和重型 renderer 依赖只出现在允许的包中。
- CI 能拒绝反向依赖、宿主源码依赖、版本不一致和不可安装产物。
- Registry endpoint 和 peer dependency 版本在实施前确认，不写入真实凭证。

### TK-02：冻结旧行为与 TFRobotServer 契约基线

**结果**：形成可测试的迁移输入，而不是依赖口头理解或旧组件内部结构。

**验收**：

- 记录 REST 路径、Socket namespace/事件、鉴权字段、DTO 示例和错误响应。
- 从生产 caller、现有测试和真实载荷交叉确认会话、消息、事件、运行状态与中断行为。
- 建立“旧行为 → 标准语义 → 目标包 → 验证方式”矩阵。
- 量化首屏加载、历史分页、大列表更新和实时事件处理基线。
- 标出尚未证实的行为，例如同 eventId 多状态频率、流式增量语义和 MCP transformed 数据。
- 对会话 CRUD、Ask User、附件/multipart、回放和各重型 renderer 逐项给出“纳入 V1 / 留宿主 / 延期并另行立项”，未经结论不得预设公共接口。

### TK-03：实现 `@tf/chat-protocol`

**结果**：宿主和 Runtime 只依赖稳定聊天语义，不依赖服务端 DTO。

**验收**：

- 定义 Conversation、TimelineItem、Message、AgentEvent、Run、ChatError、Capabilities。
- 定义 snapshot/update、Gateway 端口、SessionProvider 和聊天 command 输入/结果。
- 提供运行时 schema，覆盖未知事件和只读、清理后的 `raw`。
- 定义稳定标识、顺序和兼容规则；服务端新增可选字段不会导致旧客户端失败。
- Protocol 不依赖 React、DOM、Socket.IO、Ant Design 或宿主代码。

### TK-04：实现 `@tf/chat-testing` 与契约套件

**结果**：Runtime 可以脱离真实网络开发，所有 Gateway 实现接受同一行为验证。

**验收**：

- 提供可脚本化的内存 Gateway、fixtures、错误和断线注入能力。
- 建立 snapshot/update、命令、重复投递、乱序、unknown event 和认证错误契约测试。
- 测试工具不包含生产凭证或生产网络行为。
- 契约套件以实现工厂/测试适配器为入口，可由后续 Runtime 和 Gateway Story 直接接入；TK-04 不以 TK-05/TK-06 已实现为验收前提。

### TK-05：实现实例化 `@tf/chat-runtime`

**结果**：ChatClient 成为唯一公共状态与命令入口。

**验收**：

- 支持获取不可变快照、订阅、加载/切换会话、发送文本、中断和 dispose。
- 正确合并历史与实时更新，按稳定标识去重并保持顺序。
- 批量历史和高频更新不要求整条列表逐项重建。
- 两个实例的消息、Run、认证和订阅完全隔离。
- dispose 后不再通知订阅者，并释放 Gateway 和内部资源。
- Runtime 接入并通过 TK-04 中适用于状态与命令语义的契约套件。
- Runtime 不导出内部 Store 形状，不依赖 React、DOM 或 Socket.IO。

### TK-06：实现 `@tf/chat-gateway-tfrobot`

**结果**：当前 TFRobotServer 契约被隔离在一个可替换适配器中。

**验收**：

- 支持历史/会话 REST、文本发送、状态查询、中断和 Socket.IO 实时订阅。
- 每实例建立、加入、离开、重连和释放连接；不得使用全局 Socket 单例。
- DTO 和事件先运行时校验，再映射为标准 snapshot/update/error。
- 处理重复事件、断线恢复、跨会话事件和 stale interrupt。
- 通过 SessionProvider 获取短期认证；Token、Cookie、admin key 不进入日志、错误或 raw。
- 真实 Gateway 通过 TK-04 契约测试，并记录验证过的服务端基线。

### TK-07：实现 `@tf/chat-react`

**结果**：React 宿主可以无样式地消费 ChatClient。

**验收**：

- 提供 Provider 和按需 hooks，使用稳定订阅机制避免无关更新引起整棵树重渲染。
- 支持宿主持有实例或由受控 factory 创建实例；所有权规则明确。
- 切换实例、卸载 Provider 时正确解除订阅和按所有权释放。
- 不依赖 Ant Design、TFRobotServer DTO、Socket.IO 或宿主 Store。
- Office Add-in 可以只安装 Protocol/Runtime/React 构建自己的 UI。

### TK-08：实现 `@tf/chat-ui-antd` V1 纵向切片

**结果**：TFRobotFront 和 Tauri 获得可直接使用、可组合的默认聊天 UI。

**验收**：

- 提供会话选择、统一时间轴、文本消息、文本输入、运行状态和中断 UI。
- 提供 loading、empty、error、disconnected、capability unavailable 等状态。
- 支持智能滚动和新消息提示，但布局状态不污染 Runtime 公共模型。
- renderer registry 支持默认、宿主覆盖、未注册 fallback 和单 renderer 错误边界。
- 未知事件至少展示类型、时间和安全摘要。
- UI 不访问 Gateway、SessionProvider、Socket 或宿主全局 Store。

### TK-09：迁移默认 renderer 与关键交互

**结果**：在不破坏核心包体的前提下覆盖 TFRobotFront 必需的事件展示。

**验收**：

- 基于 TK-02 的真实使用频率确定首批 renderer，不因旧目录存在就全部迁移。
- 文本/Markdown 渲染与消息/事件容器策略分离；异常具有独立可识别样式。
- Ask User 通过标准交互模型和受控 answer command 实现。
- Browser、Editor、Preview、Shell、Download 如进入首批范围，作为 `ui-antd` 内部模块懒加载。
- Tool 兼容嗅探只存在于 Gateway 映射或兼容层，不成为标准 UI 主分发方式。
- renderer 加载失败不影响时间轴、输入和中断。

### TK-10：TFRobotFront Feature Flag 集成

**结果**：首个生产宿主通过发布包验证，而不是源码复制。

**验收**：

- TFRobotFront 只通过 `@tf/*` 的版本化开发验证包或 Registry prerelease 接入，不引用本仓库源码；验证通过后由 TK-12 进入正式发布流程。
- 宿主注入 endpoint、SessionProvider、主题和必要回调；路由、平台选择与登录仍在宿主。
- Feature Flag 支持旧/新路径切换和快速回滚，且不会产生双重 Socket 订阅。
- 在真实 TFRobotServer 下验证历史、实时、发送、运行状态和中断。
- 记录功能差异、性能对比、错误率和回滚判据。

### TK-11：非 TFRobotFront 消费者验证

**结果**：用真实第二宿主证明边界，而不是只把旧代码换包名。

**验收**：

- 选择实际计划最明确的 Tauri 或 Office Add-in 完成真实接入；在宿主环境就绪前可以先建立不依赖 Next.js/Ant Design 的最小消费者，但它不能关闭本 Story。
- 完成实例创建、SessionProvider 注入、加载、订阅、文本发送和释放。
- 消费者不需要 TFRobotFront Store、Router、Socket 管理器或全局浏览器状态。
- 将发现的宿主假设修回公共边界，不在消费者中复制 Gateway 协议。

### TK-12：私有发布、兼容矩阵与回滚

**结果**：产物可追踪地进入 CNB 私有 Registry。

**验收**：

- 六包统一版本发布，生成变更记录和安装验证。
- 记录 Chat Kit 版本、TFRobotServer 基线、验证宿主和已知限制。
- 标识 Release Owner、Host Integrator 和回滚版本/步骤。
- 发布凭证只存在于受控 CI secret，不进入仓库或产物。
- TFRobotFront 纵向切片通过前，产物只标记为开发验证用途。

### TK-13：功能门禁、冻结与旧模块退场

**结果**：以证据完成迁移，不形成长期双实现。

**验收**：

- 对旧能力清单逐项给出“已迁移 / 留宿主 / 明确延期 / 产品批准移除”。
- 最小纵向切片稳定后立即冻结旧模块：新聊天功能只进入 Chat Kit，旧模块仅修复严重或阻塞性问题。
- 新路径达到确认的功能、性能、稳定性和安全门禁后切为默认；门禁失败时修复新实现或回滚默认值。
- 默认路径稳定一个发布周期后删除旧实现和 Feature Flag；从冻结到删除的双轨期最多两个迭代。
- 删除 Feature Flag 和旧实现前完成最终回归、依赖扫描和回滚演练。

### TK-14：跨包最终集成回归

**结果**：以纯测试交付守护跨 Story 不变量，成为依赖图唯一汇聚点；不混入生产功能改动。

**验收**：

- 使用已发布或待发布的版本化包执行安装、构建和最小消费者验证，禁止引用本仓库源码路径。
- 同一套契约覆盖内存 Gateway 与真实 TFRobot Gateway，验证历史/实时归并、重复、乱序、unknown event、断线恢复和认证错误。
- 覆盖多 ChatClient、多会话和不同 SessionProvider 的状态、命令、连接与凭证隔离，以及 dispose 后无通知和资源释放。
- 覆盖 TFRobotFront Feature Flag 新旧路径切换、回滚生效和无双重 Socket 订阅。
- 覆盖 TFRobotFront 与第二真实宿主的加载、订阅、发送、中断和释放关键链路。
- 核对 Epic 每条成功标准均有自动化测试或可复现验收记录，输出最终回归报告；本 Story 只提交测试、fixture 和报告。

## 依赖关系

```text
TK-01 + TK-02          -> TK-03
TK-03                  -> TK-04
TK-03 + TK-04          -> TK-05
TK-02 + TK-03 + TK-04  -> TK-06
TK-05                  -> TK-07 -> TK-08 -> TK-09
TK-05 + TK-06 + TK-07  -> TK-11
TK-05 + TK-06 + TK-07 + TK-08 -> TK-10
TK-09 + TK-10 + TK-11  -> TK-12 -> TK-13
TK-13                  -> TK-14
```

- TK-01 与 TK-02 可以并行开始。
- TK-04 必须在 TK-05/TK-06 主体实现前形成最小契约测试能力。
- TK-09 不阻塞最小纵向切片，但进入 TFRobotFront 默认切换前必须满足经批准的 renderer 范围。
- TK-11 必须依赖真实 TFRobot Gateway（TK-06）；如果选用 Tauri 的 Ant Design 成品 UI，还条件依赖 TK-08。
- TK-10 使用 TK-01 产生的版本化开发验证包，避免与验证完成后的 TK-12 正式发布形成循环依赖。
- TK-10、TK-11 属于宿主验证，不能用本仓库单元测试替代。
- TK-14 是所有工作唯一汇聚点，只接受测试、fixture 和回归报告，不混入生产功能修复；发现问题应回到对应 Story 修复后重新执行。

## 跨 Story 质量门禁

### 架构

- 自动验证固定包依赖方向和宿主源码零依赖。
- Runtime 不感知 REST、Socket.IO、DOM、React 或 Ant Design。
- UI/renderer 不直连 Gateway，不读取认证，不把 `raw` 当主业务模型。
- 公共 API 只暴露稳定语义，不暴露内部 Store 或服务端 DTO。

### 功能与可靠性

- 覆盖正常、空数据、分页、断线、重连、重复、乱序、未知事件、认证过期和权限不足。
- 覆盖多实例、多会话切换、卸载/释放和发送后状态变化。
- 所有异步操作有取消或明确上限；不得引入未经批准的无限轮询。

### 安全

- Token、Cookie、admin key、管理密钥不进入持久化、日志、错误、raw 或测试 fixture。
- 受控第三方只使用短期、最小权限会话。
- 外链、Markdown 和 raw 展示具备必要的转义、协议限制和错误边界；附件若经 TK-02 决策纳入某版本，同样适用本门禁。

### 性能

- 历史批量加载与实时增量不会强制重建整条时间轴。
- 重 renderer 不进入首屏主 chunk，并仅在事件实际展示时加载。
- TFRobotFront 切换默认前完成与 TK-02 基线同口径的性能对比。

## 上下游依赖

| 依赖方 | 需要确认/交付 | 阻塞范围 |
| --- | --- | --- |
| TFRobotServer | 当前 REST/Socket 契约、认证字段、事件语义、错误码和测试环境 | TK-02、TK-06、TK-10 |
| TFRobotFront | Feature Flag、SessionProvider、主题/路由接入、旧基线与灰度计划 | TK-10、TK-13 |
| Tauri 或 Office Add-in | 第二宿主选择、最小接入环境和 Host Integrator | TK-11、Epic 完成 |
| CNB Registry/CI | Registry endpoint、权限、secret 和回滚机制 | TK-12 |

服务端破坏性变化必须由 Core Maintainers、Gateway Maintainers 和 Server Contract Reviewer 共同评审。不得在 Kit 中用 DTO 泄漏或跨层补丁绕过上游不确定性。

## 风险与缓解

| 风险 | 缓解 |
| --- | --- |
| 旧 DTO 弱类型和 Tool 形状嗅探被误当公共协议 | 先捕获真实契约；Gateway 兼容映射，标准模型显式类型 + unknown fallback |
| 首个宿主驱动出 TFRobotFront 专用 API | 每个公共决策写宿主责任；TK-11 作为完成门禁 |
| 全局 Socket 习惯导致账号/实例串扰 | 每实例 Gateway + 多实例契约测试 + dispose 测试 |
| 一次性追求旧实现全部功能导致迁移失控 | 先固定纵向切片；其余按迁移分类逐项评审 |
| 重 renderer 推高包体或破坏 SSR/非浏览器环境 | 只存在于 UI 包、懒加载、fallback、核心包无 DOM |
| 双轨长期存在 | 默认切换和删除门禁写入 TK-13，双轨硬上限两个迭代 |
| 附件序列化沿用无限轮询 | 不纳入 V1；优先服务端事件，任何轮询单独审批并设上限 |

## 开放决策

以下事项不阻塞 Epic 建立，但必须在对应 Story 开始前关闭：

1. 确认 package manager、Node/TypeScript、React/Ant Design peer 版本和构建工具。
2. 确认 CNB Registry endpoint、包访问范围和 CI 发布身份。
3. 冻结开始实现时的 TFRobotServer commit/version、测试环境和真实契约样本。
4. 选择 TK-11 的真实第二宿主；默认优先已有接入计划的 Tauri 或 Office Add-in。
5. 用生产数据确认 Tool 类型、同 eventId 多状态、流式增量和 MCP transformed 数据的真实频率。
6. 在 TK-02 中确认 TFRobotFront 默认切换前必须具备的 renderer、Ask User、附件和回放范围；附件未获纳入结论前不得预设公共接口。

## Epic Definition of Done

- TK-01～TK-13 的必需验收项完成，或有明确批准的范围调整和替代工作项。
- 所有自动化质量门禁通过，真实 Gateway 和两个宿主验证证据可追溯。
- 没有 TFRobotFront、Office、Tauri 或第三方宿主源码依赖回流。
- 没有未清理的全局实例、认证持久化、敏感日志或未经批准的轮询。
- 兼容矩阵、发布记录、灰度结果、回滚方案和迁移状态完整。
- 独立代码审查无阻塞项；用户明确批准后方可提交、推送、发布或创建外部 Epic/PR。
