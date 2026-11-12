import type { Meta, StoryObj } from "@storybook/react-vite";
import { ChatResourceView } from "@turingfocus/chat-ui-antd";
import { Scene } from "../support/decorators/scene.js";
import { useShowcase } from "../support/decorators/settings.js";
function Resource({ kind }: { kind: "image" | "audio" | "video" | "file" }) {
  const { labels } = useShowcase();
  const names = {
    image: "browser.svg",
    audio: "tone.wav",
    video: "clip.webm",
    file: "report.txt",
  };
  return (
    <Scene title="资源预览" description="加载仓库自带的本地资源样本。">
      <ChatResourceView
        labels={labels}
        kind={kind}
        resource={{ uri: `/demo/${names[kind]}`, name: names[kind] }}
      />
    </Scene>
  );
}
const meta = {
  title: "消息与事件/资源预览",
  component: Resource,
  args: { kind: "image" },
} satisfies Meta<typeof Resource>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Image: Story = { name: "图片" };
export const Audio: Story = { name: "音频", args: { kind: "audio" } };
export const Video: Story = { name: "视频", args: { kind: "video" } };
export const File: Story = { name: "文件", args: { kind: "file" } };
