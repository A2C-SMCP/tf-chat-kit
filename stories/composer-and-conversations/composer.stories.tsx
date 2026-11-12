import { createUploader } from "../support/scenarios/upload.js";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { useEffect, useMemo, useState } from "react";
import { ChatComposer } from "@turingfocus/chat-ui-antd";
import { Results, Scene, Resettable } from "../support/decorators/scene.js";
import { useShowcase } from "../support/decorators/settings.js";
function Composer({
  disabled,
  enter,
  running,
  upload,
}: {
  disabled: boolean;
  enter: boolean;
  running: boolean;
  upload: "none" | "success" | "failure";
}) {
  const { labels } = useShowcase();
  const uploader = useMemo(
    () => createUploader(upload === "failure"),
    [upload],
  );
  useEffect(
    () => () => {
      void uploader.dispose();
    },
    [uploader],
  );
  const [sent, setSent] = useState<unknown[]>([]);
  return (
    <Scene
      title="输入与发送"
      description="输入内容后发送；结果在下方显示。默认 Ctrl+Enter 发送，Enter 换行。"
    >
      <Resettable onReset={() => setSent([])}>
        <ChatComposer
          attachmentUploader={upload === "none" ? undefined : uploader}
          getDeadlineAt={() => Date.now() + 15_000}
          disabled={disabled}
          disabledReason="当前会话只读"
          labels={labels}
          sendShortcut={enter ? "enter" : "ctrl-enter"}
          onSend={(text, attachments) => {
            setSent((v) => [...v, { text, attachments }]);
            return true;
          }}
          interruptAction={
            running
              ? {
                  onInterrupt: () => {
                    setSent((v) => [...v, { action: "interrupt" }]);
                    return true;
                  },
                }
              : undefined
          }
        />
      </Resettable>
      <Results value={sent} />
    </Scene>
  );
}
const meta = {
  title: "输入与会话/输入框",
  component: Composer,
  args: { disabled: false, enter: false, running: false, upload: "none" },
} satisfies Meta<typeof Composer>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = { name: "默认发送与草稿" };
export const Enter: Story = { name: "Enter 发送", args: { enter: true } };
export const Disabled: Story = { name: "禁用与原因", args: { disabled: true } };
export const Interrupt: Story = { name: "运行中断", args: { running: true } };

export const Attachments: Story = {
  name: "附件上传与取消",
  args: { upload: "success" },
};
export const UploadFailure: Story = {
  name: "上传失败",
  args: { upload: "failure" },
};
