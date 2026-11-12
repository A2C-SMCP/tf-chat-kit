import type { Meta, StoryObj } from "@storybook/react-vite";
import { InteractionDemo } from "./interaction.stories.js";

const meta = {
  title: "问询交互/Interaction 队列",
  component: InteractionDemo,
  args: {
    multiple: false,
    freeText: false,
    question: "是否确认本次发布计划？",
    mode: "normal",
    state: "pending",
    queue: true,
    modal: false,
  },
  parameters: {
    docs: {
      description: {
        component:
          "公共入口：InteractionProvider + InteractionQueue。单活动/EDF/上限由 Runtime 管理。弹窗收起不等于取消，重新打开后保留草稿。",
      },
    },
  },
} satisfies Meta<typeof InteractionDemo>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Inline: Story = { name: "当前会话内联与多问题排队" };
export const Modal: Story = {
  name: "全局弹窗、收起与草稿保留",
  args: { modal: true, freeText: true },
};
