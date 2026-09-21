import {
  capabilityScenarios,
  type CapabilityScenario,
} from "./capability-scenarios.js";
import {
  Alert,
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
  type ReactNode,
} from "react";

import type { ChatSnapshot } from "@turingfocus/chat-protocol";
import {
  ChatDocumentSourceProvider,
  ChatResourceProvider,
  ChatProvider,
  useChatSelector,
} from "@turingfocus/chat-react";
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
  createPlaygroundAuthClient,
  PlaygroundAuthGate,
} from "./playground-auth.js";
import {
  loadManagerRobotDirectory,
  type PlaygroundRobotDescriptor,
} from "./manager-directory.js";
import { createManagerRobotServerConnection } from "./manager-robotserver-session.js";
import {
  createAuthClient,
  type AuthClient,
} from "../../packages/chat-auth/src/headless.js";
import { createTfRobotAuthTransport } from "../../packages/chat-auth/src/tfrobot.js";
import {
  createRobotServerPlaygroundSession,
  ROBOTSERVER_TEST_CONVERSATION_PREFIX,
  type RobotServerConnectionConfig,
} from "./robotserver-session.js";

declare const __TF_CHAT_PLAYGROUND_ALLOWED_SERVER_ORIGINS__: string;

const allowedManagerServerOrigins = (): readonly string[] =>
  (typeof __TF_CHAT_PLAYGROUND_ALLOWED_SERVER_ORIGINS__ === "string"
    ? __TF_CHAT_PLAYGROUND_ALLOWED_SERVER_ORIGINS__
    : ""
  )
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

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
  experience = "full",
  onChooseMock,
  onChooseRobotServer,
  onReplace,
  session,
}: {
  readonly experience?: "full" | "quick" | undefined;
  readonly onChooseMock?: (() => void) | undefined;
  readonly onChooseRobotServer?: (() => void) | undefined;
  readonly onReplace?: (() => void) | undefined;
  readonly session: PlaygroundSession;
}) => {
  const state = useSyncExternalStore(
    session.subscribe,
    session.getState,
    session.getState,
  );
  const [activeCapability, setActiveCapability] =
    useState<CapabilityScenario>();
  const [conversationHistoryOpen, setConversationHistoryOpen] = useState(false);
  const [createConversationOpen, setCreateConversationOpen] = useState(false);
  const [creatingConversation, setCreatingConversation] = useState(false);
  const [deleteConversationOpen, setDeleteConversationOpen] = useState(false);
  const [deletingConversation, setDeletingConversation] = useState(false);
  const [renameConversationOpen, setRenameConversationOpen] = useState(false);
  const [renamingConversation, setRenamingConversation] = useState(false);
  const [renameTitle, setRenameTitle] = useState("");
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
    setActiveCapability(undefined);
    sessionGeneration.current += 1;
    createInFlight.current = false;
    setConversationHistoryOpen(false);
    setCreateConversationOpen(false);
    setCreatingConversation(false);
    setDeleteConversationOpen(false);
    setDeletingConversation(false);
    setRenameConversationOpen(false);
    setRenamingConversation(false);
    setRenameTitle("");
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
  const selectedConversation = state.conversations.find(
    ({ id }) => id === state.selectedConversationId,
  );
  const canManageRobotServerTestConversation =
    session.kind === "robotserver" &&
    selectedConversation?.title.startsWith(
      ROBOTSERVER_TEST_CONVERSATION_PREFIX,
    ) === true;

  const renameSelectedConversation = async () => {
    if (selectedConversation === undefined || renamingConversation) return;
    setRenamingConversation(true);
    try {
      const renamed = await session.renameConversation(
        selectedConversation.id,
        renameTitle,
      );
      if (renamed) setRenameConversationOpen(false);
    } finally {
      setRenamingConversation(false);
    }
  };

  const deleteSelectedConversation = async () => {
    if (selectedConversation === undefined || deletingConversation) return;
    setDeletingConversation(true);
    try {
      const deleted = await session.deleteConversation(selectedConversation.id);
      if (deleted) setDeleteConversationOpen(false);
    } finally {
      setDeletingConversation(false);
    }
  };

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
      <ChatProvider
        attachmentUploader={session.attachmentUploader}
        client={session.client}
      >
        <ChatResourceProvider
          port={
            session.kind === "mock" ? session.demoPorts.resources : undefined
          }
          scope={session}
        >
          <ChatDocumentSourceProvider
            source={
              session.kind === "mock" ? session.demoPorts.documents : undefined
            }
            scope={session}
          >
            <div className="playground-page">
              <header className="playground-hero">
                <div>
                  <Typography.Text className="eyebrow">
                    {session.kind === "mock"
                      ? "本地私有应用 · 内存网关"
                      : "本地私有应用 · TFROBOT 网关"}
                  </Typography.Text>
                  <Typography.Title level={2}>
                    {experience === "quick"
                      ? "当前机器人对话"
                      : "Chat Kit 调试台"}
                  </Typography.Title>
                  <Typography.Paragraph>
                    {experience === "quick"
                      ? "使用当前 Manager 账号与选中机器人进行最小对话验证。"
                      : session.kind === "mock"
                        ? "无需 RobotServer 或宿主应用源码，即可调试正式 Runtime、React 绑定和 Ant Design 界面。"
                        : "使用已配置的 RobotServer 调试正式 Runtime、TFRobot Gateway 和 Ant Design 界面。"}
                  </Typography.Paragraph>
                </div>
                <Space wrap>
                  <Tag color={state.connected ? "success" : "error"}>
                    {state.connected ? "已连接" : "已断开"}
                  </Tag>
                  {experience === "full" ? (
                    <>
                      <Button
                        disabled={
                          session.kind === "mock" || onChooseMock === undefined
                        }
                        onClick={onChooseMock}
                      >
                        Mock 模式
                      </Button>
                      <Button
                        disabled={onChooseRobotServer === undefined}
                        onClick={onChooseRobotServer}
                      >
                        {session.kind === "robotserver"
                          ? "重新配置 RobotServer"
                          : "RobotServer 模式"}
                      </Button>
                    </>
                  ) : (
                    <Tag color="purple">Manager 当前机器人</Tag>
                  )}
                  {onReplace === undefined ? null : (
                    <Button onClick={onReplace}>重建实例</Button>
                  )}
                </Space>
              </header>

              <section
                aria-label={
                  experience === "quick"
                    ? "当前机器人连接"
                    : session.kind === "mock"
                      ? "Mock 场景"
                      : "RobotServer 操作"
                }
                className="scenario-panel"
              >
                <div className="scenario-heading">
                  <div>
                    <Typography.Title level={4}>
                      {experience === "quick"
                        ? "当前机器人连接"
                        : session.kind === "mock"
                          ? "Mock 场景"
                          : "RobotServer 操作"}
                    </Typography.Title>
                    <Typography.Text type="secondary">
                      {experience === "quick"
                        ? "只保留连接状态和重连操作，便于快速确认当前机器人可用。"
                        : session.kind === "mock"
                          ? "每次状态变化均由内存网关发出。"
                          : "所有读写与 Socket 订阅都使用当前内存中的凭据。"}
                    </Typography.Text>
                  </div>
                  <Typography.Text
                    aria-live="polite"
                    className="scenario-status"
                  >
                    {state.status}
                  </Typography.Text>
                </div>
                <Space wrap>
                  {experience === "quick" ? (
                    <Button onClick={() => void session.reconnect()}>
                      重连当前机器人
                    </Button>
                  ) : session.kind === "mock" ? (
                    <>
                      <Button onClick={() => void session.loadHistory()}>
                        加载更早消息
                      </Button>
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
                      <Button onClick={() => void session.loadHistory()}>
                        加载更早消息
                      </Button>
                      <Button onClick={() => void session.refresh()}>
                        刷新会话
                      </Button>
                      <Button onClick={() => void session.reconnect()}>
                        重连 REST 与 Socket
                      </Button>
                      {experience === "full" &&
                      canManageRobotServerTestConversation ? (
                        <>
                          <Button
                            onClick={() => {
                              setRenameTitle(selectedConversation?.title ?? "");
                              setRenameConversationOpen(true);
                            }}
                          >
                            重命名测试会话
                          </Button>
                          <Button
                            danger
                            onClick={() => setDeleteConversationOpen(true)}
                          >
                            删除测试会话
                          </Button>
                        </>
                      ) : null}
                    </>
                  )}
                </Space>
              </section>

              {experience === "full" && session.kind === "mock" && (
                <section className="scenario-panel" aria-label="能力演示">
                  <div>
                    <Typography.Title level={4} style={{ margin: 0 }}>
                      能力演示
                    </Typography.Title>
                    <Typography.Text type="secondary">
                      选择一组示例替换当前演示记录。输入草稿仍保留；“重建实例”可恢复初始状态。
                    </Typography.Text>
                  </div>
                  <Space wrap>
                    {capabilityScenarios.map((scenario) => (
                      <Button
                        key={scenario.id}
                        type={
                          activeCapability === scenario.id
                            ? "primary"
                            : "default"
                        }
                        disabled={!state.connected}
                        onClick={() => {
                          session.showCapability(scenario.id);
                          setActiveCapability(scenario.id);
                        }}
                      >
                        {scenario.title}
                      </Button>
                    ))}
                  </Space>
                  {activeCapability && (
                    <Typography.Paragraph
                      style={{ margin: 0 }}
                      aria-live="polite"
                    >
                      {
                        capabilityScenarios.find(
                          ({ id }) => id === activeCapability,
                        )?.hint
                      }
                    </Typography.Paragraph>
                  )}
                  {activeCapability === "inspection" && (
                    <Button
                      disabled={!state.connected}
                      onClick={() => session.showCapability("inspection", true)}
                    >
                      追加事件
                    </Button>
                  )}
                </section>
              )}

              <section className="chat-stage">
                <ChatUiShell
                  compactNavigation={
                    experience === "quick" ? undefined : compactNavigation
                  }
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
                  disabled:
                    session.kind === "mock" && title.trim().length === 0,
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
                    将创建一个带当前时间标识的 Playground
                    测试会话；正常结束时会按精确 ID 自动清理。
                  </Typography.Paragraph>
                )}
              </Modal>
              <Modal
                cancelText="取消"
                confirmLoading={renamingConversation}
                okButtonProps={{
                  disabled: !renameTitle
                    .trim()
                    .startsWith(ROBOTSERVER_TEST_CONVERSATION_PREFIX),
                }}
                okText="确认重命名"
                onCancel={() => setRenameConversationOpen(false)}
                onOk={() => void renameSelectedConversation()}
                open={renameConversationOpen}
                title="重命名测试会话"
              >
                <Input
                  aria-label="测试会话标题"
                  disabled={renamingConversation}
                  onChange={(event) => setRenameTitle(event.target.value)}
                  onPressEnter={() => void renameSelectedConversation()}
                  value={renameTitle}
                />
              </Modal>
              <Modal
                cancelText="取消"
                confirmLoading={deletingConversation}
                okButtonProps={{ danger: true }}
                okText="确认删除"
                onCancel={() => setDeleteConversationOpen(false)}
                onOk={() => void deleteSelectedConversation()}
                open={deleteConversationOpen}
                title="删除测试会话"
              >
                仅删除当前带 {ROBOTSERVER_TEST_CONVERSATION_PREFIX}{" "}
                前缀的测试会话。
              </Modal>
            </div>
          </ChatDocumentSourceProvider>
        </ChatResourceProvider>
      </ChatProvider>
    </ConfigProvider>
  );
};

type PlaygroundModule = "home" | "chatkit" | "manager";

interface PlaygroundSessionPlan {
  readonly create: () => PlaygroundSession;
  readonly kind: "mock" | "robotserver";
}

const PlaygroundModuleFrame = ({
  children,
  description,
  onBack,
  title,
}: {
  readonly children: ReactNode;
  readonly description: string;
  readonly onBack: () => void;
  readonly title: string;
}) => (
  <main className="playground-module-shell">
    <header className="playground-module-header">
      <Button onClick={onBack}>返回 Playground</Button>
      <div>
        <Typography.Text className="eyebrow">本地私有应用</Typography.Text>
        <Typography.Title level={2}>{title}</Typography.Title>
        <Typography.Paragraph type="secondary">
          {description}
        </Typography.Paragraph>
      </div>
    </header>
    {children}
  </main>
);

const PlaygroundLanding = ({
  onEnterChatKit,
  onEnterManager,
}: {
  readonly onEnterChatKit: () => void;
  readonly onEnterManager: () => void;
}) => (
  <main className="playground-page playground-landing">
    <section className="playground-landing-hero">
      <Typography.Text className="eyebrow">
        本地私有应用 · tf-chat-kit Playground
      </Typography.Text>
      <Typography.Title level={1}>选择调试模块</Typography.Title>
      <Typography.Paragraph type="secondary">
        ChatKit 调试和 Manager
        登录目录是两条独立工作流。先选择你要验证的内容，避免登录、路由和聊天能力互相干扰。
      </Typography.Paragraph>
    </section>
    <section className="playground-module-grid" aria-label="Playground 模块">
      <article
        aria-label="Chat Kit 调试模块"
        className="playground-module-card"
        onClick={onEnterChatKit}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onEnterChatKit();
          }
        }}
        role="button"
        tabIndex={0}
      >
        <Typography.Title level={3}>Chat Kit 调试</Typography.Title>
        <Typography.Paragraph type="secondary">
          专注 Runtime、React、Ant Design UI 和 Gateway。进入后可选择 Mock
          或手工连接真实 RobotServer。
        </Typography.Paragraph>
        <button
          className="playground-module-card-link"
          onClick={(event) => {
            event.stopPropagation();
            onEnterChatKit();
          }}
          type="button"
        >
          进入 Chat Kit →
        </button>
      </article>
      <article
        aria-label="登录与机器人模块"
        className="playground-module-card"
        onClick={onEnterManager}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onEnterManager();
          }
        }}
        role="button"
        tabIndex={0}
      >
        <Typography.Title level={3}>登录与机器人</Typography.Title>
        <Typography.Paragraph type="secondary">
          专注 Manager
          登录、staging/正式/自定义环境、组织切换、机器人切换，以及当前机器人最小对话验证。
        </Typography.Paragraph>
        <button
          className="playground-module-card-link"
          onClick={(event) => {
            event.stopPropagation();
            onEnterManager();
          }}
          type="button"
        >
          进入登录与机器人 →
        </button>
      </article>
    </section>
  </main>
);

const ManagerQuickChat = ({
  onConnect,
  robot,
  session,
}: {
  readonly onConnect: () => Promise<void>;
  readonly robot: PlaygroundRobotDescriptor | undefined;
  readonly session: PlaygroundSession | null;
}) => {
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setError(null);
  }, [robot?.id]);

  if (session !== null) {
    return (
      <PlaygroundWorkspace
        experience="quick"
        onReplace={undefined}
        session={session}
      />
    );
  }
  return (
    <section className="manager-quick-panel" aria-label="当前机器人快速对话">
      <div>
        <Typography.Title level={3}>当前机器人快速对话</Typography.Title>
        <Typography.Paragraph type="secondary">
          登录和选择完成后，只建立一条最小 RobotServer
          会话，用于确认当前机器人可访问、可收发消息；完整能力演示请进入 Chat
          Kit 调试。
        </Typography.Paragraph>
      </div>
      {robot === undefined ? (
        <Typography.Text type="secondary">
          请先在上方选择一个机器人。
        </Typography.Text>
      ) : (
        <div className="manager-quick-selection">
          <Typography.Text strong>{robot.name}</Typography.Text>
          <Typography.Text type="secondary">
            Manager employeeId：{robot.managerEmployeeId ?? "未返回"}
          </Typography.Text>
          <Typography.Text type="secondary">
            robotAccountId：{robot.robotAccountId ?? "未返回"}
          </Typography.Text>
          {!robot.canAutoConnect ? (
            <Typography.Text type="warning">
              当前机器人缺少 robotAccountId，无法自动换取 RobotServer 用户
              Token。
            </Typography.Text>
          ) : null}
        </div>
      )}
      {error === null ? null : (
        <Alert
          closable
          message="连接当前机器人失败"
          onClose={() => setError(null)}
          showIcon
          type="error"
          description={error}
        />
      )}
      <Space>
        <Button
          disabled={robot === undefined || !robot.canAutoConnect}
          loading={connecting}
          onClick={() => {
            setConnecting(true);
            setError(null);
            void onConnect()
              .catch((reason: unknown) => {
                setError(
                  reason instanceof Error ? reason.message : String(reason),
                );
              })
              .finally(() => setConnecting(false));
          }}
          type="primary"
        >
          连接当前机器人并开始对话
        </Button>
      </Space>
    </section>
  );
};

export const PlaygroundApp = ({
  createSession = createMockPlaygroundSession,
  createRobotServerSession = createRobotServerPlaygroundSession,
}: PlaygroundAppProps) => {
  const [authClient, setAuthClient] = useState<AuthClient>(
    createPlaygroundAuthClient,
  );
  const authClientRef = useRef(authClient);
  const loginGeneration = useRef(0);
  const managerConnectionGeneration = useRef(0);
  const authDisposeTimer = useRef<ReturnType<typeof setTimeout>>();
  const [managerBaseUrl, setManagerBaseUrl] = useState<string | null>(null);
  const [selectedRobotId, setSelectedRobotId] = useState("research-assistant");
  const [selectedRobot, setSelectedRobot] = useState<
    PlaygroundRobotDescriptor | undefined
  >();
  const [playgroundModule, setPlaygroundModule] =
    useState<PlaygroundModule>("home");
  const [connectionPanelOpen, setConnectionPanelOpen] = useState(false);
  const [sessionPlan, setSessionPlan] = useState<PlaygroundSessionPlan | null>(
    null,
  );
  const [session, setSession] = useState<PlaygroundSession | null>(null);

  useEffect(() => {
    if (authDisposeTimer.current !== undefined) {
      clearTimeout(authDisposeTimer.current);
      authDisposeTimer.current = undefined;
    }
    return () => {
      authDisposeTimer.current = setTimeout(() => {
        void authClientRef.current.dispose();
      }, 0);
    };
  }, []);

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

  const enterChatKit = () => {
    setPlaygroundModule("chatkit");
    setConnectionPanelOpen(false);
    setSessionPlan({ create: createSession, kind: "mock" });
  };
  const enterManager = () => {
    managerConnectionGeneration.current += 1;
    setPlaygroundModule("manager");
    setConnectionPanelOpen(false);
    setSessionPlan(null);
  };
  const backToLanding = () => {
    loginGeneration.current += 1;
    managerConnectionGeneration.current += 1;
    setPlaygroundModule("home");
    setConnectionPanelOpen(false);
    setSessionPlan(null);
  };
  const chooseMock = () => {
    loginGeneration.current += 1;
    setConnectionPanelOpen(false);
    setSessionPlan({ create: createSession, kind: "mock" });
  };
  const chooseRobotServer = () => {
    setConnectionPanelOpen(true);
    setSessionPlan(null);
  };
  const connectRobotServer = (config: RobotServerConnectionConfig) => {
    setConnectionPanelOpen(false);
    setSessionPlan({
      create: () => createRobotServerSession(config),
      kind: "robotserver",
    });
  };
  const connectManagerRobot = async (): Promise<void> => {
    if (managerBaseUrl === null || selectedRobot === undefined) {
      throw new Error("请先登录 Manager 并选择机器人。");
    }
    const generation = managerConnectionGeneration.current;
    const robotId = selectedRobot.id;
    const config = await createManagerRobotServerConnection({
      client: authClient,
      managerBaseUrl,
      robot: selectedRobot,
      proxyOrigin: window.location.origin,
      allowedServerOrigins: allowedManagerServerOrigins(),
    });
    if (
      generation !== managerConnectionGeneration.current ||
      selectedRobot?.id !== robotId
    ) {
      throw new Error("机器人选择已变化，请重新连接当前机器人。");
    }
    connectRobotServer(config);
  };
  const loginWithManager = async (
    environment: "staging" | "production" | "custom",
    baseUrl: string,
    identifier: string,
    password: string,
  ) => {
    const trimmedBaseUrl = baseUrl.trim();
    if (!trimmedBaseUrl || !identifier.trim() || !password)
      throw new Error("请填写 Manager 地址、账号和密码");
    const generation = ++loginGeneration.current;
    managerConnectionGeneration.current += 1;
    const client = createAuthClient({
      // AuthClient only has canonical staging/production scopes; a custom
      // URL uses staging semantics while retaining its explicit transport URL.
      environment: environment === "production" ? "production" : "staging",
      transport: createTfRobotAuthTransport({ baseUrl: trimmedBaseUrl }),
    });
    try {
      await client.login({ identifier: identifier.trim(), password });
      if (generation !== loginGeneration.current) {
        await client.dispose();
        return;
      }
      const previous = authClientRef.current;
      authClientRef.current = client;
      setAuthClient(client);
      setManagerBaseUrl(trimmedBaseUrl.replace(/\/$/u, ""));
      await previous.dispose().catch(() => undefined);
    } catch (error) {
      await client.dispose();
      throw error;
    }
  };
  const loadManagerRobots = useCallback(
    async (
      organizationId: string,
    ): Promise<readonly PlaygroundRobotDescriptor[]> => {
      if (managerBaseUrl === null) return [];
      return loadManagerRobotDirectory(
        authClient,
        managerBaseUrl,
        organizationId,
      );
    },
    [authClient, managerBaseUrl],
  );

  const handleLogout = () => {
    loginGeneration.current += 1;
    managerConnectionGeneration.current += 1;
    setManagerBaseUrl(null);
    setSelectedRobot(undefined);
    setSelectedRobotId("research-assistant");
    setSessionPlan(null);
  };

  const chatKitContent = connectionPanelOpen ? (
    <RobotServerConnectionPanel
      onCancel={chooseMock}
      onConnect={connectRobotServer}
    />
  ) : session === null ? (
    <div aria-label="正在加载调试台" className="playground-fallback">
      <Spin size="large" />
    </div>
  ) : (
    <PlaygroundWorkspace
      onChooseMock={chooseMock}
      onChooseRobotServer={chooseRobotServer}
      session={session}
    />
  );

  if (playgroundModule === "home") {
    return (
      <PlaygroundLanding
        onEnterChatKit={enterChatKit}
        onEnterManager={enterManager}
      />
    );
  }
  if (playgroundModule === "chatkit") {
    return (
      <PlaygroundModuleFrame
        description="独立验证 ChatKit 的 Mock Runtime、React/UI 绑定和真实 RobotServer Gateway。"
        onBack={backToLanding}
        title="Chat Kit 调试"
      >
        {chatKitContent}
      </PlaygroundModuleFrame>
    );
  }
  return (
    <PlaygroundModuleFrame
      description="只处理 Manager 身份、组织、机器人和当前选中机器人的最小对话。"
      onBack={backToLanding}
      title="登录与机器人"
    >
      <PlaygroundAuthGate
        client={authClient}
        onLogout={handleLogout}
        onRealLogin={loginWithManager}
        loadRobots={managerBaseUrl === null ? undefined : loadManagerRobots}
        onSelectionReset={() => {
          managerConnectionGeneration.current += 1;
          setSelectedRobot(undefined);
          setSelectedRobotId("");
          setSessionPlan(null);
        }}
        onSelectionChange={(_organizationId, robot) => {
          managerConnectionGeneration.current += 1;
          setSelectedRobotId(robot.id);
          setSelectedRobot(robot);
          setSessionPlan(null);
        }}
        robotId={selectedRobotId}
      >
        <ManagerQuickChat
          onConnect={connectManagerRobot}
          robot={selectedRobot}
          session={session}
        />
      </PlaygroundAuthGate>
    </PlaygroundModuleFrame>
  );
};
