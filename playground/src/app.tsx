import { Alert, Button, Input, Select, Space, Tag } from "antd";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { ManagerChatApp } from "@turingfocus/chat-kit/manager-antd";
import { managerIdentityScope } from "@turingfocus/chat-kit/auth/manager";
import {
  createPlaygroundEnvironment,
  MANAGER_ENVIRONMENTS,
  type PlaygroundEnvironment,
} from "./real-environment.js";

type EnvironmentName = keyof typeof MANAGER_ENVIRONMENTS | "custom";
const toolStatuses = {
  idle: "未注册",
  resolving: "连接机器人中",
  connecting: "连接中",
  registering: "注册中",
  ready: "已注册",
  disconnected: "已断开",
  error: "连接失败",
  disposed: "已释放",
};
const toolErrors: Readonly<Record<string, string>> = {
  authentication: "认证或授权失败，请确认当前账号拥有 action:execute 权限。",
  "name-conflict":
    "这个机器人的 add 工具已被其他 Provider 注册，请先注销该 Provider。",
  "registration-rejected": "服务端拒绝注册，请检查工具执行权限。",
  "invalid-ack": "服务端注册响应无效。",
  timeout: "连接或注册超时，请检查机器人状态和网络后重新注册。",
  transport: "网络连接失败，请检查机器人入口和网络。",
  "invalid-parameters": "收到的 add 参数无效，需要两个有限数值。",
};

function RemoteToolPanel({
  environment,
}: {
  readonly environment: PlaygroundEnvironment;
}) {
  const { auth, toolManager: manager, tools } = environment;
  const subscribeAuth = useCallback(
    (listener: () => void) => auth.subscribe(listener),
    [auth],
  );
  const authState = useSyncExternalStore(subscribeAuth, () =>
    auth.getSnapshot(),
  );
  const subscribeDirectory = useCallback(
    (listener: () => void) => manager.subscribe(listener),
    [manager],
  );
  const directory = useSyncExternalStore(subscribeDirectory, () =>
    manager.getSnapshot(),
  );
  const state = useSyncExternalStore(tools.subscribe, tools.getSnapshot);
  const [robotId, setRobotId] = useState<string>();
  const signedIn = managerIdentityScope(authState) !== undefined;
  useEffect(() => setRobotId(undefined), [directory.identityRevision]);
  const active = state.status !== "idle";
  const selected = directory.items.find((robot) => robot.id === robotId);
  const load = () => {
    void manager.refresh().catch(() => undefined);
  };
  const loadMore = () => {
    const pagination = directory.pagination;
    if (pagination?.hasMore)
      void manager.loadPage(pagination.page + 1).catch(() => undefined);
  };
  return (
    <section className="playground-tools" aria-label="RemoteTool 连接">
      <div className="playground-section-title">
        <h2>RemoteTool 连接</h2>
        <Tag color={state.status === "ready" ? "green" : "default"}>
          {toolStatuses[state.status]}
        </Tag>
      </div>
      <p>
        内置 <code>add(a, b)</code>
        ，返回两个数的和。独立注册和注销，无须选择聊天会话。
      </p>
      {!signedIn ? (
        <p>
          先在左侧默认界面登录并选择组织，再加载真实机器人。无需连接聊天即可注册工具。
        </p>
      ) : null}
      <Space wrap>
        <Button
          onClick={load}
          disabled={!signedIn || active}
          loading={directory.status === "loading"}
        >
          加载机器人
        </Button>
        {directory.pagination?.hasMore ? (
          <Button
            onClick={loadMore}
            disabled={active}
            loading={directory.status === "loading"}
          >
            加载更多
          </Button>
        ) : null}
      </Space>
      <label className="playground-field">
        <span>RemoteTool 机器人</span>
        <Select
          aria-label="RemoteTool 机器人"
          placeholder="请选择真实机器人"
          value={selected?.id}
          disabled={!signedIn || active}
          onChange={setRobotId}
          options={directory.items.map((robot) => ({
            value: robot.id,
            label: `${robot.name ?? robot.robotId ?? robot.id}${robot.eligibility === "ready" ? "" : "（不可连接）"}`,
            disabled: robot.eligibility !== "ready",
          }))}
        />
      </label>
      {directory.status === "error" ? (
        <Alert
          type="error"
          showIcon
          message="加载机器人失败，请检查权限或网络后重试。"
        />
      ) : null}
      {signedIn &&
      directory.status === "ready" &&
      directory.items.length === 0 ? (
        <p>当前组织暂无机器人。</p>
      ) : null}
      <Space wrap>
        <Button
          type="primary"
          disabled={!selected || active || !signedIn}
          onClick={() => {
            if (selected) void tools.start(selected);
          }}
        >
          注册 add
        </Button>
        <Button disabled={!active} onClick={tools.stop}>
          注销 RemoteTool
        </Button>
      </Space>
      {state.robotId ? (
        <p>
          工具机器人：
          {directory.items.find((robot) => robot.id === state.robotId)?.name ??
            state.robotId}
        </p>
      ) : null}
      {state.error ? (
        <Alert
          type="error"
          showIcon
          message={
            toolErrors[state.error] ?? "连接或工具调用失败，请注销后重试。"
          }
        />
      ) : null}
      <div className="playground-tool-manifest">
        <strong>add(a: number, b: number)</strong>
        <p>
          注册后，在该机器人的聊天中要求调用 add，例如「请调用 add 计算 12 +
          30」。下方仅显示服务端实际发起的调用。
        </p>
      </div>
      <h3>实际调用记录</h3>
      <ol aria-label="add 调用记录">
        {state.calls.map(({ a, b, sum }, index) => (
          <li key={index}>
            <code>
              add({a}, {b}) = {sum}
            </code>
          </li>
        ))}
      </ol>
      {state.calls.length === 0 ? (
        <p className="playground-muted">尚未收到调用。</p>
      ) : null}
    </section>
  );
}

export function PlaygroundApp() {
  const [environmentName, setEnvironmentName] =
    useState<EnvironmentName>("test");
  const [customUrl, setCustomUrl] = useState("");
  const [baseUrl, setBaseUrl] = useState<string>(MANAGER_ENVIRONMENTS.test);
  const [environment, setEnvironment] = useState<PlaygroundEnvironment>();
  const [error, setError] = useState<string>();
  const [chatMounted, setChatMounted] = useState(true);
  useEffect(() => {
    let next: PlaygroundEnvironment;
    try {
      next = createPlaygroundEnvironment(baseUrl);
      setEnvironment(next);
      setError(undefined);
    } catch {
      setEnvironment(undefined);
      setError("Manager 地址无效，请填写完整的 HTTP(S) 地址。");
      return;
    }
    return () => {
      void next.dispose();
    };
  }, [baseUrl]);
  const changeEnvironment = (name: EnvironmentName) => {
    setEnvironmentName(name);
    if (name !== "custom") setBaseUrl(MANAGER_ENVIRONMENTS[name]);
  };
  return (
    <main className="playground-page">
      <header className="playground-header">
        <div>
          <h1>Chat Kit Playground</h1>
          <p>默认宿主界面 · 真实环境与机器人</p>
        </div>
        <Space wrap>
          <label className="playground-environment-label">
            Manager 环境
            <Select
              aria-label="Manager 环境"
              value={environmentName}
              onChange={changeEnvironment}
              options={[
                { label: "test", value: "test" },
                { label: "staging", value: "staging" },
                { label: "正式", value: "production" },
                { label: "自定义", value: "custom" },
              ]}
            />
          </label>
          {environmentName === "custom" ? (
            <>
              <Input
                aria-label="自定义 Manager 地址"
                placeholder="https://…"
                value={customUrl}
                onChange={(event) => setCustomUrl(event.target.value)}
              />
              <Button onClick={() => setBaseUrl(customUrl.trim())}>
                应用环境
              </Button>
            </>
          ) : null}
        </Space>
      </header>
      <p className="playground-address">当前 Manager：{baseUrl}</p>
      {error ? <Alert type="error" showIcon message={error} /> : null}
      {environment?.baseUrl === baseUrl && !error ? (
        <div className="playground-connections" key={baseUrl}>
          <section className="playground-chat" aria-label="Chat Kit 连接">
            <div className="playground-section-title">
              <h2>Chat Kit 连接</h2>
              <Button onClick={() => setChatMounted((value) => !value)}>
                {chatMounted ? "断开 Chat Kit" : "打开 Chat Kit"}
              </Button>
            </div>
            <div className="playground-host-frame">
              {chatMounted ? (
                <ManagerChatApp
                  auth={environment.auth}
                  manager={environment.manager}
                  chat={environment.chat}
                />
              ) : (
                <p className="playground-disconnected">
                  Chat Kit 已断开。RemoteTool 保持独立连接。
                </p>
              )}
            </div>
          </section>
          <RemoteToolPanel environment={environment} />
        </div>
      ) : null}
    </main>
  );
}
