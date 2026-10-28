# LLM 中间消息展示契约

关联 [tf-chat-kit #162](https://github.com/A2C-SMCP/tf-chat-kit/issues/162) 与
[TFRS-641](https://turingfocus.atlassian.net/browse/TFRS-641)。

## 最终确认的 Server 规则

沿用现有事件形状，不要求新增字段：LLM 有生成正文时，以正文作为事件 `content`；
没有生成正文时不发送对应的成功 LLM event，也不以 `tool_calls=[...]` 兜底。
工具事件仍使用原来的工具通道。历史读取与实时事件应遵循同一规则，失败和中断仍需独立可见。
Server 工作项的交付与部署须单独核验，本仓库改动不代表线上 Server 已采用该规则。

此前新增 `generatedTexts` 的本地 Server 实验代码已按用户要求撤回，不作为接入前提。
Kit 不按字符串前缀猜测或删除现有的工具名摘要；旧 Server 已保存的这些 LLM 内容仍会显示。

## Kit 展示

所有 LLM 类型事件按中间消息展示安全 Markdown，以浅色背景和边线区分。
没有文本的成功事件默认不显示；运行中和失败事件仍保留状态与错误，宿主 renderer 优先。
消息超过五行高度时默认预览前三行，支持展开与收起，并随宽度和内容更新重新判断。
事件列表显示时分秒；完整时间保留在悬停提示和详情中。

原有 `role="assistant"` 消息继续按原通道展示，卡片占满宿主允许的内容宽度。
Kit 不按正文相同去重不同事件或消息，最终 LLM event 与 assistant 的归属规则需由 Server 明确。

## 可选兼容字段与验证边界

Kit 保留本轮早期实验的可选 `generatedTexts` 读取能力，仅作为兼容扩展：
有效数组存在时优先按最新明确提供该字段的 transition 展示；缺失时使用现有 `content` 映射的正文。
显式空数组表示没有生成正文。其他场景或非法字段不改变普通事件 fallback。
不拼接重复投递或状态转换，不从工具参数、推理或输入回显推测生成正文。
该字段不是正式 Server 的必需契约，也不要求同步部署支持它的 Server。

Gateway、Protocol 和缓存继续执行既有凭据清理；缓存仅保留显示投影，不恢复发送权限或连接保证。
此变更不包含数据库迁移、鉴权 scope、后台轮询或新的流式打字机协议。

`tests/chat-generated-text.integration.test.ts` 使用受控 DTO 经本地真实 HTTP/Socket.IO 验证
可选字段兼容、历史重载与重复事件；`fixtures/tfrs-generated-text.json` 是早期实验的脱敏合成样本，
不是线上实际响应或部署证明。普通 `content` 的中间消息、折叠、事件详情与完整 Manager 流程
由当前 UI 和 Playground 浏览器测试验证。Office WebView 与真实部署仍需单独验收。
