import {
  Button,
  ConfigProvider,
  Input,
  Space,
  Spin,
  Tag,
  Typography,
} from "antd";
import { useEffect, useState, useSyncExternalStore } from "react";

import { ChatProvider } from "@turingfocus/chat-react";
import { ChatConversationView, ChatUiShell } from "@turingfocus/chat-ui-antd";

import {
  createMockPlaygroundSession,
  type PlaygroundSession,
} from "./playground-session.js";
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
  const [title, setTitle] = useState("New local conversation");
  const createConversation = () => {
    if (title.trim().length === 0) return;
    void session.createConversation(title);
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
                  ? "PRIVATE LOCAL APP · MEMORY GATEWAY"
                  : "PRIVATE LOCAL APP · TFROBOT GATEWAY"}
              </Typography.Text>
              <Typography.Title level={2}>Chat Kit Playground</Typography.Title>
              <Typography.Paragraph>
                {session.kind === "mock"
                  ? "Exercise the production Runtime, React bindings and Ant Design UI without RobotServer or host application source."
                  : "Exercise the production Runtime, TFRobot Gateway and Ant Design UI against the configured RobotServer."}
              </Typography.Paragraph>
            </div>
            <Space wrap>
              <Tag color={state.connected ? "success" : "error"}>
                {state.connected ? "Connected" : "Disconnected"}
              </Tag>
              <Button disabled={session.kind === "mock"} onClick={onChooseMock}>
                Mock mode
              </Button>
              <Button onClick={onChooseRobotServer}>
                {session.kind === "robotserver"
                  ? "Reconfigure RobotServer"
                  : "RobotServer mode"}
              </Button>
              {onReplace === undefined ? null : (
                <Button onClick={onReplace}>Replace instance</Button>
              )}
            </Space>
          </header>

          <section
            aria-label={
              session.kind === "mock"
                ? "Mock scenarios"
                : "RobotServer operations"
            }
            className="scenario-panel"
          >
            <div className="scenario-heading">
              <div>
                <Typography.Title level={4}>
                  {session.kind === "mock"
                    ? "Mock scenarios"
                    : "RobotServer operations"}
                </Typography.Title>
                <Typography.Text type="secondary">
                  {session.kind === "mock"
                    ? "Every state change is emitted by the Memory Gateway."
                    : "All reads, writes and Socket subscriptions use the active in-memory credential."}
                </Typography.Text>
              </div>
              <Typography.Text aria-live="polite" className="scenario-status">
                {state.status}
              </Typography.Text>
            </div>
            <Space wrap>
              <Button onClick={() => void session.loadHistory()}>
                Load history
              </Button>
              {session.kind === "mock" ? (
                <>
                  <Button onClick={() => session.startStreaming()}>
                    Stream reply
                  </Button>
                  <Button danger onClick={() => void session.interrupt()}>
                    Interrupt run
                  </Button>
                  <Button onClick={() => session.emitServerError()}>
                    Server error
                  </Button>
                  <Button
                    disabled={!state.connected}
                    onClick={() => session.disconnect()}
                  >
                    Disconnect
                  </Button>
                  <Button
                    disabled={state.connected}
                    onClick={() => void session.reconnect()}
                  >
                    Reconnect
                  </Button>
                </>
              ) : (
                <>
                  <Button onClick={() => void session.refresh()}>
                    Refresh conversations
                  </Button>
                  <Button onClick={() => void session.reconnect()}>
                    Reconnect REST and Socket
                  </Button>
                  <Button danger onClick={() => void session.interrupt()}>
                    Interrupt active run
                  </Button>
                  <Button
                    onClick={() => void session.createConversation("")}
                    type="primary"
                  >
                    Create retained test session
                  </Button>
                </>
              )}
            </Space>
            {session.kind === "mock" ? (
              <Space.Compact className="create-row">
                <Input
                  aria-label="New conversation title"
                  onChange={(event) => setTitle(event.target.value)}
                  onPressEnter={createConversation}
                  value={title}
                />
                <Button onClick={createConversation} type="primary">
                  Create conversation
                </Button>
              </Space.Compact>
            ) : null}
          </section>

          <section className="chat-stage">
            <ChatUiShell
              contentState={state.contentState}
              conversationListError={
                state.listError === undefined
                  ? undefined
                  : {
                      message: state.listError,
                      onRetry: () => void session.refresh(),
                    }
              }
              conversationListLoading={state.listLoading}
              conversations={state.conversations}
              header={
                <Typography.Text strong>
                  {session.client.getSnapshot()?.conversation.title ??
                    "Select a conversation"}
                </Typography.Text>
              }
              onConversationSelect={(conversationId) =>
                void session.selectConversation(conversationId)
              }
              pendingConversationId={state.pendingConversationId}
              selectedConversationId={state.selectedConversationId}
              sidebarTitle="Conversations"
            >
              <ChatConversationView getDeadlineAt={deadlineAt} />
            </ChatUiShell>
          </section>
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
      <div aria-label="Loading playground" className="playground-fallback">
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
