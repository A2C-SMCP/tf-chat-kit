# #85：可配置发送快捷键实施计划（按用户修正：默认 Enter 换行）

来源：https://github.com/A2C-SMCP/tf-chat-kit/issues/85

基线：dev-0.8.2，fdceb0a6395c3b976d6271f9e1bb624e13e518fc。工作项已标记 in-progress。

## 范围与复用

范围 IN：通用聊天输入 UI 的可配置键盘交互，放在 chat-ui-antd；chat-kit 继续公开 UI 入口。宿主决定默认模式及偏好持久化。本项不改 Server、Gateway、Runtime 协议，不修改外部宿主，不增加包或依赖方向；公开配置为可选扩展；用户已明确要求改变默认按键行为，属于可观察兼容变化，需在 Changeset/迁移说明中明确记录，不能仅以新增可选 API 为由称完全向后兼容，无需新 ADR。

现有 ChatComposer.handlePressEnter 仅检查 Shift 和 nativeEvent.isComposing，之后走已有 submit。ChatConversationView 创建 ChatComposer；ChatWorkspace 已经通过 conversationViewProps 转发 View 配置，应复用该通道。草稿和附件所有权保持现有模式。

## 实施步骤

1. 在 ChatComposer 公开可选发送模式：Enter 发送（显式可选）与 Ctrl+Enter 发送（默认）。默认模式普通 Enter 换行，macOS/Windows/Linux 统一使用 Ctrl；Shift+Enter 始终换行。不需要平台识别或平台覆盖；明确额外修饰键和 SSR 行为，并在文档中列出完整按键表。
2. 增强已有键盘处理：跟踪 composition 生命周期，核实并保护 WebKit 候选确认边界；发送快捷键的 repeat 事件不重复提交。所有发送继续调用已有 submit，保持空内容、禁用、发送中和附件约束，按钮发送不受模式影响。
3. ChatConversationView 透传配置；ChatWorkspace 复用 conversationViewProps；chat-kit 公开必要类型。配置变更不触发输入框重建或草稿/附件清空。
4. 在输入区新增随模式变化、可通过 labels 国际化的快捷键提示和可访问性关联。
5. 新增键盘单元/DOM 回归：两模式、Ctrl/Meta 修饰键、Shift、composition 边界、repeat、禁用/空内容/发送中、按钮、运行时切换保留内容与附件，以及 View/Workspace 公开入口透传。
6. 实际运行 Chromium/WebKit 的定向浏览器测试，从输入框快捷键触发公开发送链路；覆盖真实换行及 composition 事件边界。记录自动化对操作系统原生输入法的覆盖界限，不将合成事件说成原生 IME 人工验证。此功能启用交互执行路径，定向端到端执行为交付门槛；没有新服务端契约。
7. 补充接入文档、Changeset、非 Front 消费者验证，执行相关检查及 pnpm check；按 add-feature 要求完成隔离上下文 code-review，阻塞项清零后交付。

## 授权边界

用户已确认实施：默认 Enter 换行，macOS 同样使用 Ctrl+Enter；输入法候选确认必须防误发送。当前代码已实现，完整检查和隔离审查均已通过。不继承 #80 的 commit 或关单授权；不自动 commit/push/发布或关闭 #85。无数据迁移或新种子数据；宿主是否采用新模式由宿主选择。

## 业界实践与本项目决策（2026-09-16）

- Slack 官方支持两种 Enter 偏好：选择换行后，用 macOS Cmd+Enter 或 Windows/Linux Ctrl+Enter 发送。这证明组合键发送是成熟可选模式，不代表业界所有产品默认相同。ChatKit 依据用户明确要求默认选择换行模式，且所有平台统一 Ctrl+Enter 发送，不沿用 Slack 的 Mac 修饰键差异。
  来源：https://slack.com/intl/en-gb/help/articles/115005523006-Set-your-Enter-key-preference
- 输入法拥有组词和选字确认事件。发送判定前检查 composition 状态及 nativeEvent.isComposing；MDN 明确说明 compositionend 可能早于最后一次 keydown，使 isComposing 为 false，并建议兼容检查 keyCode 229。该废弃字段仅用于 IME 边界兜底，普通键识别使用 key。
  来源：https://developer.mozilla.org/en-US/docs/Web/API/Element/keydown_event
  规范：https://w3c.github.io/uievents/#events-compositionevents
- 默认键表：Enter/Shift+Enter 为编辑换行；候选确认 Enter 只交给输入法；macOS/Windows/Linux 均仅 Ctrl+Enter 发送。Cmd+Enter 及带额外 Shift/Alt/Meta 的组合不触发发送。显式 enter 模式下，Enter 和 Ctrl+Enter 均发送，Shift+Enter 仍换行。发送匹配仅在输入框获得焦点时生效。
- 判定顺序：输入法保护 → 键与修饰键匹配 → repeat/发送中保护 → 现有发送条件 → 唯一 submit 通道。只对被识别为发送快捷键的事件阻止浏览器默认行为，不统一拦截 Enter，不使用任意固定冷却时间推断输入法结束。
- 失败保留草稿和附件；切换快捷键偏好不重建输入框。提示统一显示 Ctrl+Enter，按钮发送始终可用，偏好存储归宿主。
- 验收必须区分浏览器合成 composition 事件与原生操作系统输入法：Chromium/WebKit 自动化验证事件顺序和键盘链路；macOS 中文输入法候选确认的实际验证结果单独记录，未验证不得声称覆盖。

## 实施验证记录

- 公开 `ChatComposerSendShortcut` 与 `sendShortcut`，默认 `ctrl-enter`，显式 `enter` 保留 Enter 发送；View 透传，Workspace 复用已有 conversationViewProps。无平台探测。
- 输入法保护覆盖 composition 生命周期、isComposing 与确认边界 keyCode 229。公共 submit 增加同步在途保护，并统一检查上传中状态，防止键盘绕过按钮约束。
- 13 项快捷键测试及既有 Composer/View 回归共 3 文件 55 用例通过，日志 `/tmp/tfck-85-regression.log`。
- Chromium 3 项真实浏览器用例通过，覆盖 Workspace 换行/发送、模式切换、Ctrl/Meta、composition 边界和长按。macOS 14.2 的捆绑 WebKit 启动 Bus error，按仓库已有方案使用 Playwright 1.62.1 Noble 容器 WebKit，同样 3 项通过，日志 `/tmp/tfck-85-webkit-container.log`。不将合成 composition 事件描述成 macOS 原生中文 IME 人工验证。
- 增加 tarball 消费者的公开类型、默认模式提示和 aria-keyshortcuts 验证。Changeset 记录 Minor UI 配置扩展及用户确认的默认键位变化；Protocol/Runtime 命令契约未变，迁移说明明确旧宿主应显式配置 enter。初次 Major 标记被既有 0.x 发布门禁拒绝，改为记录用户批准的默认交互不兼容变化，当前 0.x 发布计划采用 Minor 并提供迁移配置，未修改治理规则；目标 milestone 不作为发布版本号承诺。
- 最终补充普通 Enter 与 Ctrl+Enter 两种 IME 确认路径：13 项单元测试通过，Chromium + WebKit 共 6 项浏览器用例通过，日志 `/tmp/tfck-85-final-unit.log`、`/tmp/tfck-85-final-browser.log`。相同 IME 用例在基线 fdceb0a 上 2 项失败，复现旧实现误发送，日志 `/tmp/tfck-85-baseline-red.log`。
- 完整检查的 64 文件 1207 项测试通过；期间仅补强测试与文档，生产代码未变。最终测试文件另行通过 ESLint 与 TypeScript 检查。完整 `pnpm check` 退出码 0，发布包验证通过，包含公开类型、默认快捷键提示、可访问性属性以及各宿主消费者验证，日志 `/tmp/tfck-85-check.log`。
- 两轮隔离审查均为 APPROVE；首轮的普通 Enter IME 覆盖和兼容说明建议已落实，最终审查阻塞项 0、建议项 0。
- 无 Server/Front 修改，无新数据种子或协议迁移；未 commit/push/发布/关单。临时基线工作树与浏览器容器已清理。
