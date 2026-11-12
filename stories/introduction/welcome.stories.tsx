import type { Meta, StoryObj } from "@storybook/react-vite";
import { Typography, Alert } from "antd";
import { Scene } from "../support/decorators/scene.js";
function Welcome() {
  return (
    <Scene
      title="Chat Kit 组件与交互展示"
      description="从问询开始体验，再查看完整工作区和组件细节。"
    >
      <Alert
        type="info"
        message="无需真实账号。所有问题、消息和结果均为受控演示数据。"
      />
      <Typography.Paragraph>
        侧栏按使用场景分类。问询交互包含新 Interaction 与旧
        AskUserTool；聊天工作区展示真实公共组件组合。
      </Typography.Paragraph>
      <Typography.Paragraph>
        上方工具栏可切换浅色/深色、中文/英文、桌面/380px 侧栏/320px
        窄屏。Controls 可调整组件参数；交互结果面板显示实际回调和 Runtime 状态。
      </Typography.Paragraph>
      <Typography.Paragraph>
        重置场景会销毁旧客户端并创建新实例。源码展示用于 UI 体验，不代表真实
        Server 或独立 npm 消费者验证。
      </Typography.Paragraph>
    </Scene>
  );
}
const meta = { title: "开始使用/展示导航", component: Welcome } satisfies Meta<
  typeof Welcome
>;
export default meta;
export const Guide: StoryObj<typeof meta> = { name: "从这里开始" };
