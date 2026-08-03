import {
  Button,
  ConfigProvider,
  Dropdown,
  Input,
  Modal,
  Space,
  Spin,
  Tag,
  Tooltip,
  Typography,
  type MenuProps,
} from "antd";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import type { ChatSnapshot } from "@turingfocus/chat-protocol";
import { ChatProvider, useChatSelector } from "@turingfocus/chat-react";
import { ChatConversationView, ChatUiShell } from "@turingfocus/chat-ui-antd";

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

const NewConversationIcon = () => (
  <svg aria-hidden="true" height="16" viewBox="0 0 16 16" width="16">
    <path
      d="M8 2.5v11M2.5 8h11"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeWidth="1.5"
    />
  </svg>
);

const ConversationHistoryIcon = () => (
  <svg aria-hidden="true" height="16" viewBox="0 0 16 16" width="16">
    <path
      d="M5.25 4h7.5M5.25 8h7.5M5.25 12h7.5"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeWidth="1.4"
    />
    <path
      d="M2.5 3.25a.75.75 0 1 1 0 1.5.75.75 0 0 1 0-1.5Zm0 4a.75.75 0 1 1 0 1.5.75.75 0 0 1 0-1.5Zm0 4a.75.75 0 1 1 0 1.5.75.75 0 0 1 0-1.5Z"
      fill="currentColor"
    />
  </svg>
);

const PlaygroundConversation = ({
  session,
}: {
  readonly session: PlaygroundSession;
}) => {
  const activeRun = useChatSelector(selectActiveRun);
  return (
    <div className="playground-conversation-frame">
      <PlaygroundRunStatus
        onInterrupt={() => void session.interrupt()}
        run={activeRun}
      />
      <ChatConversationView
        className={
          activeRun === null
            ? "playground-conversation"
            : "playground-conversation playground-conversation-has-run"
        }
        defaultEventDetailMode="auto"
        formatTimestamp={formatPlaygroundTimestamp}
        getDeadlineAt={deadlineAt}
        labels={playgroundChatLabels}
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
  const createInFlight = useRef(false);
  const sessionGeneration = useRef(0);

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

  const conversationItems: MenuProps["items"] = state.listLoading
    ? [{ disabled: true, key: "loading", label: "正在加载历史会话…" }]
    : state.listError !== undefined
      ? [{ disabled: true, key: "error", label: state.listError }]
      : state.conversations.length === 0
        ? [{ disabled: true, key: "empty", label: "暂无历史会话" }]
        : state.conversations.map((conversation) => ({
            key: conversation.id,
            label: (
              <Typography.Text
                ellipsis={{ tooltip: conversation.title }}
                style={{ display: "block", maxWidth: 280 }}
              >
                {conversation.title}
              </Typography.Text>
            ),
          }));

  const changeConversation: MenuProps["onClick"] = ({ key }) => {
    if (!state.conversations.some(({ id }) => id === key)) return;
    setConversationHistoryOpen(false);
    void session.selectConversation(key);
  };

  const changeConversationHistoryOpen = (open: boolean) => {
    setConversationHistoryOpen(open);
    if (open) {
      void session.loadConversations();
    }
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
                  <Button danger onClick={() => void session.interrupt()}>
                    中断任务
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
                  <Button danger onClick={() => void session.interrupt()}>
                    中断当前任务
                  </Button>
                </>
              )}
            </Space>
          </section>

          <section className="chat-stage">
            <ChatUiShell
              contentState={state.contentState}
              conversationListLoading={false}
              conversations={[]}
              labels={playgroundChatLabels}
              header={
                <div className="conversation-header">
                  <Typography.Text ellipsis strong>
                    {session.client.getSnapshot()?.conversation.title ??
                      "请选择会话"}
                  </Typography.Text>
                  <Space size={4}>
                    <Tooltip title="新建会话">
                      <Button
                        aria-label="新建会话"
                        icon={<NewConversationIcon />}
                        onClick={() => setCreateConversationOpen(true)}
                        shape="circle"
                        type="text"
                      />
                    </Tooltip>
                    <Dropdown
                      menu={{
                        items: conversationItems,
                        onClick: changeConversation,
                        selectable: true,
                        selectedKeys:
                          state.selectedConversationId === undefined
                            ? []
                            : [state.selectedConversationId],
                      }}
                      onOpenChange={changeConversationHistoryOpen}
                      open={conversationHistoryOpen}
                      placement="bottomRight"
                      trigger={["click"]}
                    >
                      <Tooltip title="历史会话">
                        <Button
                          aria-expanded={conversationHistoryOpen}
                          aria-label="历史会话"
                          icon={<ConversationHistoryIcon />}
                          loading={conversationHistoryOpen && state.listLoading}
                          shape="circle"
                          type="text"
                        />
                      </Tooltip>
                    </Dropdown>
                  </Space>
                </div>
              }
              onConversationSelect={(conversationId) =>
                void session.selectConversation(conversationId)
              }
              pendingConversationId={state.pendingConversationId}
              selectedConversationId={state.selectedConversationId}
              sidebarTitle="会话列表"
              styles={{
                root: {
                  gridTemplateColumns: "minmax(0, 1fr)",
                },
                sidebar: {
                  display: "none",
                },
              }}
            >
              <PlaygroundConversation session={session} />
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
