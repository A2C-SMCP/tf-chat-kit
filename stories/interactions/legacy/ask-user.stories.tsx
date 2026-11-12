import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import {
  AskUserInteractionCard,
  AskUserInteractionResultView,
} from "@turingfocus/chat-ui-antd";
import type {
  AskUserInteractionAnswer,
  AskUserInteractionRequest,
} from "@turingfocus/chat-protocol";
import { useShowcase } from "../../support/decorators/settings.js";
import { Resettable, Results, Scene } from "../../support/decorators/scene.js";

function Form({
  multiple,
  freeText,
  multiQuestion,
  disabled,
  defaults,
}: {
  multiple: boolean;
  freeText: boolean;
  multiQuestion: boolean;
  disabled: boolean;
  defaults: boolean;
}) {
  const { labels } = useShowcase();
  const [answer, setAnswer] = useState<AskUserInteractionAnswer>();
  const [discussion, setDiscussion] = useState<unknown>();
  const [draft, setDraft] = useState<AskUserInteractionAnswer>();
  const request: AskUserInteractionRequest = {
    kind: "ask-user",
    conversationId: "legacy-conversation",
    requestId: "legacy-question",
    revision: "1",
    title: "需要你的确认",
    questions: [
      {
        id: "scope",
        prompt: "优先支持哪些宿主？",
        required: true,
        multiple,
        options: freeText
          ? []
          : [
              { label: "Web", value: "web" },
              { label: "Office", value: "office", description: "窄侧栏" },
            ],
        ...(defaults && !freeText
          ? { defaultValue: multiple ? ["web"] : "web" }
          : {}),
      },
      ...(multiQuestion
        ? [
            {
              id: "notes",
              prompt: "补充说明",
              required: false,
              multiple: false,
              options: [],
              placeholder: "请输入需要补充的信息",
            },
          ]
        : []),
    ],
  };
  return (
    <>
      <AskUserInteractionCard
        request={request}
        labels={labels}
        answerDisabled={disabled || answer !== undefined}
        draft={draft?.answers}
        onDraftChange={setDraft}
        onChatAboutThis={setDiscussion}
        onAnswer={async (value) => {
          setAnswer(value);
          return true;
        }}
      />
      {answer && (
        <AskUserInteractionResultView
          result={{
            kind: "ask-user",
            requestId: request.requestId,
            status: answer.action === "cancel" ? "cancelled" : "answered",
            questions: request.questions,
            answers: answer.answers,
          }}
        />
      )}
      <Results value={{ answer, draft, discussion }} />
    </>
  );
}
function LegacyDemo(props: Parameters<typeof Form>[0]) {
  return (
    <Scene
      title="旧 AskUserTool 表单"
      description="兼容旧协议的多问题模型，独立于新 Interaction。可验证必填、提交、取消，以及把问题带回聊天。此处只驱动公共表单回调，不连接旧服务。"
    >
      <Resettable>
        <Form {...props} />
      </Resettable>
    </Scene>
  );
}
const meta = {
  title: "问询交互/旧 AskUserTool（兼容）",
  component: LegacyDemo,
  args: {
    multiple: false,
    freeText: false,
    multiQuestion: false,
    disabled: false,
    defaults: false,
  },
  parameters: {
    docs: {
      description: {
        component:
          "公共入口：@turingfocus/chat-kit/antd 的 AskUserInteractionCard / AskUserInteractionResultView。onAnswer、onDraftChange、onChatAboutThis 由宿主接入；本页展示表单 UI 回调。",
      },
    },
  },
} satisfies Meta<typeof LegacyDemo>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Single: Story = { name: "单选与必填校验" };
export const Multiple: Story = { name: "多选", args: { multiple: true } };
export const Text: Story = { name: "自由文本", args: { freeText: true } };
export const MultipleQuestions: Story = {
  name: "多个问题与就此讨论",
  args: { multiQuestion: true },
};
export const DefaultValues: Story = {
  name: "默认答案",
  args: { defaults: true, multiple: true },
};
export const Unavailable: Story = {
  name: "禁止回答",
  args: { disabled: true },
};
