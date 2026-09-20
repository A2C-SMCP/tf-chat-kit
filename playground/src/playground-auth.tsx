import { Button, Input, Radio, Space, Tag, Typography } from "antd";
import {
  AccountSelectionPanel,
  AuthStatus,
  LoginPanel,
  OrganizationSwitcher,
} from "../../packages/chat-auth/src/antd.js";
import {
  AuthProvider,
  useAuth,
  useAuthSelector,
} from "../../packages/chat-auth/src/react.js";
import {
  createAuthClient,
  type AccountContext,
  type AuthClient,
  type AuthTransport,
  type LoginResult,
} from "../../packages/chat-auth/src/headless.js";
import type { PlaygroundRobotDescriptor } from "./manager-directory.js";
import { useEffect, useRef, useState, type ReactNode } from "react";

/** The Manager deployment used by the local playground in the common case. */
export const STAGING_MANAGER_BASE_URL = "https://api-staging.turingfocus.cn";
export const PRODUCTION_MANAGER_BASE_URL = "https://api.turingfocus.cn";

const playgroundAccounts = [
  {
    userId: "playground-user",
    accountId: "org-alpha",
    organizationId: "org-alpha",
    displayName: "Alpha Organization",
  },
  {
    userId: "playground-user",
    accountId: "org-beta",
    organizationId: "org-beta",
    displayName: "Beta Organization",
  },
] as const satisfies readonly AccountContext[];

const robotsByOrganization: Readonly<Record<string, readonly string[]>> = {
  "org-alpha": ["research-assistant", "support-bot"],
  "org-beta": ["analytics-bot", "release-helper"],
};

const mockRobot = (id: string): PlaygroundRobotDescriptor => ({
  canAutoConnect: false,
  id,
  name: id,
});

class PlaygroundAuthTransport implements AuthTransport {
  #account: AccountContext | undefined;
  #session = { kind: "bearer" as const, token: "playground-session" };

  async login(): Promise<LoginResult> {
    this.#account = playgroundAccounts[0];
    return { kind: "authenticated", account: playgroundAccounts[0] };
  }

  async selectAccount(accountId: string): Promise<LoginResult> {
    const account = playgroundAccounts.find(
      (item) => item.accountId === accountId,
    );
    if (account === undefined) throw new Error("组织不存在");
    this.#account = account;
    return { kind: "authenticated", account };
  }

  async getCurrentAccount(): Promise<AccountContext> {
    if (this.#account === undefined) throw new Error("尚未登录");
    return this.#account;
  }

  async listAccounts(): Promise<readonly AccountContext[]> {
    return playgroundAccounts;
  }

  async switchAccount(accountId: string): Promise<AccountContext> {
    const result = await this.selectAccount(accountId);
    if (result.kind !== "authenticated") throw new Error("组织切换失败");
    return result.account;
  }

  async getSession() {
    return this.#account === undefined ? null : this.#session;
  }

  async logout(): Promise<void> {
    this.#account = undefined;
  }

  clearSession(): void {
    this.#account = undefined;
  }
}

export const createPlaygroundAuthClient = (): AuthClient =>
  createAuthClient({
    environment: "staging",
    transport: new PlaygroundAuthTransport(),
  });

const OrganizationAndRobotPicker = ({
  loadRobots,
  onRobotChange,
  onSelectionChange,
  robotId,
}: {
  readonly loadRobots?:
    | ((
        organizationId: string,
      ) => Promise<readonly PlaygroundRobotDescriptor[]>)
    | undefined;
  readonly onRobotChange: (robotId: string) => void;
  readonly onSelectionChange: (
    organizationId: string,
    robot: PlaygroundRobotDescriptor,
  ) => void;
  readonly robotId: string;
}): ReactNode => {
  const client = useAuth();
  const account = useAuthSelector((snapshot) => snapshot.account);
  const accounts = useAuthSelector((snapshot) => snapshot.accounts);
  const [remoteRobots, setRemoteRobots] = useState<
    readonly PlaygroundRobotDescriptor[] | undefined
  >();
  const robotRequest = useRef(0);
  const remoteSelectionKey = useRef<string>();
  useEffect(() => {
    if (account === undefined) return;
    void client.listAccounts().catch(() => undefined);
  }, [client, account?.accountId]);
  useEffect(() => {
    const requestId = ++robotRequest.current;
    if (account === undefined || loadRobots === undefined) {
      setRemoteRobots(undefined);
      remoteSelectionKey.current = undefined;
      return;
    }
    setRemoteRobots(undefined);
    void loadRobots(account.organizationId ?? account.accountId)
      .then((items) => {
        if (requestId === robotRequest.current) setRemoteRobots(items);
      })
      .catch(() => {
        if (requestId === robotRequest.current) setRemoteRobots(undefined);
      });
  }, [account?.accountId, account?.organizationId, loadRobots]);
  const robots: readonly PlaygroundRobotDescriptor[] =
    account === undefined
      ? []
      : loadRobots === undefined
        ? (
            robotsByOrganization[account.organizationId ?? account.accountId] ??
            []
          ).map(mockRobot)
        : (remoteRobots ?? []);
  const selectedAccountId = account?.accountId;
  const selectedOrganizationId = account?.organizationId ?? account?.accountId;
  useEffect(() => {
    if (
      loadRobots === undefined ||
      remoteRobots === undefined ||
      account === undefined
    )
      return;
    const nextRobotId = remoteRobots.some(({ id }) => id === robotId)
      ? robotId
      : (remoteRobots[0]?.id ?? "");
    const nextRobot = remoteRobots.find(({ id }) => id === nextRobotId);
    if (nextRobot === undefined) return;
    const selectionKey = `${account.accountId}:${nextRobotId}`;
    if (remoteSelectionKey.current === selectionKey) return;
    remoteSelectionKey.current = selectionKey;
    onRobotChange(nextRobotId);
    onSelectionChange(account.organizationId ?? account.accountId, nextRobot);
  }, [
    account?.accountId,
    account?.organizationId,
    loadRobots,
    onRobotChange,
    onSelectionChange,
    remoteRobots,
    robotId,
  ]);

  return (
    <Space align="center" wrap>
      <Typography.Text strong>组织</Typography.Text>
      <select
        aria-label="选择组织"
        onChange={(event) => {
          const accountId = event.target.value;
          void client
            .switchAccount(accountId)
            .then((nextAccount) => {
              const nextRobots =
                loadRobots === undefined
                  ? (robotsByOrganization[accountId] ?? []).map(mockRobot)
                  : [];
              const nextRobot = nextRobots[0];
              const nextRobotId = nextRobot?.id ?? "";
              onRobotChange(nextRobotId);
              if (nextRobot !== undefined) {
                onSelectionChange(
                  nextAccount.organizationId ?? nextAccount.accountId,
                  nextRobot,
                );
              }
            })
            .catch(() => undefined);
        }}
        value={selectedAccountId ?? ""}
      >
        {accounts.map((item) => (
          <option key={item.accountId} value={item.accountId}>
            {item.displayName ?? item.organizationId ?? item.accountId}
          </option>
        ))}
      </select>
      <Typography.Text strong>机器人</Typography.Text>
      <select
        aria-label="选择机器人"
        onChange={(event) => {
          const nextRobotId = event.target.value;
          onRobotChange(nextRobotId);
          const nextRobot = robots.find(({ id }) => id === nextRobotId);
          if (selectedOrganizationId !== undefined && nextRobot !== undefined)
            onSelectionChange(selectedOrganizationId, nextRobot);
        }}
        value={
          robots.some(({ id }) => id === robotId)
            ? robotId
            : (robots[0]?.id ?? "")
        }
      >
        {robots.map((item) => (
          <option key={item.id} value={item.id}>
            {item.name}
          </option>
        ))}
      </select>
      <Tag color="blue">当前组织：{account?.organizationId}</Tag>
      <Tag color="purple">
        当前机器人：{robots.find(({ id }) => id === robotId)?.name ?? robotId}
      </Tag>
    </Space>
  );
};

/**
 * Playground-only host login flow. The deployment picker is intentionally
 * private to this development consumer; chat-auth's public default UI keeps
 * its environment fixed by the host and has no arbitrary URL input.
 */
const PlaygroundAuthGateContent = ({
  client,
  onLogout,
  onRealLogin,
  onSelectionChange,
  loadRobots,
  robotId: selectedRobotId,
}: {
  readonly client: AuthClient;
  readonly onLogout: () => void;
  readonly onRealLogin: (
    environment: "staging" | "production" | "custom",
    baseUrl: string,
    identifier: string,
    password: string,
  ) => Promise<void>;
  readonly onSelectionChange: (
    organizationId: string,
    robot: PlaygroundRobotDescriptor,
  ) => void;
  readonly loadRobots?:
    | ((
        organizationId: string,
      ) => Promise<readonly PlaygroundRobotDescriptor[]>)
    | undefined;
  readonly robotId: string;
}): ReactNode => {
  const status = useAuthSelectorFromClient(
    client,
    (snapshot) => snapshot.status,
  );
  const [robotId, setRobotId] = useState(selectedRobotId);
  const [loginMode, setLoginMode] = useState<"mock" | "real">("mock");
  const [realEnvironment, setRealEnvironment] = useState<
    "staging" | "production" | "custom"
  >("staging");
  const [customBaseUrl, setCustomBaseUrl] = useState("");
  const [realIdentifier, setRealIdentifier] = useState("");
  const [realPassword, setRealPassword] = useState("");
  const [realSubmitting, setRealSubmitting] = useState(false);
  const [realError, setRealError] = useState<string>();
  useEffect(() => setRobotId(selectedRobotId), [selectedRobotId]);

  if (
    status === "signed_out" ||
    status === "authenticating" ||
    status === "error"
  ) {
    return (
      <div className="playground-host-shell">
        <section className="playground-auth-panel" aria-label="Playground 登录">
          <Typography.Title level={3}>身份与目录</Typography.Title>
          <Typography.Paragraph type="secondary">
            身份数据与 ChatKit 聊天后端相互独立。Mock
            身份使用本地内存数据；真实身份可连接 staging Manager、正式 Manager
            或自定义 Manager 环境。
          </Typography.Paragraph>
          <Radio.Group
            block
            buttonStyle="solid"
            className="playground-auth-mode"
            onChange={(event) => setLoginMode(event.target.value)}
            optionType="button"
            options={[
              { label: "Mock 模式", value: "mock" },
              { label: "真实用户模式", value: "real" },
            ]}
            value={loginMode}
          />
          {loginMode === "mock" ? (
            <>
              <LoginPanel labels={{ login: "登录" }} />
              <Typography.Text type="secondary">
                任意账号和密码均可登录，仅用于本地演示。聊天区域无需登录也可以使用
                Mock ChatKit。
              </Typography.Text>
            </>
          ) : (
            <div className="playground-auth-real-mode">
              <Typography.Paragraph type="secondary">
                真实模式使用 Manager 的用户级登录接口（用户名/密码），登录后
                再读取该用户可访问的组织和机器人。凭据只在当前页面内存中使用。
              </Typography.Paragraph>
              <Space direction="vertical" style={{ width: "100%" }}>
                <Typography.Text strong>Manager 环境</Typography.Text>
                <Radio.Group
                  aria-label="Manager 环境"
                  block
                  buttonStyle="solid"
                  className="playground-auth-environment"
                  onChange={(event) => setRealEnvironment(event.target.value)}
                  optionType="button"
                  options={[
                    { label: "staging", value: "staging" },
                    { label: "正式", value: "production" },
                    { label: "自定义", value: "custom" },
                  ]}
                  value={realEnvironment}
                />
                {realEnvironment === "staging" ? (
                  <Typography.Text type="secondary">
                    {STAGING_MANAGER_BASE_URL}
                  </Typography.Text>
                ) : realEnvironment === "production" ? (
                  <Typography.Text type="secondary">
                    {PRODUCTION_MANAGER_BASE_URL}
                  </Typography.Text>
                ) : (
                  <Input
                    aria-label="自定义 Manager API 地址"
                    placeholder="https://your-manager.example.com"
                    value={customBaseUrl}
                    onChange={(event) => setCustomBaseUrl(event.target.value)}
                  />
                )}
                <Input
                  aria-label="用户账号"
                  placeholder="用户名或邮箱"
                  value={realIdentifier}
                  onChange={(event) => setRealIdentifier(event.target.value)}
                />
                <Input.Password
                  aria-label="用户密码"
                  placeholder="密码"
                  value={realPassword}
                  onChange={(event) => setRealPassword(event.target.value)}
                />
                <Space>
                  <Button
                    type="primary"
                    loading={realSubmitting}
                    onClick={() => {
                      setRealError(undefined);
                      setRealSubmitting(true);
                      void onRealLogin(
                        realEnvironment,
                        realEnvironment === "staging"
                          ? STAGING_MANAGER_BASE_URL
                          : realEnvironment === "production"
                            ? PRODUCTION_MANAGER_BASE_URL
                            : customBaseUrl,
                        realIdentifier,
                        realPassword,
                      )
                        .then(() => setRealPassword(""))
                        .catch((error: unknown) => {
                          setRealError(
                            error instanceof Error
                              ? error.message
                              : "用户登录失败",
                          );
                        })
                        .finally(() => setRealSubmitting(false));
                    }}
                  >
                    用户登录
                  </Button>
                </Space>
                {realError !== undefined ? (
                  <Typography.Text type="danger">{realError}</Typography.Text>
                ) : null}
              </Space>
            </div>
          )}
        </section>
      </div>
    );
  }
  if (status === "account_selection_required") {
    return (
      <div className="playground-host-shell">
        <section className="playground-auth-panel" aria-label="选择组织">
          <Typography.Title level={3}>选择组织</Typography.Title>
          <AccountSelectionPanel labels={{ accountSelection: "选择组织" }} />
        </section>
      </div>
    );
  }
  return (
    <>
      <section
        className="playground-auth-toolbar"
        aria-label="认证与机器人选择"
      >
        <Space align="center" wrap>
          <AuthStatus />
          {loadRobots === undefined ? null : (
            <Tag color="gold">Manager 真实账号与目录</Tag>
          )}
          <OrganizationSwitcher />
          <OrganizationAndRobotPicker
            onRobotChange={setRobotId}
            onSelectionChange={onSelectionChange}
            loadRobots={loadRobots}
            robotId={robotId}
          />
          <Button
            onClick={() => {
              void client
                .logout()
                .then(onLogout)
                .catch(() => undefined);
            }}
          >
            退出登录
          </Button>
        </Space>
      </section>
    </>
  );
};

export const PlaygroundAuthGate = ({
  children,
  client,
  onLogout,
  onRealLogin,
  onSelectionChange,
  loadRobots,
  robotId,
}: {
  readonly children: ReactNode;
  readonly client: AuthClient;
  readonly onLogout: () => void;
  readonly onRealLogin: (
    environment: "staging" | "production" | "custom",
    baseUrl: string,
    identifier: string,
    password: string,
  ) => Promise<void>;
  readonly onSelectionChange: (
    organizationId: string,
    robot: PlaygroundRobotDescriptor,
  ) => void;
  readonly loadRobots?:
    | ((
        organizationId: string,
      ) => Promise<readonly PlaygroundRobotDescriptor[]>)
    | undefined;
  readonly robotId: string;
}): ReactNode => (
  <>
    <AuthProvider client={client}>
      <PlaygroundAuthGateContent
        client={client}
        onLogout={onLogout}
        onRealLogin={onRealLogin}
        onSelectionChange={onSelectionChange}
        loadRobots={loadRobots}
        robotId={robotId}
      />
    </AuthProvider>
    {children}
  </>
);

const useAuthSelectorFromClient = <T,>(
  client: AuthClient,
  selector: (snapshot: ReturnType<AuthClient["getSnapshot"]>) => T,
): T => {
  const selectorRef = useRef(selector);
  selectorRef.current = selector;
  const [value, setValue] = useState(() =>
    selectorRef.current(client.getSnapshot()),
  );
  useEffect(() => {
    const update = () => setValue(selectorRef.current(client.getSnapshot()));
    update();
    return client.subscribe(update);
  }, [client]);
  return value;
};
