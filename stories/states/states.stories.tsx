import type { Meta, StoryObj } from "@storybook/react-vite";
import { ChatStateView } from "@turingfocus/chat-ui-antd";
import { useState } from "react";
import { Results, Scene } from "../support/decorators/scene.js";
import { useShowcase } from "../support/decorators/settings.js";
function State({
  kind,
}: {
  kind:
    "loading" | "empty" | "error" | "disconnected" | "capability-unavailable";
}) {
  const { labels } = useShowcase();
  const [retries, retry] = useState(0);
  return (
    <Scene title="内容状态">
      <ChatStateView
        labels={labels}
        state={{ kind, onRetry: () => retry((v) => v + 1) }}
      />
      <Results value={{ retries }} />
    </Scene>
  );
}
const meta = {
  title: "状态与恢复/内容状态",
  component: State,
  args: { kind: "empty" },
} satisfies Meta<typeof State>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Empty: Story = { name: "空内容" };
export const Loading: Story = { name: "加载中", args: { kind: "loading" } };
export const Error: Story = { name: "失败与重试", args: { kind: "error" } };
export const Disconnected: Story = {
  name: "连接中断",
  args: { kind: "disconnected" },
};
export const Capability: Story = {
  name: "能力不可用",
  args: { kind: "capability-unavailable" },
};
