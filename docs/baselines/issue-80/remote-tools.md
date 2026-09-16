# RemoteTool 与会话 Ask User 宿主接入（#80）

提供通用 Provider 和内置会话 Ask User。用户确认仅修改 ChatKit，会话归属保留宿主接入口。
当前 Server 的自动会话路由仍由 [TFRS-229](https://turingfocus.atlassian.net/browse/TFRS-229?focusedCommentId=16422) 跟踪。

## 会话内 Ask User

```tsx
import {
  createAskUserRemoteTool,
  createTFRobotRemoteToolClient,
} from "@turingfocus/chat-kit/headless";
import { ChatProvider } from "@turingfocus/chat-kit/react";
import { ChatConversationView } from "@turingfocus/chat-kit";

const askUser = createAskUserRemoteTool({
  // 由宿主可信调用记录提供。不可取当前选中会话或模型参数作为归属。
  resolveConversationId: ({ requestId }) => trustedHostRouting.get(requestId),
});
const provider = createTFRobotRemoteToolClient({
  baseUrl: robotServerUrl,
  sessionProvider,
  tools: [askUser.tool, hostTool],
});
provider.start();

// 与 tools 中同一个控制器；ChatProvider 不接管宿主实例的释放。
<ChatProvider client={chatClient} askUser={askUser}>
  <ChatConversationView getDeadlineAt={() => Date.now() + 10000} />
</ChatProvider>;

// 宿主身份替换或退出时清理；切换会话时不要释放。
provider.dispose();
askUser.dispose();
```

此映射是接入前提，并非 Server 已有接口。没有可信映射时返回 `conversation-unavailable`，
Provider 的 `lastCallError` 可观察，不显示卡片。请求的归属解析包含在默认 110 秒预算内。
Kit 不读取 `params.conversationId`，不把当前页面选择当作调用来源。

内置 `ask_user` 接收 Front 的结构化参数 `title?`、`questions[]`，每题包含 `question`、
`header`、`multiSelect?`、`options[]`（`label`、`description`）。空选项表示文本回答。
模型传来的 timeoutSeconds 不延长本地期限。问题及答案复用 Protocol 的数量、文本长度和选项校验。
卡片只在所属会话显示；切换后返回保留未提交答案和剩余等待时间，结束后显示回答/取消/超时/失败。

Headless 通过 `askUser.getSnapshot()`、`subscribe(listener)`、`answer(conversationId, answer)` 和
`setDraft(conversationId, answer)` 接入自定义视图；React 使用 `useAskUserRemoteTool(conversationId)`。
控制器只保留内存中的最近 100 条记录，满额时先移除已结束记录，不淘汰正在等待的请求；
全部等待且满额则返回 capacity。页面刷新、宿主身份切换或 dispose 不恢复旧等待。
一个控制器配一个 Provider；重建 Provider 时同时重建控制器。与既有 Gateway pendingInteraction 互不覆盖。

## 宿主工具

```ts
import {
  createTFRobotRemoteToolClient,
  defineRemoteTool,
} from "@turingfocus/chat-kit/headless";

const provider = createTFRobotRemoteToolClient({
  baseUrl: robotServerUrl,
  sessionProvider, // getSession 会收到 operation: "remote-tool"
  tools: [
    defineRemoteTool({
      definition: {
        toolName: "read_selection",
        description: "Read the host's selected range",
        parameters: {
          type: "object",
          properties: { range: { type: "string" } },
          required: ["range"],
        },
        tags: ["Read"],
      },
      validate(params) {
        if (typeof params["range"] !== "string")
          throw new Error("Range required");
        return params["range"];
      },
      async execute(range, { signal }) {
        // 宿主负责业务权限和平台适配；signal 为 aborted + subscribe 的轻量端口。
        const text = await hostReadRange(range, signal);
        return { ok: true, resultForLlm: text };
      },
    }),
  ],
});

const unsubscribe = provider.subscribe(() => {
  const state = provider.getSnapshot();
  showToolStatus(state); // ready 才表示 Server 已确认注册
});
provider.start();

// 认证材料刷新或同名冲突解决后，宿主显式重试：
provider.retry();

// 登录身份切换、窗口关闭或宿主卸载时：
unsubscribe();
provider.dispose();
```

`createTFRobotRemoteToolClient` 与聊天客户端分别显式持有和释放；构造不读取认证、不打开
连接。默认使用 `baseUrl` 所在服务的 `/remote-tool` 根路径 namespace（不追加 REST 路径），可用 `socketNamespaceUrl` 指定完整地址。
`socketPath` 默认 `/socket.io`。连接按实例独占，不使用聊天会话 Socket 或 Front 全局对象。
请勿将凭证放进 URL；认证只通过 SessionProvider 的短期材料进入握手。

工具清单在构造时固定，提供 1–100 个定义。替换清单时先释放旧 Provider 再创建新实例，
避免两个连接的注册重叠。同一名称不能由两个 Provider 同时注册；冲突为 `name-conflict`，
不会用后注册者覆盖旧 Provider。其他注册拒绝为 `registration-rejected`。

## 调用与恢复语义

- 默认本地收到调用后约 110 秒截止；`timeoutMs` 可缩短但不可超过 110,000。
  参数校验、业务执行和用户等待共用这一预算，不在异步阶段之间重置。
  Server 当前等待 120 秒，网络延迟仍可能导致 Server 先结束。
- `validate` 返回归一化参数或抛出异常，`execute` 获得推断后的参数类型。异常只返回
  `invalid-parameters` / `handler-failed`，不发送异常文本、堆栈或凭证。
- `signal` 沿用 Kit 的 DOM-free 取消端口（`aborted`、`subscribe`）；调用结束时置为
  aborted 并通知清理。宿主需主动停止未完成工作；不能强制中断同步计算或撤销既有副作用。
- `cancel(requestId)` 结束本地待处理调用并尽力回传 `cancelled`；未知/已结束请求返回 false。
  当前 Server 没有远端取消事件，不能承诺调用者中断自动传播。
- 相同 requestId 在该实例整个生命周期中只执行一次、只提交一次结果；重复报文被忽略，
  不缓存/重发成功结果。超时后完成的 Promise 被观察并丢弃。
- 默认最多同时等待 32 个调用，超出返回 `capacity`。最多记住 10,000 个调用 ID，达到
  上限后拒绝下一调用并释放实例，不驱逐旧 ID 后重新执行。可在构造时调整这两个上限；
  恢复服务需要宿主创建新实例，新实例不共享去重历史。
- 断线取消本地等待，结果不向新连接回传。Socket.IO 恢复连接后重新注册定义，注册 ACK
  完整核对前不 ready；从不重放业务调用。认证/注册错误、明确的 namespace 拒绝停止自动恢复，宿主处理后调用 retry。
  普通网络连接错误保持 Socket.IO 自动恢复，不需要宿主编写重连循环。
- dispose 同步停止新分发、清理本地等待与监听器、尽力发送 revoke 并关闭连接。
  关闭前的结果 ACK 不保证送达；Server 的断连清理是最终注销依据。
- `getSnapshot` 是不含参数、结果、认证材料的不可变状态，提供连接错误、活动调用数与
  最近调用错误。宿主订阅异常不会中断其他订阅或调用清理。

## 分层、兼容与验证边界

Protocol 定义通用端口，Runtime 拥有调用去重与生命周期，Gateway 校验真实 Socket.IO
报文并持有认证和计时设施，Headless 门面只组合公开 API。`createRemoteToolClient` 也可
使用其他实现 `RemoteToolTransport` 的适配器；`MemoryRemoteToolTransport` 提供可控
注册确认、时间推进和调用输入用于测试。未启用 RemoteTool 的聊天消费者行为不变。

新增 `SessionOperation` 成员 `remote-tool`；对 operation 做穷尽检查的宿主须补充这一
分支，按同一 Robot 身份提供适用于 `/remote-tool` 的短期材料。

已核对 Server 源码基线 `6acf3100` 和 namespace/docs 无差异的 `236d7c1b`，不是部署
验证。现有 Server 为同 Robot 所有者可信连接模型，不提供不可信第三方之间的权限隔离。
共享同步 worker Socket.IO transport 的并发限制也仍存在，Provider 并发能力不会修复它。

新增测试从公开 Headless 入口运行真实本地 Socket.IO，覆盖注册、调用、响应、冲突、认证、
断线恢复、超时和释放；打包检查在独立非 Front 消费者中运行
[remote-tool-consumer.ts](remote-tool-consumer.ts)。这些测试不证明尚未交付的 Server
会话归属能力。内置 Ask User 和 React/UI 已接入受控宿主映射；真实 Server 自动会话路由及其联调仍待上游交付。
