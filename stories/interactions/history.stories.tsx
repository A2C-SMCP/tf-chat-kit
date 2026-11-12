import type { Meta, StoryObj } from "@storybook/react-vite";
import { InteractionHistoryView } from "@turingfocus/chat-ui-antd";
import { useShowcase } from "../support/decorators/settings.js";
function History({ status, error }: { status: string; error: string }) {
  const { labels } = useShowcase();
  return (
    <InteractionHistoryView
      labels={labels}
      history={{
        kind: "interaction-history",
        interactionId: "historical-1",
        direction: "ask",
        question: "本次发布优先支持哪些场景？",
        status,
        ...(status === "answered"
          ? {
              answer: "Web 和 Office",
              answeredBy: "项目负责人",
              answeredAt: Date.UTC(2026, 10, 11, 8, 30),
            }
          : {}),
        ...(error ? { error } : {}),
      }}
    />
  );
}
const meta = {
  title: "问询交互/历史问询结果",
  component: History,
  args: { status: "answered", error: "" },
} satisfies Meta<typeof History>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Answered: Story = { name: "已回答与作答信息" };
export const Cancelled: Story = {
  name: "已取消",
  args: { status: "cancelled" },
};
export const Unknown: Story = {
  name: "未知终态安全展示",
  args: { status: "future_terminal_reason" },
};
export const Error: Story = {
  name: "失败",
  args: { status: "error", error: "无法完成本次问询" },
};
