import { Alert, Button, Input, Radio, Space, Typography } from "antd";
import { useEffect, useRef, useState, type FormEvent } from "react";

import {
  createRobotServerConnectionConfig,
  validateRobotServerTarget,
  type RobotServerAuthKind,
  type RobotServerConnectionConfig,
  type RobotServerConnectionKind,
  type RobotServerConnectionTargetDraft,
} from "./robotserver-session.js";
import {
  loginRobotServerWithPassword,
  type RobotServerPasswordLoginDependencies,
} from "./robotserver-login.js";
import type { RobotServerDebugPrefillLoader } from "./robotserver-debug-prefill.js";

declare const __TF_CHAT_PLAYGROUND_ALLOWED_SERVER_ORIGINS__: string;
declare const __TF_CHAT_PLAYGROUND_DEBUG_PREFILL_ENABLED__: boolean;

type AuthenticationKind = RobotServerAuthKind | "password";
type PasswordLogin = (
  target: Parameters<typeof loginRobotServerWithPassword>[0],
  password: string,
  dependencies?: RobotServerPasswordLoginDependencies,
) => ReturnType<typeof loginRobotServerWithPassword>;

const debugPrefillEnabled =
  typeof __TF_CHAT_PLAYGROUND_DEBUG_PREFILL_ENABLED__ !== "undefined" &&
  __TF_CHAT_PLAYGROUND_DEBUG_PREFILL_ENABLED__ === true;

const loadDefaultDebugPrefill: RobotServerDebugPrefillLoader = async (
  signal,
) => {
  if (!debugPrefillEnabled) return { ok: true, value: null };
  const { loadRobotServerDebugPrefill } =
    await import("./robotserver-debug-prefill.js");
  return loadRobotServerDebugPrefill(signal);
};

export interface RobotServerConnectionPanelProps {
  readonly loadDebugPrefill?: RobotServerDebugPrefillLoader | undefined;
  readonly loginWithPassword?: PasswordLogin | undefined;
  readonly onCancel: () => void;
  readonly onConnect: (config: RobotServerConnectionConfig) => void;
}

const allowedServerOrigins = (): readonly string[] =>
  (typeof __TF_CHAT_PLAYGROUND_ALLOWED_SERVER_ORIGINS__ === "string"
    ? __TF_CHAT_PLAYGROUND_ALLOWED_SERVER_ORIGINS__
    : ""
  )
    .split(",")
    .map((value: string) => value.trim())
    .filter(Boolean);

export const RobotServerConnectionPanel = ({
  loadDebugPrefill = loadDefaultDebugPrefill,
  loginWithPassword = loginRobotServerWithPassword,
  onCancel,
  onConnect,
}: RobotServerConnectionPanelProps) => {
  const [authKind, setAuthKind] = useState<AuthenticationKind>("password");
  const [connectionKind, setConnectionKind] =
    useState<RobotServerConnectionKind>("standard");
  const [creatorName, setCreatorName] = useState("");
  const [creatorUid, setCreatorUid] = useState("");
  const [error, setError] = useState<string>();
  const [httpBaseUrl, setHttpBaseUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [namespace, setNamespace] = useState("");
  const [platformId, setPlatformId] = useState("");
  const [prefillError, setPrefillError] = useState<string>();
  const [robotId, setRobotId] = useState("");
  const [secret, setSecret] = useState("");
  const [serverOrigin, setServerOrigin] = useState("");
  const [socketNamespaceUrl, setSocketNamespaceUrl] = useState("");
  const [socketPath, setSocketPath] = useState("");
  const debugPrefillController = useRef<AbortController>();
  const loginController = useRef<AbortController>();
  const userEdited = useRef(false);

  useEffect(
    () => () => {
      debugPrefillController.current?.abort();
      loginController.current?.abort();
    },
    [],
  );

  useEffect(() => {
    const controller = new AbortController();
    debugPrefillController.current?.abort();
    debugPrefillController.current = controller;
    void loadDebugPrefill(controller.signal)
      .then((result) => {
        if (controller.signal.aborted || userEdited.current) return;
        if (!result.ok) {
          setPrefillError(result.message);
          return;
        }
        const prefill = result.value;
        if (prefill === null) return;
        if (prefill.authKind !== undefined) setAuthKind(prefill.authKind);
        if (prefill.connectionKind !== undefined) {
          setConnectionKind(prefill.connectionKind);
        }
        if (prefill.creatorName !== undefined) {
          setCreatorName(prefill.creatorName);
        }
        if (prefill.creatorUid !== undefined) setCreatorUid(prefill.creatorUid);
        if (prefill.httpBaseUrl !== undefined) {
          setHttpBaseUrl(prefill.httpBaseUrl);
        }
        if (prefill.namespace !== undefined) setNamespace(prefill.namespace);
        if (prefill.platformId !== undefined) setPlatformId(prefill.platformId);
        if (prefill.robotId !== undefined) setRobotId(prefill.robotId);
        if (prefill.secret !== undefined) setSecret(prefill.secret);
        if (prefill.serverOrigin !== undefined) {
          setServerOrigin(prefill.serverOrigin);
        }
        if (prefill.socketNamespaceUrl !== undefined) {
          setSocketNamespaceUrl(prefill.socketNamespaceUrl);
        }
        if (prefill.socketPath !== undefined) setSocketPath(prefill.socketPath);
      })
      .catch(() => {
        if (!controller.signal.aborted && !userEdited.current) {
          setPrefillError("无法加载本地 .debug 预填配置。");
        }
      });
    return () => controller.abort();
  }, [loadDebugPrefill]);

  const markEdited = (): void => {
    userEdited.current = true;
    setPrefillError(undefined);
  };

  const targetDraft = (): RobotServerConnectionTargetDraft => ({
    allowedServerOrigins: allowedServerOrigins(),
    connectionKind,
    creatorName,
    creatorUid,
    httpBaseUrl,
    namespace,
    platformId,
    proxyOrigin: window.location.origin,
    robotId,
    serverOrigin,
    socketNamespaceUrl,
    socketPath,
  });

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (loading) return;
    const target = validateRobotServerTarget(targetDraft());
    if (!target.ok) {
      setError(target.message);
      return;
    }

    if (authKind !== "password") {
      const validation = createRobotServerConnectionConfig(
        target.value,
        authKind,
        secret,
      );
      setSecret("");
      if (!validation.ok) {
        setError(validation.message);
        return;
      }
      setError(undefined);
      onConnect(validation.value);
      return;
    }

    const controller = new AbortController();
    loginController.current?.abort();
    loginController.current = controller;
    setLoading(true);
    setError(undefined);
    try {
      const validation = await loginWithPassword(target.value, secret, {
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      if (!validation.ok) {
        setError(validation.message);
        return;
      }
      onConnect(validation.value);
    } finally {
      setSecret("");
      if (loginController.current === controller) {
        loginController.current = undefined;
        setLoading(false);
      }
    }
  };

  const selectConnectionKind = (next: RobotServerConnectionKind) => {
    setConnectionKind(next);
    setError(undefined);
    if (next === "direct" && authKind === "password") setAuthKind("admin");
  };

  const secretLabel =
    authKind === "password"
      ? "管理员密码"
      : authKind === "admin"
        ? "Admin Token"
        : "用户 Token";

  return (
    <main className="playground-page connection-page">
      <section
        aria-labelledby="robotserver-connection-title"
        className="connection-panel"
      >
        <Typography.Text className="eyebrow">
          本地私有应用 · 凭据仅存内存
        </Typography.Text>
        <div className="connection-intro">
          <Typography.Title id="robotserver-connection-title" level={2}>
            连接 RobotServer
          </Typography.Title>
          <Typography.Paragraph>
            {debugPrefillEnabled
              ? "填写机器人路由信息并选择鉴权方式。密码或 Token 只在当前页面内存中使用；本地开发若配置了 .debug，刷新时会重新读取。"
              : "填写机器人路由信息并选择鉴权方式。密码或 Token 只在当前页面内存中使用，刷新即清除。"}
          </Typography.Paragraph>
        </div>

        {error === undefined ? null : (
          <Alert message={error} showIcon type="error" />
        )}
        {prefillError === undefined ? null : (
          <Alert message={prefillError} showIcon type="warning" />
        )}

        <form autoComplete="off" className="connection-form" onSubmit={submit}>
          <div className="connection-section">
            <Typography.Title level={5}>机器人信息</Typography.Title>
            <label className="connection-field">
              <span>RobotServer 服务地址</span>
              <Input
                aria-label="RobotServer 服务地址"
                disabled={loading}
                onChange={(event) => {
                  markEdited();
                  setServerOrigin(event.target.value);
                }}
                placeholder="例如：https://staging.turingfocus.cn"
                value={serverOrigin}
              />
            </label>
            <label className="connection-field">
              <span>Namespace</span>
              <Input
                aria-label="Namespace"
                disabled={loading}
                onChange={(event) => {
                  markEdited();
                  setNamespace(event.target.value);
                }}
                placeholder="例如：tfrs-org-18"
                value={namespace}
              />
            </label>
            <label className="connection-field">
              <span>Robot ID</span>
              <Input
                aria-label="Robot ID"
                disabled={loading}
                onChange={(event) => {
                  markEdited();
                  setRobotId(event.target.value);
                }}
                placeholder="例如：de-eed9dc12a94b492ea8e7"
                value={robotId}
              />
            </label>
          </div>

          <div className="connection-section">
            <Typography.Title level={5}>鉴权方式</Typography.Title>
            <Radio.Group
              buttonStyle="solid"
              className="connection-choice"
              disabled={loading}
              onChange={(event) => {
                markEdited();
                setAuthKind(event.target.value as AuthenticationKind);
                setSecret("");
                setError(undefined);
              }}
              optionType="button"
              options={[
                ...(connectionKind === "standard"
                  ? [{ label: "管理员密码", value: "password" }]
                  : []),
                { label: "Admin Token", value: "admin" },
                { label: "用户 Token", value: "bearer" },
              ]}
              value={authKind}
            />
            <label className="connection-field">
              <span>{secretLabel}</span>
              <Input.Password
                aria-label={secretLabel}
                autoComplete="new-password"
                disabled={loading}
                onChange={(event) => {
                  markEdited();
                  setSecret(event.target.value);
                }}
                placeholder={`请输入${secretLabel}`}
                value={secret}
              />
              {authKind === "password" ? (
                <small>
                  密码仅用于换取短期 Admin Token，不会保存在浏览器中。
                </small>
              ) : null}
            </label>
          </div>

          <details className="connection-advanced">
            <summary>高级设置</summary>
            <div className="connection-advanced-fields">
              <div className="connection-section">
                <span className="connection-label">连接方式</span>
                <Radio.Group
                  buttonStyle="solid"
                  disabled={loading}
                  onChange={(event) => {
                    markEdited();
                    selectConnectionKind(
                      event.target.value as RobotServerConnectionKind,
                    );
                  }}
                  optionType="button"
                  options={[
                    { label: "标准连接", value: "standard" },
                    { label: "高级直连", value: "direct" },
                  ]}
                  value={connectionKind}
                />
              </div>
              {connectionKind === "direct" ? (
                <>
                  <label className="connection-field">
                    <span>HTTP 基础地址</span>
                    <Input
                      aria-label="HTTP 基础地址"
                      disabled={loading}
                      onChange={(event) => {
                        markEdited();
                        setHttpBaseUrl(event.target.value);
                      }}
                      placeholder="例如：http://localhost:5000"
                      value={httpBaseUrl}
                    />
                  </label>
                  <label className="connection-field">
                    <span>Socket Namespace 地址</span>
                    <Input
                      aria-label="Socket Namespace 地址"
                      disabled={loading}
                      onChange={(event) => {
                        markEdited();
                        setSocketNamespaceUrl(event.target.value);
                      }}
                      placeholder="例如：http://localhost:5000/chat"
                      value={socketNamespaceUrl}
                    />
                  </label>
                  <label className="connection-field">
                    <span>Socket Path</span>
                    <Input
                      aria-label="Socket Path"
                      disabled={loading}
                      onChange={(event) => {
                        markEdited();
                        setSocketPath(event.target.value);
                      }}
                      placeholder="例如：/socket.io"
                      value={socketPath}
                    />
                  </label>
                </>
              ) : null}
              <label className="connection-field">
                <span>platformId（可选）</span>
                <Input
                  aria-label="platformId"
                  disabled={loading}
                  onChange={(event) => {
                    markEdited();
                    setPlatformId(event.target.value);
                  }}
                  value={platformId}
                />
              </label>
              <div className="connection-identity">
                <label className="connection-field">
                  <span>消息创建者 ID</span>
                  <Input
                    aria-label="消息创建者 ID"
                    disabled={loading}
                    onChange={(event) => {
                      markEdited();
                      setCreatorUid(event.target.value);
                    }}
                    value={creatorUid}
                  />
                </label>
                <label className="connection-field">
                  <span>消息创建者名称</span>
                  <Input
                    aria-label="消息创建者名称"
                    disabled={loading}
                    onChange={(event) => {
                      markEdited();
                      setCreatorName(event.target.value);
                    }}
                    value={creatorName}
                  />
                </label>
              </div>
            </div>
          </details>

          <Space className="connection-actions" wrap>
            <Button htmlType="submit" loading={loading} type="primary">
              连接 RobotServer
            </Button>
            <Button
              disabled={loading}
              onClick={() => {
                debugPrefillController.current?.abort();
                loginController.current?.abort();
                onCancel();
              }}
            >
              返回 Mock 模式
            </Button>
          </Space>
        </form>
      </section>
    </main>
  );
};
