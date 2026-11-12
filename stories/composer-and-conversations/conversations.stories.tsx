import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { ChatConversationList } from "@turingfocus/chat-ui-antd";
import { Results, Scene } from "../support/decorators/scene.js";
import { useShowcase } from "../support/decorators/settings.js";
function Conversations({
  state,
}: {
  state: "ready" | "empty" | "loading" | "error";
}) {
  const { labels } = useShowcase();
  const [selected, select] = useState("planning");
  const [action, setAction] = useState("");
  return (
    <Scene
      title="会话列表"
      description="组件负责列表展示和操作回调；重命名、删除确认的完整流程见标准工作区。"
    >
      <div style={{ height: 340 }}>
        <ChatConversationList
          labels={labels}
          loading={state === "loading"}
          items={
            state === "empty"
              ? []
              : [
                  { id: "planning", title: "发布计划讨论" },
                  { id: "review", title: "设计评审与交互确认" },
                ]
          }
          selectedConversationId={selected}
          onSelect={select}
          onRename={(v) => setAction(`rename:${v.id}`)}
          onDelete={(v) => setAction(`delete:${v.id}`)}
          error={
            state === "error"
              ? { message: "无法加载会话", onRetry: () => setAction("retry") }
              : undefined
          }
        />
      </div>
      <Results value={{ selected, action }} />
    </Scene>
  );
}
const meta = {
  title: "输入与会话/会话列表",
  component: Conversations,
  args: { state: "ready" },
} satisfies Meta<typeof Conversations>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Ready: Story = { name: "选择与操作菜单" };
export const Empty: Story = { name: "空列表", args: { state: "empty" } };
export const Loading: Story = { name: "加载中", args: { state: "loading" } };
export const Error: Story = { name: "错误与重试", args: { state: "error" } };
