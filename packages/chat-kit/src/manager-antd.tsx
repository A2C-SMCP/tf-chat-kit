import {
  Alert,
  Button,
  ConfigProvider,
  Input,
  Modal,
  Spin,
  Tooltip,
  type ThemeConfig,
} from "antd";
import * as zhCNModule from "antd/es/locale/zh_CN.js";
import * as enUSModule from "antd/es/locale/en_US.js";
import {
  useCallback,
  useEffect,
  useMemo,
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
  type ManagerRobotConnection,
} from "@turingfocus/chat-auth/manager";
import {
  ChatProvider,
  useHasInteractionProvider,
  type InteractionClient,
} from "@turingfocus/chat-react";
import { orderConversationsByUpdatedAt } from "@turingfocus/chat-runtime";
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
import { createTFRobotInteractionClient } from "./tfrobot-client.js";

import {
  managerChatIdentityScope,
  managerChatInlineVisible,
  resolveManagerInteractionClient,
  type ManagerChatIdentity,
} from "./manager-identity.js";

export {
  managerChatIdentityMatches,
  managerChatIdentityScope,
  managerChatInlineVisible,
  resolveManagerInteractionClient,
  type ManagerChatIdentity,
} from "./manager-identity.js";

export interface ManagerChatAppProps {
  readonly debug?: boolean | undefined;
  /** Show Auto / Split / Modal controls; defaults to true, independently of debug. */
  readonly showEventDetailModeSelector?: boolean | undefined;
  /** Host-controlled request budget; defaults to 15 seconds, maximum 60 seconds. */
  readonly requestTimeoutMs?: number | undefined;
  /** Host-owned clients; the app never disposes them or persists credentials. */
  readonly auth: AuthClient;
  readonly manager: ManagerClient;
  /** Omit to inherit a host provider or use the managed connection. Pass null to disable. */
  readonly interactionClient?: InteractionClient | null | undefined;
  /**
   * Identity of the injected client. Required for a non-null client unless the
   * host explicitly opts into an unscoped client; a mismatch disables
   * Interaction UI.
   */
  readonly interactionIdentity?: ManagerChatIdentity | undefined;
  /**
   * Explicit opt-in to use a non-null client without an asserted identity.
   * Defaults to false because Manager can switch accounts and robots.
   */
  readonly allowUnscopedInteractionClient?: boolean | undefined;
  /**
   * Explicit opt-in to treat omitted identity fields as wildcards. Defaults to
   * false: every asserted field must match the current Manager identity.
   */
  readonly allowWildcardInteractionIdentity?: boolean | undefined;
  /** Called when the internal robot/platform/account identity changes. */
  readonly onChatIdentityChange?:
    ((identity: ManagerChatIdentity | undefined) => void) | undefined;
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
  /** Chat reading width. Defaults to the full available width; numbers are CSS pixels. */
  readonly contentMaxWidth?: CSSProperties["maxWidth"] | undefined;
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

type WorkspaceChoice = "robot" | "accounts" | "platform";
type ChoiceBack = Exclude<WorkspaceChoice, "platform"> | "chat" | "settings";

/** Opt-in complete interface. Owns only its connection controller and local UI. */
export function ManagerChatApp(props: ManagerChatAppProps) {
  if (
    props.requestTimeoutMs !== undefined &&
    (!Number.isFinite(props.requestTimeoutMs) ||
      props.requestTimeoutMs <= 0 ||
      props.requestTimeoutMs > 60_000)
  )
    throw new TypeError("Invalid Manager request timeout");
  if (
    props.interactionClient !== undefined &&
    props.interactionClient !== null &&
    props.interactionIdentity === undefined &&
    props.allowUnscopedInteractionClient !== true
  )
    throw new TypeError(
      "ManagerChatApp requires interactionIdentity for a non-null interactionClient; set allowUnscopedInteractionClient to opt into an unscoped client",
    );
  if (
    props.interactionIdentity !== undefined &&
    props.interactionIdentity.robotId.trim().length === 0
  )
    throw new TypeError(
      "ManagerChatApp interactionIdentity requires a robotId",
    );
  const requestBudget = useRef(props.requestTimeoutMs ?? 15_000);
  requestBudget.current = props.requestTimeoutMs ?? 15_000;
  const getDeadlineAt = useCallback(
    () => Date.now() + requestBudget.current,
    [],
  );
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
    const chat: ManagerChatAppProps["chat"] = {
      ...props.chat,
      conversationListOrder: props.chat.conversationListOrder ?? "newest-first",
    };
    const controller = createManagerChatController({
      manager: props.manager,
      chat,
      getDeadlineAt,
      onDisposeError: (error) => report.current?.(error),
    });
    // Candidate catalog loading never releases the active chat client.
    const picker = createManagerChatController({
      manager: props.manager,
      chat: { ...chat, platformId: undefined },
      getDeadlineAt,
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
  }, [props.manager, props.chat, props.auth, props.platformId, getDeadlineAt]);
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
              "--tf-manager-content-max-width":
                typeof props.contentMaxWidth === "number"
                  ? `${props.contentMaxWidth}px`
                  : (props.contentMaxWidth ?? "none"),
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
  interactionClient,
  interactionIdentity,
  allowUnscopedInteractionClient = false,
  allowWildcardInteractionIdentity = false,
  onChatIdentityChange,
  debug = false,
  showEventDetailModeSelector = true,
  requestTimeoutMs = 15_000,
}: ManagerChatAppProps & {
  controller: ManagerChatController<ManagerRobot>;
  picker: ManagerChatController<ManagerRobot>;
}) {
  const copy = managerUiCopy[locale];
  const requestBudget = useRef(requestTimeoutMs);
  requestBudget.current = requestTimeoutMs;
  const deadline = useCallback(() => Date.now() + requestBudget.current, []);
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
  const [platformChoice, setPlatformChoice] = useState<{
    robot: ManagerRobot;
    back: ChoiceBack;
    autoSelect: boolean;
  }>();
  const [chosenPlatform, setChosenPlatform] = useState<number>();
  const [accounts, setAccounts] = useState<readonly AccountOption[]>([]);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [chatAccessDenied, setChatAccessDenied] = useState(false);
  const [confirm, setConfirm] = useState<() => void>();
  const [confirmLogout, setConfirmLogout] = useState(false);
  const selectionReturn = useRef<"settings" | "chat" | "robot">("robot");
  const chatReturn = useRef<{
    target: WorkspaceChoice;
    platformBack: "robot" | "accounts";
  }>({ target: "robot", platformBack: "robot" });
  const autoSelectRobot = useRef(true);
  const attemptedInitialAccount = useRef(false);
  const manuallySelectedAccount = useRef<string>();
  const [restoredDraft, setRestoredDraft] = useState<ChatCompactDraft>();
  const generation = useRef(0);
  const lastScope = useRef(scope);
  const staleIdentity = lastScope.current !== scope;
  const activeChatClient =
    scope && !staleIdentity && !accessDenied && connection.status === "ready"
      ? connection.client
      : undefined;
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
  const pendingAction = useRef<object>();
  const invalidateSelection = useCallback(() => {
    generation.current++;
    pendingAction.current = undefined;
    setBusy(false);
    setConfirm(undefined);
  }, []);
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
        manuallySelectedAccount.current = undefined;
      }
      return;
    }
    const previous = lastScope.current;
    lastScope.current = scope;
    invalidateSelection();
    setFailed(false);
    setChatAccessDenied(false);
    void picker.select(undefined);
    setPlatformChoice(undefined);
    setAccounts([]);
    setQuery("");
    selectionReturn.current = "robot";
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
      setChosenPlatform(undefined);
      setRestoredDraft(undefined);
      setScreen("robot");
      return;
    }
    const resume = retained.current;
    retained.current = undefined;
    if (wasExpired.current && resume?.scope === scope) {
      setRobot(resume.robot);
      setChosenPlatform(resume.platformId);
      setRestoredDraft(resume.draft);
      setScreen("chat");
      void controller.select(resume.robot, { platformId: resume.platformId });
    } else {
      autoSelectRobot.current = true;
      chatReturn.current = { target: "robot", platformBack: "robot" };
      setRobot(undefined);
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
    invalidateSelection,
    manager,
    picker,
  ]);
  useEffect(() => {
    if (scope && directory.status === "idle")
      void manager.refresh({ deadlineAt: deadline() }).catch(() => {});
  }, [scope, manager, directory.status]);
  useEffect(() => {
    if (!accessDenied) return;
    invalidateSelection();
    autoSelectRobot.current = false;
    retained.current = undefined;
    activity.current = { running: false, draft: { text: "" } };
    setRestoredDraft(undefined);
    setRobot(undefined);
    setPlatformChoice(undefined);
    setChosenPlatform(undefined);
    setScreen("robot");
    void picker.select(undefined);
    void controller.select(undefined);
  }, [accessDenied, controller, invalidateSelection, picker]);
  const run = async (action: () => Promise<unknown>) => {
    if (pendingAction.current) return;
    const operation = {};
    pendingAction.current = operation;
    setBusy(true);
    setFailed(false);
    const revision = generation.current;
    try {
      await action();
    } catch {
      if (alive.current && revision === generation.current) setFailed(true);
    } finally {
      if (alive.current && pendingAction.current === operation) {
        pendingAction.current = undefined;
        setBusy(false);
      }
    }
  };
  const navigate = (action: () => void, identity = false) => {
    if (pendingAction.current) return;
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
    activity.current = { running: false, draft: { text: "" } };
    retained.current = undefined;
    void controller.select(undefined);
  };
  const logout = (alwaysConfirm = false) => {
    if (pendingAction.current) return;
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
    invalidateSelection();
    autoSelectRobot.current = false;
    retained.current = undefined;
    activity.current = { running: false, draft: { text: "" } };
    setRestoredDraft(undefined);
    setRobot(undefined);
    setPlatformChoice(undefined);
    setChosenPlatform(undefined);
    setChatAccessDenied(true);
    setScreen("robot");
    void picker.select(undefined);
    void controller.select(undefined);
  }, [controller, invalidateSelection, picker]);
  const cancelPlatformChoice = () => {
    void picker.select(undefined);
    setPlatformChoice(undefined);
  };
  const commitSelection = (
    value: ManagerRobot,
    id: number | undefined,
    returnTo: WorkspaceChoice,
  ) => {
    if (
      robot?.id === value.id &&
      connection.status === "ready" &&
      connection.platformId === id
    ) {
      setScreen("chat");
      cancelPlatformChoice();
      return;
    }
    navigate(() => {
      clearChat();
      setChatAccessDenied(false);
      setRobot(value);
      setChosenPlatform(id);
      chatReturn.current = {
        target: returnTo,
        platformBack:
          platformChoice?.back === "accounts" ? "accounts" : "robot",
      };
      setScreen("chat");
      cancelPlatformChoice();
      void controller.select(value, { platformId: id });
    }, true);
  };
  const openPlatformChoice = (
    value: ManagerRobot,
    back: ChoiceBack,
    autoSelect: boolean,
    trigger?: HTMLElement,
  ) => {
    setPlatformChoice({ robot: value, back, autoSelect });
    openScreen("platform", trigger);
    void picker.select(value);
  };
  const chooseRobot = (value: ManagerRobot, automatic = false) => {
    if (pendingAction.current) return;
    autoSelectRobot.current = false;
    if (robot?.id === value.id && activeChatClient) {
      setScreen("chat");
      return;
    }
    const robotReturn =
      automatic &&
      manuallySelectedAccount.current !== undefined &&
      manuallySelectedAccount.current === authState.account?.accountId
        ? "accounts"
        : "robot";
    if (
      chatConfig.conversationContract === "json-v2" &&
      platformId === undefined
    ) {
      openPlatformChoice(value, robotReturn, !activeChatClient);
    } else commitSelection(value, platformId, robotReturn);
  };
  const choosePlatform = (id: number, automatic = false) => {
    if (
      !platformChoice ||
      picker.getSnapshot() !== candidate ||
      candidate.status !== "platform-selection-required" ||
      !candidate.platforms?.some((platform) => platform.platformId === id)
    )
      return;
    const back = platformChoice.back;
    commitSelection(
      platformChoice.robot,
      id,
      automatic && (back === "robot" || back === "accounts")
        ? back
        : "platform",
    );
  };
  const openRobot = (trigger?: HTMLElement) => {
    autoSelectRobot.current = false;
    selectionReturn.current = screen === "settings" ? "settings" : "chat";
    setFailed(false);
    openScreen("robot", trigger);
  };
  const openPlatform = (trigger?: HTMLElement) => {
    if (!robot || platformId !== undefined) return;
    openPlatformChoice(
      robot,
      screen === "settings" ? "settings" : "chat",
      false,
      trigger,
    );
  };
  const openAccounts = (
    trigger?: HTMLElement,
    returnTo: "settings" | "chat" | "robot" = screen === "settings"
      ? "settings"
      : activeChatClient
        ? "chat"
        : "robot",
  ) => {
    if (pendingAction.current) return;
    autoSelectRobot.current = false;
    selectionReturn.current = returnTo;
    const rev = generation.current;
    void run(async () => {
      const result = await auth.listAccounts();
      if (rev !== generation.current || !alive.current) return;
      setAccounts(result);
      openScreen("accounts", trigger);
    });
  };
  const chooseAccount = (id: string, switching: boolean, automatic = false) => {
    if (pendingAction.current) return;
    if (switching && id === authState.account?.accountId) {
      setScreen(selectionReturn.current);
      return;
    }
    navigate(() => {
      manuallySelectedAccount.current = automatic ? undefined : id;
      if (!switching) attemptedInitialAccount.current = true;
      if (switching) clearChat();
      void run(async () => {
        try {
          if (switching) await auth.switchAccount(id);
          else await auth.selectAccount(id);
        } catch (error) {
          if (manuallySelectedAccount.current === id)
            manuallySelectedAccount.current = undefined;
          throw error;
        }
      });
    }, switching);
  };
  // Evaluate each transition against the latest committed UI and client snapshots.
  useEffect(() => {
    if (restoring || pendingAction.current || staleIdentity) return;
    if (authState.status === "account_selection_required") {
      const only =
        authState.accounts.length === 1 ? authState.accounts[0] : undefined;
      if (only && !attemptedInitialAccount.current)
        chooseAccount(only.accountId, false, true);
      return;
    }
    attemptedInitialAccount.current = false;
    if (!scope || accessDenied || chatAccessDenied || activeChatClient) return;
    if (
      screen === "robot" &&
      autoSelectRobot.current &&
      directory.status === "ready" &&
      directory.pagination?.hasMore === false &&
      directory.pagination.total === directory.items.length
    ) {
      const eligible = directory.items.filter((item) => item.canAutoConnect);
      if (eligible.length === 1) chooseRobot(eligible[0]!, true);
    }
    if (
      screen === "platform" &&
      platformChoice?.autoSelect &&
      candidate.status === "platform-selection-required" &&
      candidate.platforms?.length === 1
    ) {
      choosePlatform(candidate.platforms[0]!.platformId, true);
    }
  });
  const reopenChoice = (trigger?: HTMLElement) => {
    if (pendingAction.current) return;
    const { target, platformBack } = chatReturn.current;
    autoSelectRobot.current = false;
    selectionReturn.current = activeChatClient ? "chat" : "robot";
    if (!activeChatClient) clearChat();
    setFailed(false);
    if (target === "platform" && robot) {
      openPlatformChoice(robot, platformBack, false, trigger);
    } else if (target === "accounts") {
      if (!activeChatClient) setScreen("robot");
      openAccounts(trigger);
    } else openScreen("robot", trigger);
  };
  const back = (target?: ChoiceBack) => (
    <Button
      className="tf-back"
      type="text"
      disabled={busy}
      onClick={() => {
        autoSelectRobot.current = false;
        cancelPlatformChoice();
        setFailed(false);
        if (target === "accounts") {
          const returnTo = activeChatClient ? selectionReturn.current : "robot";
          setScreen(returnTo);
          openAccounts(undefined, returnTo);
        } else setScreen(target ?? (activeChatClient ? "chat" : "robot"));
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
  const chatIdentityPlatformId =
    typeof activePlatformId === "number" ? activePlatformId : chosenPlatform;
  const chatIdentity = useMemo<ManagerChatIdentity | undefined>(
    () =>
      !scope || staleIdentity || robot?.robotId === undefined
        ? undefined
        : {
            ...(authState.account?.accountId === undefined
              ? {}
              : { accountId: authState.account.accountId }),
            ...(authState.account?.organizationId === undefined
              ? {}
              : { organizationId: authState.account.organizationId }),
            ...(auth.environment === undefined
              ? {}
              : { environment: auth.environment }),
            ...(authState.user?.userId === undefined
              ? {}
              : { userId: authState.user.userId }),
            ...(chatIdentityPlatformId === undefined
              ? {}
              : { platformId: chatIdentityPlatformId }),
            robotId: robot.robotId,
          },
    [
      auth.environment,
      authState.account?.accountId,
      authState.account?.organizationId,
      authState.user?.userId,
      chatIdentityPlatformId,
      robot?.robotId,
      scope,
      staleIdentity,
    ],
  );
  const chatIdentityKey =
    chatIdentity === undefined ? "" : managerChatIdentityScope(chatIdentity);
  const chatIdentityRef = useRef(chatIdentity);
  chatIdentityRef.current = chatIdentity;
  const onChatIdentityChangeRef = useRef(onChatIdentityChange);
  onChatIdentityChangeRef.current = onChatIdentityChange;
  useEffect(() => {
    onChatIdentityChangeRef.current?.(chatIdentityRef.current);
  }, [chatIdentityKey]);
  const inheritsInteraction = useHasInteractionProvider();
  const automaticInteraction = useMemo(
    () =>
      interactionClient === undefined &&
      !inheritsInteraction &&
      activeChatClient &&
      robot?.robotId
        ? { robot, robotId: robot.robotId, manager }
        : undefined,
    [
      activeChatClient,
      chatIdentityKey,
      inheritsInteraction,
      interactionClient,
      manager,
      robot,
    ],
  );
  const [managedInteraction, setManagedInteraction] = useState<{
    binding: NonNullable<typeof automaticInteraction>;
    client: InteractionClient;
  }>();
  useEffect(() => {
    setManagedInteraction(undefined);
    if (!automaticInteraction) return;
    const { robot, robotId, manager } = automaticInteraction;
    const abort = new AbortController();
    let resource: ManagerRobotConnection | undefined;
    let client: InteractionClient | undefined;
    let unsubscribe: (() => void) | undefined;
    const release = () => {
      unsubscribe?.();
      client?.dispose();
      resource?.dispose();
    };
    const start = async () => {
      const connection = await manager.connectForInteraction(robot, {
        signal: abort.signal,
        deadlineAt: deadline(),
      });
      if (abort.signal.aborted) {
        connection.dispose();
        return;
      }
      resource = connection;
      const interaction = createTFRobotInteractionClient({
        baseUrl: connection.target.baseUrl,
        socketNamespaceUrl: new URL(
          "/remote-tool",
          connection.target.socketNamespaceUrl,
        ).href,
        socketPath: connection.target.socketPath,
        sessionProvider: connection.sessionProvider,
        robotId,
      });
      client = interaction;
      // Retain the existing pending UI until the server enables Interaction.
      const enable = () => {
        if (interaction.getSnapshot().connection !== "connected") return;
        unsubscribe?.();
        unsubscribe = undefined;
        setManagedInteraction({
          binding: automaticInteraction,
          client: interaction,
        });
      };
      unsubscribe = interaction.subscribe(enable);
      enable();
    };
    void start().catch(release);
    return () => {
      abort.abort();
      release();
    };
  }, [automaticInteraction, deadline]);
  const defaultInteraction =
    managedInteraction?.binding === automaticInteraction
      ? managedInteraction?.client
      : undefined;
  const interactionClientForUi =
    interactionClient === undefined
      ? defaultInteraction
      : resolveManagerInteractionClient(
          interactionClient,
          interactionIdentity,
          chatIdentity,
          {
            allowUnscoped: allowUnscopedInteractionClient,
            allowWildcards: allowWildcardInteractionIdentity,
          },
        );
  const interactionScope =
    chatIdentity === undefined ? undefined : chatIdentityKey;
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
              disabled={busy}
              onClick={() => chooseAccount(a.accountId, switching)}
            >
              <span className="tf-symbol">▦</span>
              <span className="tf-choice-copy">
                <strong>{accountLabel(a)}</strong>
                <small>{accountDetails(a)}</small>
              </span>
              {switching && authState.account?.accountId === a.accountId && (
                <span className="tf-current">{copy.current}</span>
              )}
              <span className="tf-choice-arrow" aria-hidden="true">
                →
              </span>
            </button>
          ))}
        </div>
        {!options.length && <p>{copy.emptyAccounts}</p>}
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
  else if (
    authState.status === "switching" ||
    (busy && authState.status === "authenticating")
  )
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
    const connected = activeChatClient && robot;
    const platformNeeded = screen === "platform";
    const header = (
      <div className="tf-chat-context">
        <div className="tf-top">
          <Tooltip title={accountName}>
            <div
              className="tf-organization-summary"
              role="group"
              aria-label={`${copy.currentOrganization}: ${accountName}`}
            >
              <strong>{accountName}</strong>
            </div>
          </Tooltip>
          <span
            className={`tf-badge ${auth.environment === "staging" ? "tf-test" : ""}`}
          >
            {auth.environment === "staging" ? copy.test : copy.production}
          </span>
          <Button
            className="tf-return-choice"
            type="text"
            disabled={busy}
            onClick={(event) => reopenChoice(event.currentTarget)}
          >
            ← {copy.backSelection}
          </Button>
          <Button
            type="text"
            aria-label={copy.settings}
            onClick={(event) => openScreen("settings", event.currentTarget)}
          >
            ☰
          </Button>
        </div>
        <div
          className="tf-toolbar"
          role="group"
          aria-label={copy.currentWorkspace}
        >
          <span className="tf-symbol" aria-hidden="true">
            ✧
          </span>
          <Tooltip title={robotName(robot)}>
            <div
              className="tf-robot-summary"
              role="group"
              aria-label={`${copy.currentRobot}: ${robotName(robot)}`}
            >
              <strong>{robotName(robot)}</strong>
            </div>
          </Tooltip>
          <Tooltip
            title={`${copy.currentPlatform}: ${platformName}${platformId !== undefined ? ` · ${copy.fixedPlatform}` : chatConfig.conversationContract !== "json-v2" ? ` · ${copy.platformUnavailable}` : ""}`}
          >
            <div
              className="tf-platform-context"
              role="group"
              aria-label={`${copy.currentPlatform}: ${platformName}`}
            >
              <span>{platformName}</span>
              {platformId !== undefined ||
              chatConfig.conversationContract !== "json-v2" ? (
                <small>
                  {platformId !== undefined
                    ? copy.fixedPlatform
                    : copy.platformUnavailable}
                </small>
              ) : null}
            </div>
          </Tooltip>
        </div>
        {screen === "chat" && failed && feedback}
      </div>
    );
    const chat = connected ? (
      <ChatProvider client={activeChatClient}>
        <ChatCompactWorkspace
          debug={debug}
          showEventDetailModeSelector={showEventDetailModeSelector}
          key={clientKey.current.id}
          header={header}
          moreActions={[
            { label: copy.switchRobot, disabled: busy, onSelect: openRobot },
            {
              label: copy.switchPlatform,
              disabled:
                busy ||
                platformId !== undefined ||
                chatConfig.conversationContract !== "json-v2",
              onSelect: openPlatform,
            },
          ]}
          locale={locale}
          getDeadlineAt={deadline}
          orderConversations={
            chatConfig.conversationListOrder === "oldest-first"
              ? undefined
              : orderConversationsByUpdatedAt
          }
          interactionClient={interactionClientForUi}
          interactionScope={interactionScope}
          interactionInlineVisible={managerChatInlineVisible(
            screen,
            staleIdentity,
          )}
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
            {connected ? (
              back(selectionReturn.current)
            ) : (
              <>
                <Button
                  className="tf-back"
                  type="text"
                  disabled={busy}
                  onClick={(event) => openAccounts(event.currentTarget)}
                >
                  ← {copy.backOrganization}
                </Button>
                {steps(1)}
              </>
            )}
            {title(copy.robot, copy.robotHint)}
            <p className="tf-identity-hint">
              {copy.currentOrganization}: {accountName}
            </p>
            {feedback}
            <Input
              aria-label={copy.search}
              placeholder={copy.search}
              value={query}
              onChange={(e) => {
                autoSelectRobot.current = false;
                setQuery(e.target.value);
              }}
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
                    disabled={
                      !r.canAutoConnect || directory.status !== "ready" || busy
                    }
                    onClick={() => chooseRobot(r)}
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
                    {r.canAutoConnect && (
                      <span className="tf-choice-arrow" aria-hidden="true">
                        →
                      </span>
                    )}
                  </button>
                ))}
            </div>
            {directory.status === "ready" &&
            directory.pagination?.hasMore !== true &&
            !directory.items.some((item) => item.canAutoConnect) ? (
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
                  autoSelectRobot.current = false;
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
        </>
      );
    else if (platformNeeded)
      panel = (
        <>
          {top}
          <div className="tf-body">
            {back(platformChoice?.back ?? "robot")}
            {connected &&
              (platformChoice?.back === "robot" ||
                platformChoice?.back === "accounts") &&
              selectionReturn.current !== "robot" &&
              back(selectionReturn.current)}
            {!connected && steps(2)}
            {title(copy.platform, copy.platformHint)}
            <p className="tf-identity-hint">
              {copy.currentOrganization}: {accountName}
              <br />
              {copy.selectedRobot}: {robotName(platformChoice?.robot)}
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
                      if (platformChoice)
                        void picker.select(platformChoice.robot);
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
                  disabled={busy}
                  onClick={() => choosePlatform(p.platformId)}
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
                    robot?.id === platformChoice?.robot.id &&
                    activePlatformId === p.platformId && (
                      <span className="tf-current">{copy.current}</span>
                    )}
                  <span className="tf-choice-arrow" aria-hidden="true">
                    →
                  </span>
                </button>
              ))}
            </div>
            {candidate.status === "platform-selection-required" &&
              !candidate.platforms?.length && (
                <p className="tf-empty">{copy.noPlatforms}</p>
              )}
          </div>
        </>
      );
    else if (!connected)
      panel = (
        <>
          {top}
          <div className="tf-body">
            <Button type="text" onClick={() => reopenChoice()}>
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
