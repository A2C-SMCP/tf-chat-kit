import type { Meta, StoryObj } from "@storybook/react-vite";
import { Button, Space } from "antd";
import { ChatProvider } from "@turingfocus/chat-react";
import { ChatConversationView } from "@turingfocus/chat-ui-antd";
import { createChatScene, deadline } from "../support/fixtures/chat.js";
import { Owned, Scene, Resettable } from "../support/decorators/scene.js";
import { useShowcase } from "../support/decorators/settings.js";
function Recovery() {
  const { labels } = useShowcase();
  return (
    <Scene
      title="连接、发送与恢复"
      description="使用真实 Runtime + 内存 Gateway。点击失败开关后发送下一条消息，观察错误与保留草稿；手动断线/恢复可以观察连接提示。"
    >
      <Resettable>
        <Owned create={createChatScene}>
          {(scene) => (
            <Space direction="vertical" style={{ width: "100%" }}>
              <Space wrap>
                <Button onClick={() => scene.memory.controller.disconnect()}>
                  断开连接
                </Button>
                <Button onClick={() => scene.memory.controller.reconnect()}>
                  恢复连接
                </Button>
                <Button
                  onClick={() =>
                    scene.memory.controller.failNext("sendText", {
                      code: "network",
                      message: "演示：本轮发送失败",
                      retryable: true,
                    })
                  }
                >
                  下一次发送失败
                </Button>
              </Space>
              <ChatProvider client={scene.client}>
                <div className="showcase-workspace">
                  <ChatConversationView
                    labels={labels}
                    getDeadlineAt={deadline}
                  />
                </div>
              </ChatProvider>
            </Space>
          )}
        </Owned>
      </Resettable>
    </Scene>
  );
}
const meta = {
  title: "状态与恢复/连接与发送",
  component: Recovery,
} satisfies Meta<typeof Recovery>;
export default meta;
export const Network: StoryObj<typeof meta> = { name: "断线、恢复与发送失败" };
