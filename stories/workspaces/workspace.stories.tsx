import type { Meta, StoryObj } from "@storybook/react-vite";
import { ChatProvider } from "@turingfocus/chat-react";
import {
  ChatWorkspace,
  ChatCompactWorkspace,
  ChatConversationView,
} from "@turingfocus/chat-ui-antd";
import { useCallback } from "react";
import {
  createChatScene,
  conversationId,
  deadline,
} from "../support/fixtures/chat.js";
import { createInteractionScene } from "../support/scenarios/interaction.js";
import { Owned, Resettable, Scene } from "../support/decorators/scene.js";
import { useShowcase } from "../support/decorators/settings.js";
function Workspace({
  compact,
  interaction,
  viewOnly,
}: {
  compact: boolean;
  interaction: boolean;
  viewOnly: boolean;
}) {
  const { labels, locale } = useShowcase();
  const create = useCallback(async () => {
    const chat = await createChatScene();
    const asking = await createInteractionScene();
    if (interaction) asking.transport.request("workspace-question");
    return {
      ...chat,
      asking,
      dispose: async () => {
        asking.dispose();
        await chat.dispose();
      },
    };
  }, [interaction]);
  return (
    <Scene
      title="完整聊天工作区"
      description="可选择会话、发送消息、查看工具详情。数据由内存 Gateway 提供；不会生成真实机器人回复。"
    >
      <Resettable>
        <Owned create={create}>
          {(scene) => (
            <ChatProvider client={scene.client}>
              <div className="showcase-workspace">
                {viewOnly ? (
                  <ChatConversationView
                    getDeadlineAt={deadline}
                    labels={labels}
                  />
                ) : compact ? (
                  <ChatCompactWorkspace
                    locale={locale}
                    getDeadlineAt={deadline}
                    restoredDraft={{ conversationId, text: "" }}
                    interactionClient={interaction ? scene.asking.client : null}
                  />
                ) : (
                  <ChatWorkspace
                    getDeadlineAt={deadline}
                    labels={labels}
                    allowCreate
                    allowDelete
                    allowRename
                    interactionClient={interaction ? scene.asking.client : null}
                  />
                )}
              </div>
            </ChatProvider>
          )}
        </Owned>
      </Resettable>
    </Scene>
  );
}
const meta = {
  title: "聊天工作区/组合体验",
  component: Workspace,
  args: { compact: false, interaction: false, viewOnly: false },
  parameters: {
    docs: {
      description: {
        component:
          "公共入口：@turingfocus/chat-kit/antd 的 ChatWorkspace、ChatCompactWorkspace、ChatConversationView。外层 ChatProvider 注入宿主持有的 ChatClient。组件不负责释放外部 client，本展示在退出时释放。",
      },
    },
  },
} satisfies Meta<typeof Workspace>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Standard: Story = { name: "标准工作区" };
export const Compact: Story = { name: "紧凑工作区", args: { compact: true } };
export const Conversation: Story = {
  name: "单独会话视图",
  args: { viewOnly: true },
};
export const WithInteraction: Story = {
  name: "聊天与问询组合",
  args: { interaction: true },
};
export const CompactInteraction: Story = {
  name: "紧凑工作区与问询",
  args: { compact: true, interaction: true },
};
