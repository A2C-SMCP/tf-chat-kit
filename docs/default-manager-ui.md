# 默认 Manager 聊天界面

`@turingfocus/chat-kit/manager-antd` 提供可选 `ManagerChatApp`。宿主挂载一个组件即可显示登录、组织选择、机器人选择、平台选择、聊天和历史页面。默认中文、绿色主题、单列布局，适用于 Word 任务窗格。旧 `/antd` 和 Headless 入口保持原有行为。

本入口随本次变更发布后可用；`0.10.0-next.0` 不包含它。

```tsx
import { ManagerChatApp } from "@turingfocus/chat-kit/manager-antd";

// auth、manager 由宿主按 Manager 集成指南创建，组件挂载期间保持引用稳定。
// chat 配置也应在组件外定义或 useMemo，避免每次渲染重新连接。
const chat = {
  serverProfile: { kind: "current-server" as const },
  conversationContract: "json-v2" as const,
  messageCreatorProvider: () => ({ uid: "host-user-id", name: "用户名" }),
};

export function WordTaskPane() {
  return (
    <div style={{ height: "100dvh", minHeight: 0 }}>
      <ManagerChatApp auth={auth} manager={manager} chat={chat} />
    </div>
  );
}
```

需要安装兼容的 React、React DOM、Ant Design peers；凭据存储与可信服务地址配置见 [Manager 集成指南](manager-integration.md)。每个独立宿主实例应持有自己的客户端。组件只释放内部创建的聊天控制器；宿主在最终卸载时释放 `auth` 和 `manager`。

可选属性：

| 属性                 | 用途                                                                                                                                   |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `platformId`         | 宿主明确的数字平台 ID；也兼容 `chat.platformId` 数字预设，顶层优先。均省略时展示平台选择，单项也需用户确认。预设变化重置当前工作空间。 |
| `locale`             | `zh-CN`（默认）或 `en-US`                                                                                                              |
| `brand`              | 登录和选择页面的品牌内容                                                                                                               |
| `getPopupContainer`  | 可选宿主弹层容器；省略时弹层限制在当前组件中。                                                                                         |
| `theme`              | Ant Design ThemeConfig，覆盖默认 token                                                                                                 |
| `restoring`          | 宿主恢复身份期间设为 true，避免闪现登录表单                                                                                            |
| `style`、`className` | 宿主容器样式                                                                                                                           |
| `onDisposeError`     | 宿主接收连接释放异常                                                                                                                   |

首次发送才创建会话；点击“新建对话”不会生成空记录。历史和设置使用窗格内部页面，打开设置不会销毁正在进行的聊天。切换身份、机器人或平台会释放旧聊天实例；本地有草稿或正在生成时先提示。该操作不承诺中止服务端任务。

草稿只保存在当前实例内存。登录过期可暂存纯文本，同一身份重新验证后恢复；不同身份和主动退出清空。组件不写 localStorage、sessionStorage，不调用 Office API，也不替宿主保存凭据。文档读写、插入 Word 等能力仍由宿主提供。

验证命令：`pnpm test:manager-browser` 从 tarball 安装独立消费者，使用本地 HTTPS/Socket 服务运行浏览器测试。此项验证不等同于 test 集群或真实 Word WebView 的验收。

认证原子组件新增 `AuthUiLabels.errors`（按安全错误码覆盖文案）与 `LoginPanel.showSessionError`（默认 true）；组合 UI 自己提示登录过期，避免重复错误。auth 随独立 Minor Changeset 增版，不与核心包强制同号。
