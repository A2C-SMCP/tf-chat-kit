# #85：输入框快捷键与输入法保护

## 用户确认的默认行为

所有平台（包括 macOS）默认 Enter 换行，Ctrl+Enter 发送。Kit 不识别操作系统，不把 Cmd 映射为 Ctrl。

| 按键                         | 默认 `ctrl-enter`      | 显式 `enter` 模式      |
| ---------------------------- | ---------------------- | ---------------------- |
| Enter                        | 原生换行               | 发送                   |
| Ctrl+Enter                   | 发送                   | 发送                   |
| Shift+Enter                  | 原生换行               | 原生换行               |
| Cmd/Meta+Enter、Alt+Enter    | 不发送，保留浏览器行为 | 不发送，保留浏览器行为 |
| Ctrl+Shift/Alt/Meta+Enter    | 不发送，保留浏览器行为 | 不发送，保留浏览器行为 |
| IME 组词或选字确认           | 不发送，交给输入法     | 不发送，交给输入法     |
| 长按发送快捷键的 repeat 事件 | 不重复提交             | 不重复提交             |

## 公开接入

```tsx
import {
  ChatComposer,
  ChatConversationView,
  ChatWorkspace,
  type ChatComposerSendShortcut,
} from "@turingfocus/chat-kit";

const mode: ChatComposerSendShortcut = "ctrl-enter";
<ChatComposer sendShortcut={mode} onSend={send} />;
<ChatConversationView sendShortcut={mode} getDeadlineAt={deadline} />;
<ChatWorkspace
  conversationViewProps={{ sendShortcut: mode }}
  getDeadlineAt={deadline}
/>;
```

`sendShortcut` 是可选 UI 配置，未传时为 `ctrl-enter`。宿主可根据自己的偏好设置动态改变配置；Kit 不持久化偏好。切换配置不改变组件 key，不清空文字、长文本引用或附件。

**迁移注意：默认值与旧版本不同。** 需要保留原 Enter 发送习惯的宿主必须显式传 `sendShortcut="enter"`。此默认变更由用户明确确认，Changeset 同时记录兼容影响。本次增加可选 UI 配置，Protocol/Runtime 的发送命令、类型和状态语义不变；这是用户批准的默认交互不兼容变化，当前 0.x 发布计划采用 Minor Changeset，并提供迁移配置；0.x 门禁不代表默认变化向后兼容。本任务不执行版本升级或发布。

快捷键提示可通过 `labels.composerCtrlEnterHint` / `labels.composerEnterHint` 国际化。提示通过 `aria-describedby` 关联输入框，`aria-keyshortcuts` 与模式一致。发送按钮继续走同一个 submit 通道。

## 输入法与重复提交保护

键盘处理依次检查：已处理事件、composition 状态、nativeEvent.isComposing、IME keyCode=229、键及修饰键匹配、repeat/禁用、公共发送条件。只有发送快捷键被拦截；普通 Enter 的编辑行为保留。keyCode 只用于输入法兼容兜底，普通键识别使用 key。

不以任意固定延时推断 composition 结束。MDN 说明 compositionend 可能早于确认候选词的 keydown，此时 isComposing 可能已为 false，需要 229 保护：
https://developer.mozilla.org/en-US/docs/Web/API/Element/keydown_event#keydown_events_with_ime

submit 使用同步在途锁，避免同一 React 渲染间隙的键盘/按钮重复提交；文件上传中也统一阻止发送。失败保留草稿，不能通过快捷键绕过按钮已有的上传约束。

## 验证

- `pnpm exec vitest run tests/chat-composer-shortcuts.test.ts`
- `pnpm exec playwright test tests/e2e/composer-shortcuts.spec.ts tests/e2e/composer-shortcuts-webkit.spec.ts`
- `pnpm check`

浏览器测试使用真实输入框换行、真实 Ctrl/Meta 组合键和长按事件，从公开 ChatWorkspace 经 Runtime 到内存 Gateway 验证发送。该功能不改变服务端协议，所以不需要生产 Server。输入法边界通过 composition/keydown 事件序列验证，不能描述成操作系统原生中文输入法人工测试。

本机 macOS 14.2 的 Playwright WebKit 在启动阶段 Bus error；使用仓库已有容器 WebKit 验证方式：

```sh
docker run --rm --init --shm-size=1g -p 127.0.0.1:3002:3002 mcr.microsoft.com/playwright:v1.62.1-noble npx -y playwright@1.62.1 run-server --port 3002 --host 0.0.0.0
PW_TEST_CONNECT_WS_ENDPOINT=ws://127.0.0.1:3002/ PW_TEST_CONNECT_EXPOSE_NETWORK='<loopback>' pnpm exec playwright test tests/e2e/composer-shortcuts-webkit.spec.ts
```

本机 Chromium 和容器 WebKit 的首轮各 3 项浏览器用例均通过；补强普通 Enter 与 Ctrl+Enter 的输入法确认路径后，最终容器 Chromium + WebKit 共 6 项用例全部通过，快捷键单元测试 13 项通过。原生 macOS/Safari 中文候选确认仍应作为宿主人工复验场景单独记录，不声称已有此证据。无数据迁移、无新增种子；只新增输入交互验收场景。
