import { Alert, Button, Input, Space, Tag, Typography } from "antd";
import { useEffect, useRef, useState } from "react";
import {
  createTFRobotChatClient,
  createTFRobotRemoteToolClient,
  createTFRobotSocketConnection,
  defineRemoteTool,
  isChatLifecycleOperable,
  type ChatClient,
  type RemoteToolClient,
  type TFRobotSocketConnection,
  type TFRobotSocketFactory,
} from "../../packages/chat-kit/src/headless.js";
import {
  EMPTY_SHARED_OBSERVATION,
  SHARED_DEMO_PREFIX,
  SHARED_DEMO_SOCKET_PATH,
  type SharedSocketObservation,
} from "./shared-socket-contract.js";

interface Demo {
  readonly id: string;
  readonly connection: TFRobotSocketConnection;
  readonly observers: { chat: (() => void)[]; tools: (() => void)[] };
  chat: ChatClient | null;
  tools: RemoteToolClient | null;
  stopChat: (() => void) | null;
  stopTools: (() => void) | null;
}
const request = async (
  path: string,
  id?: string,
  method = "GET",
): Promise<unknown> => {
  const response = await fetch(`${SHARED_DEMO_PREFIX}${path}`, {
    method,
    signal: AbortSignal.timeout(6_000),
    headers: id ? { Authorization: `Bearer ${id}` } : {},
  });
  if (!response.ok) throw new Error("本地服务请求失败，请重置演示后重试。");
  return response.json();
};
const clearObservers = (demo: Demo, kind: "chat" | "tools"): void => {
  for (const stop of demo.observers[kind].splice(0)) stop();
};
const disposeDemo = async (demo: Demo): Promise<void> => {
  demo.stopTools?.();
  demo.stopChat?.();
  demo.tools?.dispose();
  try {
    await demo.chat?.dispose({ deadlineAt: Date.now() + 2_000 });
  } finally {
    clearObservers(demo, "chat");
    clearObservers(demo, "tools");
    demo.connection.dispose();
    await request("/session", demo.id, "DELETE");
  }
};

export const SharedSocketPanel = () => {
  const demoRef = useRef<Demo | null>(null);
  const mounted = useRef(false);
  const [observation, setObservation] = useState(EMPTY_SHARED_OBSERVATION);
  const [chatStatus, setChatStatus] = useState("未连接");
  const [toolStatus, setToolStatus] = useState("未注册");
  const [messages, setMessages] = useState<string[]>([]);
  const [text, setText] = useState("");
  const [selection, setSelection] = useState("这是宿主提供的选区内容。");
  const selectionRef = useRef(selection);
  const [calls, setCalls] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      const demo = demoRef.current;
      demoRef.current = null;
      if (demo) void disposeDemo(demo).catch(() => undefined);
    };
  }, []);
  const current = (demo: Demo): boolean =>
    mounted.current && demoRef.current === demo;
  const ensure = async (): Promise<Demo> => {
    if (!mounted.current) throw new Error("演示已关闭");
    if (demoRef.current) return demoRef.current;
    const result = (await request("/session", undefined, "POST")) as {
      id: string;
    };
    if (!mounted.current) {
      await request("/session", result.id, "DELETE");
      throw new Error("演示已关闭");
    }
    const demo: Demo = {
      id: result.id,
      connection: createTFRobotSocketConnection({
        serverUrl: window.location.origin,
        socketPath: SHARED_DEMO_SOCKET_PATH,
      }),
      observers: { chat: [], tools: [] },
      chat: null,
      tools: null,
      stopChat: null,
      stopTools: null,
    };
    demoRef.current = demo;
    return demo;
  };
  const factory =
    (demo: Demo, kind: "chat" | "tools"): TFRobotSocketFactory =>
    (input) => {
      const socket = demo.connection.socketFactory(input);
      const observe = (state: unknown): void => {
        if (current(demo)) setObservation(state as SharedSocketObservation);
      };
      socket.on("demo_state", observe);
      demo.observers[kind].push(() => socket.off("demo_state", observe));
      return socket;
    };
  const refresh = async (demo: Demo, until?: string): Promise<void> => {
    const state = (await request(
      `/state${until ? `?until=${until}` : ""}`,
      demo.id,
    )) as SharedSocketObservation;
    if (current(demo)) setObservation(state);
  };
  const connectChat = async (): Promise<void> => {
    const demo = await ensure();
    if (!current(demo)) return;
    if (demo.chat) return;
    setChatStatus("连接中");
    const chat = createTFRobotChatClient({
      baseUrl: `${window.location.origin}${SHARED_DEMO_PREFIX}`,
      socketNamespaceUrl: `${window.location.origin}/chat`,
      socketPath: SHARED_DEMO_SOCKET_PATH,
      socketFactory: factory(demo, "chat"),
      cache: false,
      sessionProvider: {
        getSession: () => ({ kind: "bearer", token: demo.id }),
      },
      messageCreatorProvider: () => ({ uid: "local-host", name: "验收用户" }),
    });
    demo.chat = chat;
    const stop = chat.subscribe(() => {
      if (!current(demo)) return;
      const snapshot = chat.getSnapshot();
      if (snapshot?.lifecycle)
        setChatStatus(
          isChatLifecycleOperable(snapshot.lifecycle) ? "在线" : "正在恢复",
        );
      setMessages(
        snapshot?.timeline.flatMap((item) =>
          item.kind === "message" && item.content.kind === "text"
            ? [item.content.text]
            : [],
        ) ?? [],
      );
    });
    demo.stopChat = () => stop.dispose();
    const result = await chat.loadConversation({
      conversationId: "1",
      deadlineAt: Date.now() + 5_000,
    });
    if (!result.ok) {
      await chat.dispose({ deadlineAt: Date.now() + 2_000 });
      clearObservers(demo, "chat");
      demo.stopChat();
      demo.stopChat = null;
      demo.chat = null;
      if (current(demo)) setChatStatus("连接失败");
      throw new Error("聊天连接失败，请重置演示后重试。");
    }
    if (current(demo)) setChatStatus("在线");
    await refresh(demo);
  };
  const connectTools = async (): Promise<void> => {
    const demo = await ensure();
    if (!current(demo)) return;
    if (demo.tools) {
      demo.tools.retry();
      return;
    }
    const tools = createTFRobotRemoteToolClient({
      baseUrl: window.location.origin,
      socketPath: SHARED_DEMO_SOCKET_PATH,
      socketFactory: factory(demo, "tools"),
      sessionProvider: {
        getSession: () => ({ kind: "bearer", token: demo.id }),
      },
      tools: [
        defineRemoteTool({
          definition: {
            toolName: "read_selection",
            description: "读取宿主的选区内容",
            parameters: { type: "object" },
            tags: ["Read"],
          },
          validate: () => undefined,
          execute: () => {
            if (current(demo)) setCalls((value) => value + 1);
            return { ok: true, resultForLlm: selectionRef.current };
          },
        }),
      ],
    });
    demo.tools = tools;
    const update = (): void => {
      if (current(demo)) {
        const state = tools.getSnapshot();
        setToolStatus(
          state.status === "ready"
            ? "已注册"
            : state.status === "error"
              ? "注册失败"
              : "连接中",
        );
      }
    };
    demo.stopTools = tools.subscribe(update);
    tools.start();
    update();
  };
  const releaseChat = async (): Promise<void> => {
    const demo = demoRef.current;
    if (!demo) return;
    demo.stopChat?.();
    demo.stopChat = null;
    await demo.chat?.dispose({ deadlineAt: Date.now() + 2_000 });
    demo.chat = null;
    clearObservers(demo, "chat");
    if (current(demo)) setChatStatus("已释放");
    await refresh(demo, demo.tools ? "chat-off" : "idle");
  };
  const releaseTools = async (): Promise<void> => {
    const demo = demoRef.current;
    if (!demo) return;
    demo.stopTools?.();
    demo.stopTools = null;
    demo.tools?.dispose();
    demo.tools = null;
    clearObservers(demo, "tools");
    if (current(demo)) setToolStatus("已注销");
    await refresh(demo, demo.chat ? "tools-off" : "idle");
  };
  const run = (operation: () => Promise<void>): void => {
    setBusy(true);
    setError(null);
    void operation()
      .catch(() => {
        if (mounted.current)
          setError("操作未完成，请确认本地开发服务已启动，或重置演示后重试。");
      })
      .finally(() => {
        if (mounted.current) setBusy(false);
      });
  };
  const send = async (): Promise<void> => {
    const demo = demoRef.current;
    if (!demo?.chat || !text.trim()) return;
    const result = await demo.chat.sendText({
      conversationId: "1",
      text,
      deadlineAt: Date.now() + 5_000,
    });
    if (!result.ok) throw new Error("发送失败");
    if (current(demo)) setText("");
  };
  return (
    <section className="shared-demo" aria-label="共享连接验收">
      <Alert
        type="info"
        showIcon
        message="本地真实连接演示"
        description="使用正式 SDK 与本地 Socket.IO 服务，无需登录。可分别连接聊天、注册工具，再验证两者共用一条连接。生产机器人联调请使用 RobotServer 模式。"
      />
      {error && <Alert type="error" showIcon message={error} />}
      <div className="shared-demo-metrics" aria-live="polite">
        <div>
          <span>底层连接数</span>
          <strong data-testid="shared-connection-count">
            {observation.activeConnections}
          </strong>
        </div>
        <div>
          <span>累计建立连接</span>
          <strong>{observation.totalConnections}</strong>
        </div>
        <div>
          <span>连接复用</span>
          <strong>
            {observation.chatEngineId &&
            observation.chatEngineId === observation.toolEngineId
              ? "已共用"
              : "等待两个通道连接"}
          </strong>
        </div>
      </div>
      <Space wrap>
        <Button
          type="primary"
          disabled={busy}
          onClick={() =>
            run(async () => {
              await connectChat();
              await connectTools();
            })
          }
        >
          一键连接两个通道
        </Button>
        <Button
          disabled={busy || observation.activeConnections === 0}
          onClick={() =>
            run(async () => {
              const demo = demoRef.current;
              if (demo) await request("/interrupt", demo.id, "POST");
            })
          }
        >
          模拟断网重连
        </Button>
        <Button
          disabled={busy}
          onClick={() =>
            run(async () => {
              const demo = demoRef.current;
              demoRef.current = null;
              try {
                if (demo) await disposeDemo(demo);
              } finally {
                if (mounted.current) {
                  setObservation(EMPTY_SHARED_OBSERVATION);
                  setChatStatus("未连接");
                  setToolStatus("未注册");
                  setMessages([]);
                  setCalls(0);
                }
              }
            })
          }
        >
          重置演示
        </Button>
      </Space>
      <div className="shared-demo-columns">
        <section className="shared-demo-card" aria-label="聊天通道">
          <div className="shared-demo-card-heading">
            <Typography.Title level={4}>聊天</Typography.Title>
            <Tag color={chatStatus === "在线" ? "green" : "default"}>
              {chatStatus}
            </Tag>
          </div>
          <Typography.Text type="secondary">/chat · 连接标识</Typography.Text>
          <code data-testid="shared-chat-engine">
            {observation.chatEngineId ?? "未连接"}
          </code>
          <Space wrap>
            <Button
              disabled={busy || demoRef.current?.chat != null}
              onClick={() => run(connectChat)}
            >
              连接聊天
            </Button>
            <Button
              disabled={busy || !demoRef.current?.chat}
              onClick={() => run(releaseChat)}
            >
              释放聊天
            </Button>
          </Space>
          <div
            className="shared-demo-messages"
            aria-label="演示聊天消息"
            aria-live="polite"
          >
            {messages.length ? (
              messages.map((value, index) => (
                <p key={`${index}:${value}`}>{value}</p>
              ))
            ) : (
              <Typography.Text type="secondary">
                连接后发送消息。注销工具后，聊天仍可继续。
              </Typography.Text>
            )}
          </div>
          <Input.TextArea
            aria-label="共享连接聊天消息"
            value={text}
            maxLength={2_000}
            onChange={(event) => setText(event.target.value)}
            placeholder="输入消息，验证聊天仍然可用"
            autoSize={{ minRows: 2, maxRows: 4 }}
          />
          <Button
            type="primary"
            disabled={busy || chatStatus !== "在线" || !text.trim()}
            onClick={() => run(send)}
          >
            发送验收消息
          </Button>
        </section>
        <section className="shared-demo-card" aria-label="宿主工具通道">
          <div className="shared-demo-card-heading">
            <Typography.Title level={4}>宿主工具</Typography.Title>
            <Tag color={toolStatus === "已注册" ? "green" : "default"}>
              {toolStatus}
            </Tag>
          </div>
          <Typography.Text type="secondary">
            /remote-tool · 连接标识
          </Typography.Text>
          <code data-testid="shared-tool-engine">
            {observation.toolEngineId ?? "未连接"}
          </code>
          <Space wrap>
            <Button
              disabled={busy || toolStatus === "已注册"}
              onClick={() => run(connectTools)}
            >
              注册宿主工具
            </Button>
            <Button
              disabled={busy || !demoRef.current?.tools}
              onClick={() => run(releaseTools)}
            >
              注销宿主工具
            </Button>
          </Space>
          <label htmlFor="shared-demo-selection">宿主选区内容</label>
          <Input.TextArea
            id="shared-demo-selection"
            value={selection}
            maxLength={2_000}
            onChange={(event) => {
              selectionRef.current = event.target.value;
              setSelection(event.target.value);
            }}
            autoSize={{ minRows: 3, maxRows: 6 }}
          />
          <Typography.Paragraph type="secondary">
            read_selection
            在当前页面执行，将这段内容返回给本地机器人。释放聊天后，工具仍可调用。
          </Typography.Paragraph>
          <Button
            type="primary"
            disabled={busy || toolStatus !== "已注册"}
            onClick={() =>
              run(async () => {
                const demo = demoRef.current;
                if (demo) {
                  await request("/invoke", demo.id, "POST");
                  await refresh(demo);
                }
              })
            }
          >
            让机器人调用宿主工具
          </Button>
          <Typography.Text>
            宿主执行次数：<strong>{calls}</strong>
          </Typography.Text>
          <div className="shared-demo-result" aria-live="polite">
            <Typography.Text type="secondary">机器人收到的结果</Typography.Text>
            <p>{observation.lastToolResult ?? "尚未调用"}</p>
          </div>
        </section>
      </div>
      <Typography.Paragraph type="secondary">
        验收顺序：连接两个通道 → 确认连接数为 1 且标识相同 → 发送消息 / 调用工具
        → 单独释放任一方，继续使用另一方 → 两方都释放后连接数为 0。
      </Typography.Paragraph>
    </section>
  );
};
