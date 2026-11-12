import type { Meta, StoryObj } from "@storybook/react-vite";
import { Button, Space, Alert } from "antd";
import { useCallback, useSyncExternalStore } from "react";
import {
  InteractionProvider,
  useInteractionQueue,
} from "@turingfocus/chat-react";
import { InteractionCard, InteractionQueue } from "@turingfocus/chat-ui-antd";
import {
  Owned,
  Resettable,
  Results,
  Scene,
} from "../support/decorators/scene.js";
import { useShowcase } from "../support/decorators/settings.js";
import {
  createInteractionScene,
  type InteractionScene,
  type AnswerMode,
} from "../support/scenarios/interaction.js";
import { conversationId } from "../support/fixtures/chat.js";

type DemoProps = {
  multiple: boolean;
  freeText: boolean;
  question: string;
  mode: AnswerMode;
  state:
    | "pending"
    | "submitting"
    | "accepted"
    | "uncertain"
    | "disconnected"
    | "answered"
    | "cancelled"
    | "timeout";
  queue: boolean;
  modal: boolean;
};
function Live({
  scene,
  queue,
  modal,
}: {
  scene: InteractionScene;
  queue: boolean;
  modal: boolean;
}) {
  const { labels } = useShowcase();
  const projection = useInteractionQueue();
  const snapshot = useSyncExternalStore(
    scene.client.subscribe,
    scene.client.getSnapshot,
  );
  const view = queue ? projection.active : snapshot.entries["question-1"];
  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <Space wrap>
        <Button
          onClick={() =>
            scene.transport.request(
              `extra-${scene.transport.pending.size}-${Date.now()}`,
              { seconds: 120, question: "新增的待处理问询" },
            )
          }
        >
          新增问询
        </Button>
        <Button
          onClick={() => scene.transport.observer?.connection("disconnected")}
        >
          模拟断线
        </Button>
        <Button onClick={() => scene.client.retry()}>重连并同步</Button>
        <Button
          onClick={() => {
            if (view) scene.transport.close(view.interactionId, "answered");
          }}
        >
          模拟其他 Tab 已回答
        </Button>
      </Space>
      {view && !modal ? (
        <InteractionCard
          key={view.interactionId}
          view={view}
          connection={snapshot.connection}
          now={snapshot.now}
          labels={labels}
          draft={projection.getDraft(view.interactionId)}
          onDraftChange={(draft) =>
            projection.setDraft(view.interactionId, draft)
          }
          onRespond={projection.respond}
        />
      ) : (
        <Alert
          type="info"
          message={
            modal
              ? "当前活跃问询显示在全局弹窗；关闭弹窗可从右下角重新打开。"
              : "本轮问询已结束，可以新增问题或重置场景。"
          }
        />
      )}
      {queue && (
        <InteractionQueue
          labels={labels}
          inlineConversationId={modal ? undefined : conversationId}
        />
      )}
      <Results
        value={{
          connection: snapshot.connection,
          activeId: snapshot.activeId,
          responses: scene.transport.responses,
          entries: Object.values(snapshot.entries).map((v) => ({
            id: v.interactionId,
            status: v.status,
            terminalReason: v.terminalReason,
            staleReason: v.staleReason,
          })),
        }}
      />
    </Space>
  );
}
export function InteractionDemo(props: DemoProps) {
  const create = useCallback(async () => {
    const scene = await createInteractionScene();
    scene.transport.mode = props.mode;
    scene.transport.request("question-1", {
      multi: props.multiple,
      text: props.freeText,
      question: props.question,
    });
    if (props.queue) {
      scene.transport.request("question-2", { seconds: 400 });
      scene.transport.request("question-3", { seconds: 500, text: true });
    }
    if (props.state === "disconnected")
      scene.transport.observer?.connection("disconnected");
    if (["submitting", "accepted", "uncertain"].includes(props.state)) {
      scene.transport.mode =
        props.state === "submitting"
          ? "hold"
          : props.state === "uncertain"
            ? "missing-ack"
            : "accepted";
      scene.client.respond("question-1", {
        status: "answered",
        answer: "优先支持 Web",
      });
    }
    if (["answered", "cancelled", "timeout"].includes(props.state))
      scene.transport.close("question-1", props.state);
    return scene;
  }, [
    props.multiple,
    props.freeText,
    props.question,
    props.mode,
    props.state,
    props.queue,
  ]);
  return (
    <Scene
      title="Interaction 问询"
      description="使用实际 InteractionClient。提交、倒计时、队列与重连对账均由 Kit 管理；点击按钮可观察状态变化。"
    >
      <Resettable>
        <Owned create={create}>
          {(scene) => (
            <InteractionProvider client={scene.client}>
              <Live scene={scene} queue={props.queue} modal={props.modal} />
            </InteractionProvider>
          )}
        </Owned>
      </Resettable>
    </Scene>
  );
}
const meta = {
  title: "问询交互/Interaction 问询卡片",
  excludeStories: ["InteractionDemo"],
  component: InteractionDemo,
  args: {
    multiple: false,
    freeText: false,
    question: "本次发布应优先支持哪些场景？",
    mode: "normal",
    state: "pending",
    queue: false,
    modal: false,
  },
  argTypes: {
    mode: {
      control: "select",
      options: ["normal", "hold", "missing-ack", "reject", "accepted"],
    },
    state: {
      control: "select",
      options: [
        "pending",
        "submitting",
        "accepted",
        "uncertain",
        "disconnected",
        "answered",
        "cancelled",
        "timeout",
      ],
    },
  },
  parameters: {
    docs: {
      description: {
        component:
          "公共入口：@turingfocus/chat-kit/antd 的 InteractionCard，及 @turingfocus/chat-kit/react 的 InteractionProvider。宿主持有并释放 InteractionClient；本展示在卸载和重置时释放实例。",
      },
    },
  },
} satisfies Meta<typeof InteractionDemo>;
export default meta;
type Story = StoryObj<typeof meta>;
export const SingleChoice: Story = { name: "单选" };
export const MultipleChoice: Story = {
  name: "多选与补充文本",
  args: { multiple: true },
};
export const FreeText: Story = { name: "自由文本", args: { freeText: true } };
export const LongQuestion: Story = {
  name: "长问题与选项",
  args: {
    question:
      "请结合不同宿主的页面宽度、账号隔离、交互时限以及上线计划，选择本次需要优先支持的接入场景。".repeat(
        5,
      ),
    multiple: true,
  },
};
export const Submitting: Story = {
  name: "提交中",
  args: { state: "submitting" },
};
export const Accepted: Story = {
  name: "已接收，等待终态",
  args: { state: "accepted" },
};
export const Uncertain: Story = {
  name: "提交结果待确认",
  args: { state: "uncertain" },
};
export const Disconnected: Story = {
  name: "连接中断",
  args: { state: "disconnected" },
};
export const ResponseRejected: Story = {
  name: "提交失败后保留输入",
  args: { mode: "reject" },
};
export const Answered: Story = { name: "已回答", args: { state: "answered" } };
export const Cancelled: Story = {
  name: "已取消",
  args: { state: "cancelled" },
};
export const TimedOut: Story = { name: "已超时", args: { state: "timeout" } };
