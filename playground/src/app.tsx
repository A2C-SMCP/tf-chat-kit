import {
  Button,
  ConfigProvider,
  Input,
  Modal,
  Space,
  Spin,
  Tag,
  Typography,
} from "antd";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import type { ChatSnapshot } from "@turingfocus/chat-protocol";
import { ChatProvider, useChatSelector } from "@turingfocus/chat-react";
import {
  ChatConversationView,
  ChatUiShell,
  type ChatCompactNavigationConfig,
} from "@turingfocus/chat-ui-antd";

import {
  createMockPlaygroundSession,
  type PlaygroundSession,
} from "./playground-session.js";
import { playgroundChatLabels } from "./playground-zh-cn.js";
import {
  formatPlaygroundTimestamp,
  PlaygroundRunStatus,
  playgroundRenderers,
} from "./playground-localization.js";
import {
  readPlaygroundEventDetailSplitRatio,
  writePlaygroundEventDetailSplitRatio,
} from "./playground-layout-preferences.js";
import { RobotServerConnectionPanel } from "./robotserver-panel.js";
import {
  createRobotServerPlaygroundSession,
  type RobotServerConnectionConfig,
} from "./robotserver-session.js";

export interface PlaygroundAppProps {
  readonly createSession?: (() => PlaygroundSession) | undefined;
  readonly createRobotServerSession?:
    ((config: RobotServerConnectionConfig) => PlaygroundSession) | undefined;
}

const deadlineAt = (): number => Date.now() + 5_000;
const selectActiveRun = (snapshot: ChatSnapshot | null) =>
  snapshot?.run ?? null;

const PlaygroundConversation = ({
  eventDetailSplitRatio,
  onEventDetailSplitRatioChange,
}: {
  readonly eventDetailSplitRatio: number;
  readonly onEventDetailSplitRatioChange: (ratio: number) => void;
}) => {
  const activeRun = useChatSelector(selectActiveRun);
  return (
    <div className="playground-conversation-frame">
      <PlaygroundRunStatus run={activeRun} />
      <ChatConversationView
        className={
          activeRun === null
            ? "playground-conversation"
            : "playground-conversation playground-conversation-has-run"
        }
        defaultEventDetailMode="auto"
        eventDetailSplitRatio={eventDetailSplitRatio}
        formatTimestamp={formatPlaygroundTimestamp}
        getDeadlineAt={deadlineAt}
        labels={playgroundChatLabels}
        onEventDetailSplitRatioChange={onEventDetailSplitRatioChange}
        renderers={playgroundRenderers}
        style={{ flex: 1, height: "auto" }}
      />
    </div>
  );
};

const PlaygroundWorkspace = ({
  onChooseMock,
  onChooseRobotServer,
  onReplace,
  session,
}: {
  readonly onChooseMock: () => void;
  readonly onChooseRobotServer: () => void;
  readonly onReplace?: (() => void) | undefined;
  readonly session: PlaygroundSession;
}) => {
  const state = useSyncExternalStore(
    session.subscribe,
    session.getState,
    session.getState,
  );
  const [conversationHistoryOpen, setConversationHistoryOpen] = useState(false);
  const [createConversationOpen, setCreateConversationOpen] = useState(false);
  const [creatingConversation, setCreatingConversation] = useState(false);
  const [title, setTitle] = useState("新建本地会话");
  const [eventDetailSplitRatio, setEventDetailSplitRatio] = useState(
    readPlaygroundEventDetailSplitRatio,
  );
  const createInFlight = useRef(false);
  const sessionGeneration = useRef(0);

  const changeEventDetailSplitRatio = useCallback((ratio: number) => {
    setEventDetailSplitRatio(ratio);
    writePlaygroundEventDetailSplitRatio(ratio);
  }, []);

  useEffect(() => {
    sessionGeneration.current += 1;
    createInFlight.current = false;
    setConversationHistoryOpen(false);
    setCreateConversationOpen(false);
    setCreatingConversation(false);
    setTitle("新建本地会话");
  }, [session]);

  const createConversation = async () => {
    const nextTitle = title.trim();
    if (
      createInFlight.current ||
      (session.kind === "mock" && nextTitle.length === 0)
    ) {
      return;
    }
    const generation = sessionGeneration.current;
    createInFlight.current = true;
    setCreatingConversation(true);
    try {
      const created = await session.createConversation(
        session.kind === "mock" ? nextTitle : "",
      );
      if (generation === sessionGeneration.current && created) {
        setCreateConversationOpen(false);
      }
    } finally {
      if (generation === sessionGeneration.current) {
        createInFlight.current = false;
        setCreatingConversation(false);
      }
    }
  };

  const conversationTitle =
    session.client.getSnapshot()?.conversation.title ?? "请选择会话";

  const compactNavigation: ChatCompactNavigationConfig = {
    conversationTitle,
    conversationHistoryOpen,
    conversationHistoryError: state.listError,
    conversationHistoryItems: state.conversations.map((c) => ({
      id: c.id,
      title: c.title,
    })),
    conversationHistoryLoading: state.listLoading,
    onConversationHistoryOpenChange: (open) => {
      setConversationHistoryOpen(open);
      if (open) {
        void session.loadConversations();
      }
    },
    onNewConversation: () => setCreateConversationOpen(true),
  };

  return (
    <ConfigProvider
      theme={{
        token: {
          borderRadius: 10,
          colorPrimary: "#2563eb",
          colorText: "#172033",
        },
      }}
    >
      <ChatProvider client={session.client}>
        <main className="playground-page">
          <header className="playground-hero">
            <div>
              <Typography.Text className="eyebrow">
                {session.kind === "mock"
                  ? "本地私有应用 · 内存网关"
                  : "本地私有应用 · TFROBOT 网关"}
              </Typography.Text>
              <Typography.Title level={2}>Chat Kit 调试台</Typography.Title>
              <Typography.Paragraph>
                {session.kind === "mock"
                  ? "无需 RobotServer 或宿主应用源码，即可调试正式 Runtime、React 绑定和 Ant Design 界面。"
                  : "使用已配置的 RobotServer 调试正式 Runtime、TFRobot Gateway 和 Ant Design 界面。"}
              </Typography.Paragraph>
            </div>
            <Space wrap>
              <Tag color={state.connected ? "success" : "error"}>
                {state.connected ? "已连接" : "已断开"}
              </Tag>
              <Button disabled={session.kind === "mock"} onClick={onChooseMock}>
                Mock 模式
              </Button>
              <Button onClick={onChooseRobotServer}>
                {session.kind === "robotserver"
                  ? "重新配置 RobotServer"
                  : "RobotServer 模式"}
              </Button>
              {onReplace === undefined ? null : (
                <Button onClick={onReplace}>重建实例</Button>
              )}
            </Space>
          </header>

          <section
            aria-label={
              session.kind === "mock" ? "Mock 场景" : "RobotServer 操作"
            }
            className="scenario-panel"
          >
            <div className="scenario-heading">
              <div>
                <Typography.Title level={4}>
                  {session.kind === "mock" ? "Mock 场景" : "RobotServer 操作"}
                </Typography.Title>
                <Typography.Text type="secondary">
                  {session.kind === "mock"
                    ? "每次状态变化均由内存网关发出。"
                    : "所有读写与 Socket 订阅都使用当前内存中的凭据。"}
                </Typography.Text>
              </div>
              <Typography.Text aria-live="polite" className="scenario-status">
                {state.status}
              </Typography.Text>
            </div>
            <Space wrap>
              <Button onClick={() => void session.loadHistory()}>
                加载更早消息
              </Button>
              {session.kind === "mock" ? (
                <>
                  <Button onClick={() => session.startStreaming()}>
                    流式回复
                  </Button>
                  <Button onClick={() => session.emitServerError()}>
                    服务端错误
                  </Button>
                  <Button
                    disabled={!state.connected}
                    onClick={() => session.disconnect()}
                  >
                    断开连接
                  </Button>
                  <Button
                    disabled={state.connected}
                    onClick={() => void session.reconnect()}
                  >
                    重新连接
                  </Button>
                </>
              ) : (
                <>
                  <Button onClick={() => void session.refresh()}>
                    刷新会话
                  </Button>
                  <Button onClick={() => void session.reconnect()}>
                    重连 REST 与 Socket
                  </Button>
                </>
              )}
            </Space>
          </section>

          <section className="chat-stage">
            <ChatUiShell
              compactNavigation={compactNavigation}
              contentState={state.contentState}
              conversationListLoading={false}
              conversations={[]}
              labels={playgroundChatLabels}
              navigationMode="compact"
              onConversationSelect={(conversationId) =>
                void session.selectConversation(conversationId)
              }
              pendingConversationId={state.pendingConversationId}
              selectedConversationId={state.selectedConversationId}
              sidebarTitle="会话列表"
            >
              <PlaygroundConversation
                eventDetailSplitRatio={eventDetailSplitRatio}
                onEventDetailSplitRatioChange={changeEventDetailSplitRatio}
              />
            </ChatUiShell>
          </section>
          <Modal
            cancelButtonProps={{ disabled: creatingConversation }}
            cancelText="取消"
            closable={!creatingConversation}
            confirmLoading={creatingConversation}
            keyboard={!creatingConversation}
            maskClosable={!creatingConversation}
            okButtonProps={{
              disabled: session.kind === "mock" && title.trim().length === 0,
            }}
            okText="确认新建"
            onCancel={() => setCreateConversationOpen(false)}
            onOk={() => void createConversation()}
            open={createConversationOpen}
            title="新建会话"
          >
            {session.kind === "mock" ? (
              <Input
                aria-label="新会话标题"
                autoFocus
                disabled={creatingConversation}
                onChange={(event) => setTitle(event.target.value)}
                onPressEnter={() => void createConversation()}
                value={title}
              />
            ) : (
              <Typography.Paragraph style={{ marginBottom: 0 }}>
                将创建并保留一个带当前时间标识的 Playground 测试会话。
              </Typography.Paragraph>
            )}
          </Modal>
        </main>
      </ChatProvider>
    </ConfigProvider>
  );
};

export const PlaygroundApp = ({
  createSession = createMockPlaygroundSession,
  createRobotServerSession = createRobotServerPlaygroundSession,
}: PlaygroundAppProps) => {
  const [mode, setMode] = useState<"mock" | "robotserver">("mock");
  const [sessionPlan, setSessionPlan] = useState<{
    readonly create: () => PlaygroundSession;
    readonly kind: "mock" | "robotserver";
  } | null>(() => ({ create: createSession, kind: "mock" }));
  const [session, setSession] = useState<PlaygroundSession | null>(null);

  useEffect(() => {
    if (sessionPlan === null) {
      setSession(null);
      return;
    }
    const next = sessionPlan.create();
    setSession(next);
    void next.start();
    return () => {
      setSession((current) => (current === next ? null : current));
      void next.dispose();
    };
  }, [sessionPlan]);

  const chooseMock = () => {
    setMode("mock");
    setSessionPlan({ create: createSession, kind: "mock" });
  };
  const chooseRobotServer = () => {
    setMode("robotserver");
    setSessionPlan(null);
  };
  const connectRobotServer = (config: RobotServerConnectionConfig) => {
    setMode("robotserver");
    setSessionPlan({
      create: () => createRobotServerSession(config),
      kind: "robotserver",
    });
  };

  if (mode === "robotserver" && sessionPlan?.kind !== "robotserver") {
    return (
      <RobotServerConnectionPanel
        onCancel={chooseMock}
        onConnect={connectRobotServer}
      />
    );
  }

  if (session === null) {
    return (
      <div aria-label="正在加载调试台" className="playground-fallback">
        <Spin size="large" />
      </div>
    );
  }

  return (
    <PlaygroundWorkspace
      onChooseMock={chooseMock}
      onChooseRobotServer={chooseRobotServer}
      onReplace={
        session.kind === "mock"
          ? () =>
              setSessionPlan({
                create: createSession,
                kind: "mock",
              })
          : undefined
      }
      session={session}
    />
  );
};
