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
    picker: ManagerChatController<ManagerRobot>;
  }>();
  const report = useRef(props.onDisposeError);
  report.current = props.onDisposeError;
  useEffect(() => {
    const controller = createManagerChatController({
      manager: props.manager,
      chat: props.chat,
      onDisposeError: (error) => report.current?.(error),
    });
    // Candidate catalog loading never releases the active chat client.
    const picker = createManagerChatController({
      manager: props.manager,
      chat: { ...props.chat, platformId: undefined },
      onDisposeError: (error) => report.current?.(error),
    });
    setEntry({
      id: ++sequence.current,
      auth: props.auth,
      manager: props.manager,
      chat: props.chat,
      platformId: props.platformId,
      controller,
      picker,
    });
    return () => {
      void Promise.all([controller.dispose(), picker.dispose()]).catch(
        (error) => report.current?.(error),
      );
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
              picker={entry!.picker}
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
  picker,
  locale = "zh-CN",
  platformId,
  chat: chatConfig,
  restoring,
  brand,
  getPopupContainer,
}: ManagerChatAppProps & {
  controller: ManagerChatController<ManagerRobot>;
  picker: ManagerChatController<ManagerRobot>;
}) {
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
  const candidate = useManagerChat(picker);
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
  const [confirmLogout, setConfirmLogout] = useState(false);
  const selectionReturn = useRef<"settings" | "chat" | "robot">("settings");
  const [restoredDraft, setRestoredDraft] = useState<ChatCompactDraft>();
  const generation = useRef(0);
  const lastScope = useRef(scope);
  const wasExpired = useRef(false);
  const alive = useRef(true);
  const root = useRef<HTMLDivElement>(null);
  const navigationTrigger = useRef<HTMLElement>();
  const openScreen = (next: typeof screen, trigger?: HTMLElement) => {
    const active = trigger ?? root.current?.ownerDocument.activeElement;
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
    void picker.select(undefined);
    setPickedPlatform(undefined);
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
  }, [
    scope,
    authState.status,
    robot,
    chosenPlatform,
    controller,
    manager,
    picker,
  ]);
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
    ) {
      setConfirmLogout(false);
      setConfirm(() => action);
    } else action();
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
    if (alwaysConfirm) {
      setConfirmLogout(true);
      setConfirm(() => action);
    } else navigate(action, true);
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
  const commitSelection = (value: ManagerRobot, id: number | undefined) => {
    if (
      robot?.id === value.id &&
      connection.status === "ready" &&
      connection.platformId === id
    ) {
      setScreen("chat");
      void picker.select(undefined);
      return;
    }
    navigate(() => {
      clearChat();
      setChatAccessDenied(false);
      setRobot(value);
      setChosenPlatform(id);
      setScreen("chat");
      void picker.select(undefined);
      void controller.select(value, { platformId: id });
    }, true);
  };
  const chooseRobot = (value: ManagerRobot) => {
    if (robot?.id === value.id && connection.status === "ready") {
      setScreen("chat");
      return;
    }
    if (
      chatConfig.conversationContract === "json-v2" &&
      platformId === undefined
    ) {
      setPickedRobot(value);
      setPickedPlatform(undefined);
      setScreen("platform");
      void picker.select(value);
    } else commitSelection(value, platformId);
  };
  const openRobot = (trigger?: HTMLElement) => {
    selectionReturn.current = screen === "settings" ? "settings" : "chat";
    setPickedRobot(robot);
    setFailed(false);
    openScreen("robot", trigger);
  };
  const openPlatform = (trigger?: HTMLElement) => {
    if (!robot || platformId !== undefined) return;
    selectionReturn.current = screen === "settings" ? "settings" : "chat";
    setPickedRobot(robot);
    setPickedPlatform(
      typeof connection.platformId === "number"
        ? connection.platformId
        : undefined,
    );
    openScreen("platform", trigger);
    void picker.select(robot);
  };
  const openAccounts = (trigger?: HTMLElement) => {
    selectionReturn.current = screen === "settings" ? "settings" : "chat";
    const rev = generation.current;
    void run(async () => {
      const result = await auth.listAccounts();
      if (rev !== generation.current || !alive.current) return;
      setAccounts(result);
      setPickedAccount(authState.account?.accountId);
      openScreen("accounts", trigger);
    });
  };
  const back = (target?: "settings" | "chat" | "robot") => (
    <Button
      className="tf-back"
      type="text"
      onClick={() => {
        void picker.select(undefined);
        setFailed(false);
        setScreen(target ?? (connection.status === "ready" ? "chat" : "robot"));
      }}
    >
      ←{" "}
      {target === "settings"
        ? copy.backSettings
        : target === "chat"
          ? copy.backChat
          : copy.back}
    </Button>
  );
  const steps = (active: number) => (
    <ol className="tf-steps" aria-label={copy.setup}>
      {[copy.accountStep, copy.robotStep, copy.platformStep].map(
        (label, index) => (
          <li key={label} aria-current={index === active ? "step" : undefined}>
            <span>{index + 1}</span>
            {label}
          </li>
        ),
      )}
    </ol>
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
      <span
        className={`tf-badge ${auth.environment === "staging" ? "tf-test" : ""}`}
      >
        {auth.environment === "staging" ? copy.test : copy.production}
      </span>
    </div>
  );
  const feedback = chatAccessDenied ? (
    <Alert role="alert" type="error" message={copy.forbidden} />
  ) : failed ? (
    <Alert role="alert" type="error" message={copy.failed} />
  ) : null;
  // displayName belongs to an account choice, not necessarily an organization or user.
  const accountLabel = (value: AccountOption | undefined) =>
    value?.organizationName?.trim() ||
    (value?.organizationId
      ? `${copy.organizationId}: ${value.organizationId}`
      : value?.accountId
        ? `${copy.accountLabel}: ${value.accountId}`
        : copy.notSelected);
  const accountDetails = (value: AccountOption) =>
    `${value.displayName?.trim() ? `${copy.accountName}: ${value.displayName} · ` : ""}${value.organizationId ? `${copy.organizationId}: ${value.organizationId} · ` : ""}${copy.accountLabel}: ${value.accountId}`;
  const accountName = accountLabel(authState.account);
  const robotName = (value: ManagerRobot | undefined) => {
    if (!value) return copy.notSelected;
    const name = value.name.trim();
    return name && name !== value.id
      ? name
      : `${copy.directoryId}: ${value.employeeId ?? value.id}`;
  };
  const robotDetails = (value: ManagerRobot) =>
    value.robotId
      ? `${copy.robotId}: ${value.robotId}`
      : `${copy.directoryId}: ${value.employeeId ?? value.id}`;
  const activePlatformId =
    connection.status === "ready" ? connection.platformId : undefined;
  const activePlatform = connection.platforms?.find(
    (p) => p.platformId === activePlatformId,
  );
  const platformName =
    activePlatform?.name?.trim() ||
    (activePlatformId === undefined
      ? copy.notSelected
      : `${copy.platformId}: ${activePlatformId}`);
  const contextRow = (
    label: string,
    value: string,
    detail: string | undefined,
    action?: () => void,
    actionLabel?: string,
    note?: string,
  ) => (
    <div className="tf-context-row">
      <div className="tf-context-copy">
        <span className="tf-context-label">{label}</span>
        <strong>{value}</strong>
        {detail && <small>{detail}</small>}
        {note && <small>{note}</small>}
      </div>
      {action && (
        <Button
          className="tf-change"
          aria-label={actionLabel}
          disabled={busy}
          loading={actionLabel === copy.organization && busy}
          onClick={action}
        >
          {copy.choose}
        </Button>
      )}
    </div>
  );
  const accountView = (
    options: readonly AccountOption[],
    switching: boolean,
  ) => (
    <>
      {top}
      <div className="tf-body">
        {switching ? back(selectionReturn.current) : steps(0)}
        {title(copy.account, copy.accountHint)}
        {authState.user && (
          <p className="tf-identity-hint">
            {copy.userId}: {authState.user.userId}
          </p>
        )}
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
                <strong>{accountLabel(a)}</strong>
                <small>{accountDetails(a)}</small>
              </span>
              {switching && authState.account?.accountId === a.accountId && (
                <span className="tf-current">{copy.current}</span>
              )}
              <span className="tf-check" aria-hidden="true">
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
            if (switching && id === authState.account?.accountId) {
              setScreen(selectionReturn.current);
              return;
            }
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
            showSessionError={authState.status === "error"}
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
    const platformNeeded = screen === "platform";
    const header = (
      <div className="tf-chat-context">
        <div className="tf-top">
          <Button
            className="tf-header-context"
            aria-label={`${copy.organization}: ${accountName}`}
            title={accountName}
            loading={busy}
            onClick={(event) => openAccounts(event.currentTarget)}
          >
            <span className="tf-context-label">{copy.currentOrganization}</span>
            <strong>{accountName} ⌄</strong>
          </Button>
          <span
            className={`tf-badge ${auth.environment === "staging" ? "tf-test" : ""}`}
          >
            {auth.environment === "staging" ? copy.test : copy.production}
          </span>
          <Button
            type="text"
            aria-label={copy.settings}
            onClick={(event) => openScreen("settings", event.currentTarget)}
          >
            ☰
          </Button>
        </div>
        <div className="tf-toolbar">
          <span className="tf-symbol" aria-hidden="true">
            ✧
          </span>
          <Button
            className="tf-header-context"
            type="text"
            aria-label={`${copy.switchRobot}: ${robotName(robot)}`}
            onClick={(event) => openRobot(event.currentTarget)}
          >
            <strong>{robotName(robot)} ⌄</strong>
          </Button>
        </div>
        <div className="tf-platform-context">
          <span>
            {copy.currentPlatform}: <strong>{platformName}</strong>
          </span>
          {platformId === undefined &&
          chatConfig.conversationContract === "json-v2" ? (
            <Button
              size="small"
              aria-label={copy.switchPlatform}
              onClick={(event) => openPlatform(event.currentTarget)}
            >
              {copy.choose}
            </Button>
          ) : (
            <small>
              {platformId !== undefined
                ? copy.fixedPlatform
                : copy.platformUnavailable}
            </small>
          )}
        </div>
      </div>
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
            {back(screen === "help" ? "settings" : undefined)}
            {title(
              screen === "help" ? copy.help : copy.settings,
              screen === "settings" ? copy.settingsHint : undefined,
            )}
            {feedback}
            {screen === "help" ? (
              <p className="tf-description">{copy.helpBody}</p>
            ) : (
              <>
                <section
                  className="tf-settings-group"
                  aria-label={copy.identity}
                >
                  <h2>{copy.identity}</h2>
                  <div className="tf-context-card">
                    {contextRow(
                      copy.userId,
                      authState.account!.userId,
                      undefined,
                    )}
                  </div>
                </section>
                <section
                  className="tf-settings-group"
                  aria-label={copy.currentOrganization}
                >
                  <h2>{copy.currentOrganization}</h2>
                  <div className="tf-context-card">
                    {contextRow(
                      authState.account?.organizationName?.trim()
                        ? copy.currentOrganization
                        : authState.account?.organizationId
                          ? copy.organizationId
                          : copy.accountLabel,
                      accountName,
                      accountDetails(authState.account!),
                      openAccounts,
                      copy.organization,
                      authState.account?.organizationId
                        ? undefined
                        : copy.noOrganization,
                    )}
                  </div>
                </section>
                <section
                  className="tf-settings-group"
                  aria-label={copy.currentWorkspace}
                >
                  <h2>{copy.currentWorkspace}</h2>
                  <div className="tf-context-card">
                    {contextRow(
                      copy.currentRobot,
                      robotName(robot),
                      robot ? robotDetails(robot) : undefined,
                      openRobot,
                      copy.switchRobot,
                      robot && connection.status !== "ready"
                        ? copy.connecting
                        : undefined,
                    )}
                    {contextRow(
                      copy.currentPlatform,
                      platformName,
                      activePlatform?.name
                        ? `${copy.platformId}: ${activePlatformId}`
                        : undefined,
                      robot &&
                        platformId === undefined &&
                        chatConfig.conversationContract === "json-v2"
                        ? openPlatform
                        : undefined,
                      copy.switchPlatform,
                      platformId !== undefined
                        ? `${copy.fixedPlatform} · ${copy.platformId}: ${platformId}`
                        : chatConfig.conversationContract !== "json-v2"
                          ? copy.platformUnavailable
                          : undefined,
                    )}
                  </div>
                </section>
                <section className="tf-settings-group" aria-label={copy.more}>
                  <h2>{copy.more}</h2>
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
                    onClick={(event) => {
                      // WebKit pointer clicks do not focus buttons. Keep Escape inside this app while the dialog opens.
                      event.currentTarget.focus({ preventScroll: true });
                      logout(true);
                    }}
                  >
                    {copy.logout}
                  </Button>
                </section>
              </>
            )}
          </div>
        </>
      );
    else if (screen === "accounts") panel = accountView(accounts, true);
    else if (screen === "robot" || (!robot && !platformNeeded))
      panel = (
        <>
          {top}
          <div className="tf-body">
            {connected ? back(selectionReturn.current) : steps(1)}
            {title(copy.robot, copy.robotHint)}
            <p className="tf-identity-hint">
              {copy.currentOrganization}: {accountName}
            </p>
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
                      <strong>{robotName(r)}</strong>
                      <small>
                        {robotDetails(r)}
                        <br />
                        {r.eligibility === "ready"
                          ? copy.ready
                          : r.eligibility === "not_running"
                            ? copy.notRunning
                            : r.eligibility === "unsupported_template"
                              ? copy.unsupported
                              : copy.incomplete}
                      </small>
                    </span>
                    {robot?.id === r.id && connected && (
                      <span className="tf-current">{copy.current}</span>
                    )}
                    <span className="tf-check" aria-hidden="true">
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
            <Button
              type="link"
              onClick={(event) => openScreen("settings", event.currentTarget)}
            >
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
            {connected ? (
              back(selectionReturn.current)
            ) : (
              <>
                {back("robot")}
                {steps(2)}
              </>
            )}
            {title(copy.platform, copy.platformHint)}
            <p className="tf-identity-hint">
              {copy.currentOrganization}: {accountName}
              <br />
              {copy.selectedRobot}: {robotName(pickedRobot)}
            </p>
            {connected && <p className="tf-description">{copy.switchHint}</p>}
            {candidate.status === "connecting" && (
              <div role="status">
                <Spin />
                <p>{copy.loadingPlatforms}</p>
              </div>
            )}
            {candidate.status === "error" && (
              <Alert
                role="alert"
                type="error"
                message={
                  candidate.error?.code === "authorization"
                    ? copy.forbidden
                    : copy.selectionFailed
                }
                action={
                  <Button
                    onClick={() => {
                      if (pickedRobot) void picker.select(pickedRobot);
                    }}
                  >
                    {copy.retry}
                  </Button>
                }
              />
            )}
            <div className="tf-list">
              {candidate.platforms?.map((p) => (
                <button
                  type="button"
                  className="tf-choice"
                  key={p.platformId}
                  aria-pressed={pickedPlatform === p.platformId}
                  onClick={() => setPickedPlatform(p.platformId)}
                >
                  <span className="tf-choice-copy">
                    <strong>
                      {p.name.trim() || `${copy.platformId}: ${p.platformId}`}
                    </strong>
                    <small>
                      {copy.platformId}: {p.platformId}
                    </small>
                  </span>
                  {connected &&
                    robot?.id === pickedRobot?.id &&
                    activePlatformId === p.platformId && (
                      <span className="tf-current">{copy.current}</span>
                    )}
                  <span className="tf-check" aria-hidden="true">
                    {pickedPlatform === p.platformId ? "✓" : "○"}
                  </span>
                </button>
              ))}
            </div>
            {candidate.status === "platform-selection-required" &&
              !candidate.platforms?.length && (
                <p className="tf-empty">{copy.noPlatforms}</p>
              )}
          </div>
          <div className="tf-footer">
            <Button
              type="primary"
              block
              disabled={
                candidate.status !== "platform-selection-required" ||
                pickedPlatform === undefined ||
                !candidate.platforms?.some(
                  (p) => p.platformId === pickedPlatform,
                )
              }
              onClick={() => {
                if (pickedRobot && pickedPlatform !== undefined)
                  commitSelection(pickedRobot, pickedPlatform);
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
        title={confirmLogout ? copy.logoutTitle : copy.confirmTitle}
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
        {confirmLogout ? copy.logoutBody : copy.confirmBody}
      </Modal>
    </div>
  );
}
