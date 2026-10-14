import {
  Alert,
  Button,
  ConfigProvider,
  Input,
  Modal,
  Spin,
  type ThemeConfig,
} from "antd";
import * as zhCNModule from "antd/es/locale/zh_CN.js";
import * as enUSModule from "antd/es/locale/en_US.js";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
} from "react";
import type { AuthClient, AccountOption } from "@turingfocus/chat-auth";
import { AuthProvider, useAuthSelector } from "@turingfocus/chat-auth/react";
import { LoginPanel } from "@turingfocus/chat-auth/antd";
import {
  managerIdentityScope,
  type ManagerClient,
  type ManagerRobot,
} from "@turingfocus/chat-auth/manager";
import { ChatProvider } from "@turingfocus/chat-react";
import {
  ChatCompactWorkspace,
  type ChatCompactDraft,
} from "@turingfocus/chat-ui-antd";
import {
  createManagerChatController,
  type ManagerChatController,
  type ManagerChatControllerOptions,
} from "./manager.js";
import { useManagerChat } from "./manager-react.js";
import { managerUiCopy } from "./manager-ui-copy.js";
import { managerUiStyle } from "./manager-ui-style.js";

export interface ManagerChatAppProps {
  /** Host-owned clients; the app never disposes them or persists credentials. */
  readonly auth: AuthClient;
  readonly manager: ManagerClient;
  /** Keep this configuration referentially stable. */
  readonly chat: Omit<
    ManagerChatControllerOptions<ManagerRobot>["chat"],
    "platformId"
  > & { readonly platformId?: number | undefined };
  readonly platformId?: number | undefined;
  readonly locale?: "zh-CN" | "en-US" | undefined;
  readonly brand?: ReactNode;
  readonly getPopupContainer?: (() => HTMLElement) | undefined;
  readonly theme?: ThemeConfig | undefined;
  readonly className?: string | undefined;
  readonly style?: CSSProperties | undefined;
  /** Host performs restoration; while true no password form is rendered. */
  readonly restoring?: boolean | undefined;
  readonly onDisposeError?: ((error: unknown) => void) | undefined;
}
const zhCN = (
  zhCNModule as unknown as {
    readonly default: import("antd/es/locale/index.js").Locale;
  }
).default;
const enUS = (
  enUSModule as unknown as {
    readonly default: import("antd/es/locale/index.js").Locale;
  }
).default;
const deadline = () => Date.now() + 15_000;
const defaultTheme: ThemeConfig = {
  token: {
    colorPrimary: "#236653",
    colorText: "#293832",
    colorTextSecondary: "#647366",
    colorBorder: "#d7e0d9",
    colorBgContainer: "#ffffff",
    borderRadius: 8,
    fontSize: 14,
  },
};

/** Opt-in complete interface. Owns only its connection controller and local UI. */
export function ManagerChatApp(props: ManagerChatAppProps) {
  const sequence = useRef(0);
  const appRoot = useRef<HTMLDivElement>(null);
  const [entry, setEntry] = useState<{
    id: number;
    auth: AuthClient;
    manager: ManagerClient;
    chat: ManagerChatAppProps["chat"];
    platformId: number | undefined;
    controller: ManagerChatController<ManagerRobot>;
  }>();
  const report = useRef(props.onDisposeError);
  report.current = props.onDisposeError;
  useEffect(() => {
    const controller = createManagerChatController({
      manager: props.manager,
      chat: props.chat,
      onDisposeError: (error) => report.current?.(error),
    });
    setEntry({
      id: ++sequence.current,
      auth: props.auth,
      manager: props.manager,
      chat: props.chat,
      platformId: props.platformId,
      controller,
    });
    return () => {
      void controller.dispose().catch((error) => report.current?.(error));
    };
  }, [props.manager, props.chat, props.auth, props.platformId]);
  const active =
    entry?.auth === props.auth &&
    entry.manager === props.manager &&
    entry.chat === props.chat &&
    entry.platformId === props.platformId
      ? entry.controller
      : undefined;
  return (
    <ConfigProvider
      button={{ autoInsertSpace: false }}
      locale={props.locale === "en-US" ? enUS : zhCN}
      getPopupContainer={props.getPopupContainer ?? (() => appRoot.current!)}
      modal={{
        styles: {
          mask: { position: "absolute" },
          wrapper: { position: "absolute" },
        },
      }}
      theme={{
        ...defaultTheme,
        ...props.theme,
        token: { ...defaultTheme.token, ...props.theme?.token },
      }}
    >
      <AuthProvider client={props.auth}>
        <div
          ref={appRoot}
          className={`tf-manager-app ${props.className ?? ""}`}
          style={
            {
              "--tf-manager-primary":
                props.theme?.token?.colorPrimary ?? "#236653",
              "--tf-manager-bg": props.theme?.token?.colorBgContainer ?? "#fff",
              "--tf-manager-text": props.theme?.token?.colorText ?? "#293832",
              "--tf-manager-secondary":
                props.theme?.token?.colorTextSecondary ?? "#647366",
              "--tf-manager-border":
                props.theme?.token?.colorBorder ?? "#d7e0d9",
              ...props.style,
            } as CSSProperties
          }
        >
          <style>{managerUiStyle}</style>
          {active ? (
            <ManagerAppBinding
              key={entry?.id}
              {...props}
              platformId={props.platformId ?? props.chat.platformId}
              controller={active}
            />
          ) : (
            <Spin />
          )}
        </div>
      </AuthProvider>
    </ConfigProvider>
  );
}

function ManagerAppBinding({
  auth,
  manager,
  controller,
  locale = "zh-CN",
  platformId,
  restoring,
  brand,
  getPopupContainer,
}: ManagerChatAppProps & { controller: ManagerChatController<ManagerRobot> }) {
  const copy = managerUiCopy[locale];
  const authState = useAuthSelector((s) => s);
  const scope = managerIdentityScope(authState);
  const directory = useSyncExternalStore(
    useCallback((cb) => manager.subscribe(cb), [manager]),
    useCallback(() => manager.getSnapshot(), [manager]),
    useCallback(() => manager.getSnapshot(), [manager]),
  );
  const accessDenied = directory.error?.code === "authorization";
  const connection = useManagerChat(controller);
  const clientKey = useRef({ client: connection.client, id: 0 });
  if (clientKey.current.client !== connection.client)
    clientKey.current = {
      client: connection.client,
      id: clientKey.current.id + 1,
    };
  const [screen, setScreen] = useState<
    "chat" | "robot" | "accounts" | "settings" | "platform" | "help"
  >("robot");
  const [robot, setRobot] = useState<ManagerRobot>();
  const [pickedRobot, setPickedRobot] = useState<ManagerRobot>();
  const [pickedPlatform, setPickedPlatform] = useState<number>();
  const [chosenPlatform, setChosenPlatform] = useState<number>();
  const [accounts, setAccounts] = useState<readonly AccountOption[]>([]);
  const [pickedAccount, setPickedAccount] = useState<string>();
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [chatAccessDenied, setChatAccessDenied] = useState(false);
  const [confirm, setConfirm] = useState<() => void>();
  const [restoredDraft, setRestoredDraft] = useState<ChatCompactDraft>();
  const generation = useRef(0);
  const lastScope = useRef(scope);
  const wasExpired = useRef(false);
  const alive = useRef(true);
  const root = useRef<HTMLDivElement>(null);
  const navigationTrigger = useRef<HTMLElement>();
  const openScreen = (next: typeof screen) => {
    const active = root.current?.ownerDocument.activeElement;
    if (
      screen === "chat" &&
      active instanceof HTMLElement &&
      root.current?.contains(active)
    )
      navigationTrigger.current = active;
    setScreen(next);
  };
  useEffect(() => {
    if (screen === "chat" && navigationTrigger.current?.isConnected)
      navigationTrigger.current.focus({ preventScroll: true });
  }, [screen]);
  useEffect(() => {
    const target = root.current?.querySelector<HTMLElement>(
      ".tf-screen h1, .tf-login h1, .tf-body h1",
    );
    if (target) {
      target.tabIndex = -1;
      target.focus({ preventScroll: true });
    }
  }, [screen, scope, authState.status]);
  const activity = useRef({
    running: false,
    draft: { text: "" } as ChatCompactDraft,
  });
  const retained = useRef<{
    scope: string;
    robot: ManagerRobot;
    platformId?: number | undefined;
    draft: ChatCompactDraft;
  }>();
  const busyRef = useRef(false);
  const onActivityChange = useCallback(
    (value: { running: boolean; draft: ChatCompactDraft }) => {
      activity.current = value;
    },
    [],
  );
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      generation.current++;
    };
  }, []);
  useEffect(() => {
    if (scope === lastScope.current) {
      if (
        !scope &&
        (authState.status === "signed_out" || authState.status === "disposed")
      ) {
        retained.current = undefined;
        wasExpired.current = false;
      }
      return;
    }
    const previous = lastScope.current;
    lastScope.current = scope;
    generation.current++;
    busyRef.current = false;
    setBusy(false);
    setFailed(false);
    setChatAccessDenied(false);
    setConfirm(undefined);
    setAccounts([]);
    setPickedAccount(undefined);
    setQuery("");
    if (!scope) {
      wasExpired.current = authState.status === "auth_required";
      if (wasExpired.current && previous && robot)
        retained.current = {
          scope: previous,
          robot,
          platformId: chosenPlatform,
          draft: activity.current.draft,
        };
      else retained.current = undefined;
      setRobot(undefined);
      setPickedRobot(undefined);
      setChosenPlatform(undefined);
      setPickedPlatform(undefined);
      setRestoredDraft(undefined);
      setScreen("robot");
      return;
    }
    const resume = retained.current;
    retained.current = undefined;
    if (wasExpired.current && resume?.scope === scope) {
      setRobot(resume.robot);
      setPickedRobot(resume.robot);
      setChosenPlatform(resume.platformId);
      setRestoredDraft(resume.draft);
      setScreen("chat");
      void controller.select(resume.robot, { platformId: resume.platformId });
    } else {
      setRobot(undefined);
      setPickedRobot(undefined);
      setChosenPlatform(undefined);
      setRestoredDraft(undefined);
      setScreen("robot");
    }
    wasExpired.current = false;
    void manager.refresh({ deadlineAt: deadline() }).catch(() => {});
  }, [scope, authState.status, robot, chosenPlatform, controller, manager]);
  useEffect(() => {
    if (scope && directory.status === "idle")
      void manager.refresh({ deadlineAt: deadline() }).catch(() => {});
  }, [scope, manager, directory.status]);
  useEffect(() => {
    if (!accessDenied) return;
    generation.current++;
    busyRef.current = false;
    setBusy(false);
    retained.current = undefined;
    activity.current = { running: false, draft: { text: "" } };
    setRestoredDraft(undefined);
    setRobot(undefined);
    setPickedRobot(undefined);
    setPickedPlatform(undefined);
    setChosenPlatform(undefined);
    setScreen("robot");
    void controller.select(undefined);
  }, [accessDenied, controller]);
  const run = async (action: () => Promise<unknown>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setFailed(false);
    const revision = generation.current;
    try {
      await action();
    } catch {
      if (alive.current && revision === generation.current) setFailed(true);
    } finally {
      if (alive.current && revision === generation.current) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  };
  const navigate = (action: () => void, identity = false) => {
    if (busyRef.current) return;
    if (
      identity &&
      (activity.current.running || activity.current.draft.text.trim())
    )
      setConfirm(() => action);
    else action();
  };
  const clearChat = () => {
    generation.current++;
    setRobot(undefined);
    setRestoredDraft(undefined);
    setChosenPlatform(undefined);
    setPickedPlatform(undefined);
    activity.current = { running: false, draft: { text: "" } };
    retained.current = undefined;
    void controller.select(undefined);
  };
  const logout = (alwaysConfirm = false) => {
    if (busyRef.current) return;
    const action = () => {
      clearChat();
      void run(() => auth.logout());
    };
    if (alwaysConfirm) setConfirm(() => action);
    else navigate(action, true);
  };
  const onAccessDenied = useCallback(() => {
    generation.current++;
    retained.current = undefined;
    activity.current = { running: false, draft: { text: "" } };
    setRestoredDraft(undefined);
    setRobot(undefined);
    setPickedRobot(undefined);
    setChosenPlatform(undefined);
    setPickedPlatform(undefined);
    setChatAccessDenied(true);
    setScreen("robot");
    void controller.select(undefined);
  }, [controller]);
  const chooseRobot = (value: ManagerRobot) =>
    navigate(() => {
      clearChat();
      setChatAccessDenied(false);
      setRobot(value);
      setScreen("chat");
      setChosenPlatform(platformId);
      void controller.select(value, { platformId });
    }, true);
  const back = () => (
    <Button
      className="tf-back"
      type="text"
      onClick={() =>
        setScreen(connection.status === "ready" ? "chat" : "robot")
      }
    >
      ← {copy.back}
    </Button>
  );
  const title = (heading: string, description?: string) => (
    <>
      <h1>{heading}</h1>
      {description && <p className="tf-description">{description}</p>}
    </>
  );
  const top = (
    <div className="tf-top">
      <div className="tf-brand">
        <span className="tf-symbol">✧</span>
        {brand ?? copy.brand}
      </div>
      {auth.environment === "staging" ? (
        <span className="tf-badge">{copy.test}</span>
      ) : null}
    </div>
  );
  const feedback = chatAccessDenied ? (
    <Alert role="alert" type="error" message={copy.forbidden} />
  ) : failed ? (
    <Alert role="alert" type="error" message={copy.failed} />
  ) : null;
  const accountName =
    authState.account?.displayName ??
    authState.account?.organizationId ??
    authState.account?.accountId;
  const accountView = (
    options: readonly AccountOption[],
    switching: boolean,
  ) => (
    <>
      {top}
      <div className="tf-body">
        {switching && back()}
        {title(copy.account, copy.accountHint)}
        {feedback}
        <div className="tf-list">
          {options.map((a) => (
            <button
              type="button"
              className="tf-choice"
              key={a.accountId}
              aria-pressed={pickedAccount === a.accountId}
              disabled={busy}
              onClick={() => setPickedAccount(a.accountId)}
            >
              <span className="tf-symbol">▦</span>
              <span className="tf-choice-copy">
                <strong>
                  {a.displayName ?? a.organizationId ?? a.accountId}
                </strong>
                <small>
                  {copy.accountLabel}: {a.accountId}
                </small>
              </span>
              <span className="tf-check">
                {pickedAccount === a.accountId ? "✓" : "○"}
              </span>
            </button>
          ))}
        </div>
        {!options.length && <p>{copy.emptyAccounts}</p>}
      </div>
      <div className="tf-footer">
        <Button
          block
          type="primary"
          disabled={!pickedAccount}
          loading={busy}
          onClick={() => {
            if (!pickedAccount) return;
            const id = pickedAccount;
            navigate(() => {
              if (switching) clearChat();
              void run(async () => {
                if (switching) await auth.switchAccount(id);
                else await auth.selectAccount(id);
              });
            }, switching);
          }}
        >
          {copy.enterAccount}
        </Button>
        <Button
          type="link"
          onClick={() => {
            logout();
          }}
        >
          {copy.otherAccount}
        </Button>
      </div>
    </>
  );
  let body: ReactNode;
  if (restoring)
    body = (
      <>
        {top}
        <div className="tf-body">
          <Spin />
          <p role="status">{copy.restore}</p>
        </div>
      </>
    );
  else if (authState.status === "disposed")
    body = (
      <>
        {top}
        <Alert message={copy.unavailable} />
      </>
    );
  else if (authState.status === "account_selection_required")
    body = accountView(authState.accounts, false);
  else if (authState.status === "onboarding_required")
    body = (
      <>
        {top}
        <div className="tf-body">
          <Alert type="info" message={copy.onboarding} />
          <Button
            onClick={() => {
              logout();
            }}
          >
            {copy.otherAccount}
          </Button>
        </div>
      </>
    );
  else if (authState.status === "switching")
    body = (
      <>
        {top}
        <div className="tf-body">
          <Spin />
          <p role="status">{copy.switching}</p>
        </div>
      </>
    );
  else if (!scope)
    body = (
      <>
        {top}
        <div className="tf-body tf-login">
          <span className="tf-symbol">✧</span>
          {title(
            copy.welcome,
            authState.status === "auth_required"
              ? copy.expired
              : copy.loginHint,
          )}
          <LoginPanel
            showSessionError={false}
            labels={{
              login: copy.login,
              identifier: copy.identifier,
              password: copy.passwordLabel,
              errors: {
                invalid_credentials: copy.loginUnavailable,
                authentication_required: copy.loginUnavailable,
                authorization_denied: copy.forbidden,
                invalid_response: copy.failed,
                network: copy.failed,
                unsupported: copy.unavailable,
                disposed: copy.unavailable,
                cancelled: copy.failed,
                unknown: copy.failed,
              },
            }}
          />
        </div>
      </>
    );
  else {
    const staleIdentity = lastScope.current !== scope;
    const connected =
      !staleIdentity &&
      !accessDenied &&
      connection.status === "ready" &&
      connection.client &&
      robot;
    const platformNeeded =
      connection.status === "platform-selection-required" ||
      screen === "platform";
    const header = (
      <>
        <div className="tf-top">
          <Button
            type="text"
            style={{
              maxWidth: "85%",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
            onClick={() => openScreen("settings")}
          >
            {accountName} ⌄
          </Button>
          <Button
            type="text"
            aria-label={copy.settings}
            onClick={() => openScreen("settings")}
          >
            ☰
          </Button>
        </div>
        <div className="tf-toolbar">
          <span className="tf-symbol">✧</span>
          <Button
            type="text"
            style={{ height: "auto", textAlign: "left", minWidth: 0 }}
            onClick={() => openScreen("robot")}
          >
            <strong>{robot?.name} ⌄</strong>
            <small>
              {connection.platformId === undefined
                ? ""
                : (connection.platforms?.find(
                    (p) => p.platformId === connection.platformId,
                  )?.name ??
                  `${locale === "zh-CN" ? "平台" : "Platform"} ${connection.platformId}`)}
            </small>
          </Button>
        </div>
      </>
    );
    const chat = connected ? (
      <ChatProvider client={connection.client!}>
        <ChatCompactWorkspace
          key={clientKey.current.id}
          header={header}
          locale={locale}
          getDeadlineAt={deadline}
          onActivityChange={onActivityChange}
          restoredDraft={restoredDraft}
          onAccessDenied={onAccessDenied}
          getPopupContainer={getPopupContainer}
        />
      </ChatProvider>
    ) : null;
    let panel: ReactNode = null;
    if (staleIdentity) panel = <Spin />;
    else if (screen === "settings" || screen === "help")
      panel = (
        <>
          {top}
          <div className="tf-body">
            {back()}
            {title(screen === "help" ? copy.help : copy.settings)}
            {feedback}
            {screen === "help" ? (
              <p className="tf-description">{copy.helpBody}</p>
            ) : (
              <>
                <p>{accountName}</p>
                <Button
                  className="tf-menu"
                  type="text"
                  onClick={() => {
                    const rev = generation.current;
                    void run(async () => {
                      const result = await auth.listAccounts();
                      if (rev !== generation.current || !alive.current) return;
                      setAccounts(result);
                      setPickedAccount(undefined);
                      setScreen("accounts");
                    });
                  }}
                >
                  {copy.organization}
                </Button>
                <Button
                  className="tf-menu"
                  type="text"
                  onClick={() => openScreen("robot")}
                >
                  {copy.switchRobot}
                </Button>
                {robot && platformId === undefined && (
                  <Button
                    className="tf-menu"
                    type="text"
                    onClick={() =>
                      navigate(() => {
                        clearChat();
                        setRobot(robot);
                        setScreen("chat");
                        void controller.select(robot);
                      }, true)
                    }
                  >
                    {copy.switchPlatform}
                  </Button>
                )}
                <Button
                  className="tf-menu"
                  type="text"
                  onClick={() => setScreen("help")}
                >
                  {copy.help}
                </Button>
                <Button
                  className="tf-menu"
                  danger
                  type="text"
                  onClick={() => logout(true)}
                >
                  {copy.logout}
                </Button>
              </>
            )}
          </div>
        </>
      );
    else if (screen === "accounts") panel = accountView(accounts, true);
    else if (screen === "robot" || !robot)
      panel = (
        <>
          {top}
          <div className="tf-body">
            {connected && back()}
            {title(copy.robot, `${accountName ?? ""} · ${copy.robotHint}`)}
            {feedback}
            <Input
              aria-label={copy.search}
              placeholder={copy.search}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            {directory.status === "error" ? (
              <Alert
                role="alert"
                type="error"
                message={
                  directory.error?.code === "authorization"
                    ? copy.forbidden
                    : copy.failed
                }
                action={
                  <Button
                    onClick={() => {
                      void manager
                        .refresh({ deadlineAt: deadline() })
                        .catch(() => {});
                    }}
                  >
                    {copy.retry}
                  </Button>
                }
              />
            ) : null}
            {directory.status === "loading" && <Spin />}
            <div className="tf-list">
              {(accessDenied ? [] : directory.items)
                .filter((r) =>
                  r.name.toLowerCase().includes(query.toLowerCase()),
                )
                .map((r) => (
                  <button
                    className="tf-choice"
                    type="button"
                    key={r.id}
                    disabled={!r.canAutoConnect}
                    aria-pressed={pickedRobot?.id === r.id}
                    onClick={() => setPickedRobot(r)}
                  >
                    <span className="tf-symbol">✧</span>
                    <span className="tf-choice-copy">
                      <strong>{r.name}</strong>
                      <small>
                        {r.eligibility === "ready"
                          ? copy.ready
                          : r.eligibility === "not_running"
                            ? copy.notRunning
                            : r.eligibility === "unsupported_template"
                              ? copy.unsupported
                              : copy.incomplete}
                      </small>
                    </span>
                    <span className="tf-check">
                      {pickedRobot?.id === r.id ? "✓" : "○"}
                    </span>
                  </button>
                ))}
            </div>
            {directory.status === "ready" && !directory.items.length ? (
              <p className="tf-empty">{copy.noRobots}</p>
            ) : null}
            {query &&
              directory.items.length > 0 &&
              !directory.items.some((r) =>
                r.name.toLowerCase().includes(query.toLowerCase()),
              ) && <p role="status">{copy.noMatch}</p>}
            {directory.pagination?.hasMore ? (
              <Button
                loading={directory.status === "loading"}
                onClick={() => {
                  void manager
                    .loadPage((directory.pagination?.page ?? 1) + 1, 20, {
                      deadlineAt: deadline(),
                    })
                    .catch(() => {});
                }}
              >
                {copy.loadMore}
              </Button>
            ) : null}
            <Button type="link" onClick={() => openScreen("settings")}>
              {copy.settings}
            </Button>
          </div>
          <div className="tf-footer">
            <Button
              type="primary"
              block
              disabled={
                !pickedRobot?.canAutoConnect || directory.status !== "ready"
              }
              onClick={() => {
                if (pickedRobot) chooseRobot(pickedRobot);
              }}
            >
              {copy.useRobot}
            </Button>
          </div>
        </>
      );
    else if (platformNeeded)
      panel = (
        <>
          {top}
          <div className="tf-body">
            <Button
              type="text"
              onClick={() => {
                void controller.select(undefined);
                setScreen("robot");
              }}
            >
              ← {copy.back}
            </Button>
            {title(copy.platform, copy.platformHint)}
            <div className="tf-list">
              {connection.platforms?.map((p) => (
                <button
                  type="button"
                  className="tf-choice"
                  key={p.platformId}
                  aria-pressed={pickedPlatform === p.platformId}
                  onClick={() => setPickedPlatform(p.platformId)}
                >
                  <span className="tf-choice-copy">
                    <strong>{p.name}</strong>
                  </span>
                  <span className="tf-check">
                    {pickedPlatform === p.platformId ? "✓" : "○"}
                  </span>
                </button>
              ))}
            </div>
            {!connection.platforms?.length && <p>{copy.noPlatforms}</p>}
          </div>
          <div className="tf-footer">
            <Button
              type="primary"
              block
              disabled={pickedPlatform === undefined}
              onClick={() => {
                if (!robot || pickedPlatform === undefined) return;
                setChosenPlatform(pickedPlatform);
                setScreen("chat");
                void controller.select(robot, { platformId: pickedPlatform });
              }}
            >
              {copy.start}
            </Button>
          </div>
        </>
      );
    else if (!connected)
      panel = (
        <>
          {top}
          <div className="tf-body">
            <Button
              type="text"
              onClick={() => {
                void controller.select(undefined);
                setScreen("robot");
              }}
            >
              ← {copy.back}
            </Button>
            {connection.status === "error" ? (
              <Alert
                role="alert"
                type="error"
                message={
                  connection.error?.code === "authorization"
                    ? copy.forbidden
                    : copy.failed
                }
                action={
                  <Button
                    onClick={() => {
                      if (robot)
                        void controller.select(robot, {
                          platformId: chosenPlatform,
                        });
                    }}
                  >
                    {copy.retry}
                  </Button>
                }
              />
            ) : (
              <>
                <Spin />
                <p role="status">{copy.connecting}</p>
              </>
            )}
          </div>
        </>
      );
    body = (
      <div className="tf-chat">
        <div style={{ height: "100%", display: panel ? "none" : undefined }}>
          {chat}
        </div>
        {panel && <div className="tf-screen">{panel}</div>}
      </div>
    );
  }
  return (
    <div
      ref={root}
      onKeyDownCapture={(event) => {
        if (event.key === "Escape" && confirm) {
          event.stopPropagation();
          setConfirm(undefined);
        }
      }}
      style={{
        display: "flex",
        flexDirection: "column",
        flex: 1,
        minHeight: 0,
        position: "relative",
        overflow: "hidden",
      }}
    >
      {body}
      <Modal
        getContainer={getPopupContainer ?? false}
        open={!!confirm}
        title={copy.confirmTitle}
        onCancel={() => setConfirm(undefined)}
        onOk={() => {
          const action = confirm;
          setConfirm(undefined);
          action?.();
        }}
        okText={copy.confirm}
        cancelText={copy.cancel}
        width="calc(100% - 32px)"
        styles={{
          mask: { position: "absolute" },
          wrapper: { position: "absolute" },
        }}
      >
        {copy.confirmBody}
      </Modal>
    </div>
  );
}
