import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  ChatMarkdownContent,
  ChatTimelineItem,
  ChatEventDetail,
  defaultChatRendererRegistry,
} from "@turingfocus/chat-ui-antd";
import {
  markdown,
  message,
  toolEvent,
  unknownEvent,
} from "../support/fixtures/chat.js";
import { Scene } from "../support/decorators/scene.js";
import { useShowcase } from "../support/decorators/settings.js";
function Content({
  kind,
  text,
}: {
  kind:
    | "markdown"
    | "user"
    | "assistant"
    | "tool"
    | "detail"
    | "unknown"
    | "custom";
  text: string;
}) {
  const { labels } = useShowcase();
  const item =
    kind === "tool" || kind === "detail"
      ? toolEvent
      : kind === "unknown" || kind === "custom"
        ? unknownEvent
        : message(text, kind === "user" ? "user" : "assistant");
  const registry =
    kind === "custom"
      ? {
          ...defaultChatRendererRegistry,
          "unknown-event": () => (
            <div role="note">宿主自定义渲染器：已接管未知事件的展示。</div>
          ),
        }
      : defaultChatRendererRegistry;
  return (
    <Scene title="消息与事件内容">
      {kind === "markdown" ? (
        <ChatMarkdownContent>{text}</ChatMarkdownContent>
      ) : kind === "detail" ? (
        <ChatEventDetail item={toolEvent} labels={labels} />
      ) : (
        <ChatTimelineItem item={item} registry={registry} labels={labels} />
      )}
    </Scene>
  );
}
const meta = {
  title: "消息与事件/内容与渲染器",
  component: Content,
  args: { kind: "markdown", text: markdown },
} satisfies Meta<typeof Content>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Markdown: Story = { name: "Markdown、表格与代码" };
export const User: Story = {
  name: "用户消息",
  args: { kind: "user", text: "请帮我整理本周发布计划。" },
};
export const Assistant: Story = {
  name: "助手消息",
  args: { kind: "assistant" },
};
export const Tool: Story = { name: "工具调用与结果", args: { kind: "tool" } };
export const Detail: Story = { name: "工具事件详情", args: { kind: "detail" } };
export const Unknown: Story = {
  name: "未知事件安全降级",
  args: { kind: "unknown" },
};
export const Custom: Story = {
  name: "宿主自定义渲染器",
  args: { kind: "custom" },
};
