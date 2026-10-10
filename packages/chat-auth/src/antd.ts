import {
  Alert,
  Button,
  ConfigProvider,
  Form,
  Input,
  Select,
  Space,
  Typography,
  type FormItemProps,
  type ThemeConfig,
} from "antd";
import {
  createElement,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type {
  AccountContext,
  AccountOption,
  AuthClient,
  AuthEnvironment,
  AuthError,
  AuthSnapshot,
  AuthStatus as AuthStatusValue,
  LoginInput,
  LoginResult,
} from "./headless.js";
import { useAuth, useAuthSelector } from "./react.js";

type Callback<T> = (value: T) => void | Promise<void>;
export interface AuthUiLabels {
  readonly login?: string;
  readonly identifier?: string;
  readonly password?: string;
  readonly accountSelection?: string;
  readonly organizationSwitch?: string;
  readonly sessionExpired?: string;
  readonly logout?: string;
  readonly emptyAccounts?: string;
  readonly unavailable?: string;
  readonly onboarding?: string;
  readonly environment?: string;
  readonly environments?: Partial<Readonly<Record<AuthEnvironment, string>>>;
  readonly statuses?: Partial<Readonly<Record<AuthStatusValue, string>>>;
}
export interface AuthUiProps {
  readonly labels?: AuthUiLabels;
  readonly className?: string;
  readonly theme?: ThemeConfig;
  readonly disabled?: boolean;
  readonly onError?: Callback<AuthError>;
}
export interface AuthEnvironmentUiProps {
  readonly showEnvironmentSelector?: boolean;
  readonly allowedEnvironments?: readonly AuthEnvironment[];
  /** Host creates/replaces clients; the current AuthClient environment stays fixed. */
  readonly onEnvironmentChange?: Callback<AuthEnvironment>;
}
export interface AuthLoginField {
  readonly label?: ReactNode;
  readonly placeholder?: string;
  readonly rules?: FormItemProps["rules"];
  /** A controlled input compatible with Ant Design Form.Item. */
  readonly control?: ReactNode;
}
export interface LoginPanelProps extends AuthUiProps, AuthEnvironmentUiProps {
  readonly fields?: {
    readonly identifier?: AuthLoginField;
    readonly password?: AuthLoginField;
  };
  readonly extraFields?: ReactNode;
  readonly onLogin?: Callback<LoginResult>;
}
export interface AccountSelectionPanelProps extends AuthUiProps {
  readonly onSelected?: Callback<LoginResult>;
  readonly renderAccountLabel?: (account: AccountOption) => ReactNode;
}
export interface OrganizationSwitcherProps extends AuthUiProps {
  readonly onSwitched?: Callback<AccountContext>;
  readonly renderAccountLabel?: (account: AccountOption) => ReactNode;
}
export interface SessionExpiredNoticeProps extends AuthUiProps {
  readonly onReauthenticate?: () => void | Promise<void>;
}
export interface AuthStatusProps extends AuthUiProps, AuthEnvironmentUiProps {
  readonly showLogout?: boolean;
  readonly onLogout?: () => void | Promise<void>;
}
const fallbackError: AuthError = {
  code: "unknown",
  message: "Authentication action failed",
  retryable: true,
};
const classProps = (className: string | undefined) =>
  className === undefined ? {} : { className };
const withTheme = (
  node: ReactNode,
  theme: ThemeConfig | undefined,
): ReactNode =>
  theme === undefined ? node : createElement(ConfigProvider, { theme }, node);
const errorNode = (error: AuthError | undefined): ReactNode =>
  error === undefined
    ? null
    : createElement(Alert, {
        type: "error",
        message: error.message,
        role: "alert",
      });
const isBusy = (status: AuthStatusValue): boolean =>
  status === "authenticating" ||
  status === "refreshing" ||
  status === "switching";
const resultIsCurrent = (
  result: LoginResult,
  snapshot: AuthSnapshot,
): boolean => {
  if (result.kind === "authenticated")
    return (
      snapshot.status === "authenticated" &&
      snapshot.account?.accountId === result.account.accountId &&
      snapshot.account.userId === result.account.userId
    );
  if (result.kind === "account-selection-required")
    return snapshot.status === "account_selection_required";
  return snapshot.status === "onboarding_required";
};

/** Local interaction state belongs to a mounted client binding, not AuthClient. */
const useAction = (
  client: AuthClient,
  onError: Callback<AuthError> | undefined,
) => {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AuthError>();
  const binding = useRef({ client, active: true, busy: false });
  useEffect(() => {
    const current = { client, active: true, busy: false };
    binding.current = current;
    setBusy(false);
    setError(undefined);
    return () => {
      current.active = false;
    };
  }, [client]);
  const run = async <T>(
    operation: () => Promise<T>,
    onSuccess?: Callback<T>,
    valid?: (value: T) => boolean,
    onSettled?: () => void,
  ): Promise<void> => {
    const current = binding.current;
    if (!current.active || current.client !== client || current.busy) return;
    current.busy = true;
    setBusy(true);
    setError(undefined);
    try {
      const value = await operation();
      if (
        current.active &&
        current === binding.current &&
        (valid?.(value) ?? true)
      )
        await onSuccess?.(value);
    } catch {
      if (current.active && current === binding.current) {
        const error = client.getSnapshot().error ?? fallbackError;
        setError(error);
        try {
          await onError?.(error);
        } catch {
          /* Host callbacks cannot leak error texts into UI. */
        }
      }
    } finally {
      current.busy = false;
      if (current.active && current === binding.current) {
        onSettled?.();
        setBusy(false);
      }
    }
  };
  return { busy, error, run };
};
const EnvironmentChoice = ({
  client,
  labels,
  disabled,
  showEnvironmentSelector,
  allowedEnvironments,
  onEnvironmentChange,
  run,
}: AuthEnvironmentUiProps & {
  readonly client: AuthClient;
  readonly labels: AuthUiLabels | undefined;
  readonly disabled: boolean;
  readonly run: (operation: () => Promise<void>) => Promise<void>;
}): ReactNode => {
  if (!showEnvironmentSelector) return null;
  const allowed = [
    ...new Set(allowedEnvironments ?? [client.environment]),
  ].filter(
    (environment) => environment === "staging" || environment === "production",
  );
  return createElement(Select<AuthEnvironment>, {
    "aria-label": labels?.environment ?? "Environment",
    value: allowed.includes(client.environment) ? client.environment : null,
    disabled:
      disabled || onEnvironmentChange === undefined || allowed.length < 2,
    options: allowed.map((value) => ({
      value,
      label: labels?.environments?.[value] ?? value,
    })),
    onChange: (environment) => {
      if (
        onEnvironmentChange !== undefined &&
        allowed.includes(environment) &&
        environment !== client.environment
      )
        void run(async () => {
          await onEnvironmentChange(environment);
        });
    },
  });
};

export const LoginPanel = ({
  labels,
  className,
  theme,
  disabled = false,
  onError,
  fields,
  extraFields,
  onLogin,
  ...environmentProps
}: LoginPanelProps = {}): ReactNode => {
  const client = useAuth();
  const snapshot = useAuthSelector((snapshot) => snapshot);
  const action = useAction(client, onError);
  const [form] = Form.useForm<LoginInput>();
  useEffect(() => {
    form.resetFields();
  }, [client, form]);
  const busy = action.busy || isBusy(snapshot.status);
  const environment = createElement(EnvironmentChoice, {
    client,
    labels,
    disabled: disabled || busy,
    ...environmentProps,
    run: action.run,
  });
  if (snapshot.status === "authenticated" || snapshot.status === "disposed")
    return withTheme(environment, theme);
  if (
    snapshot.status === "account_selection_required" ||
    snapshot.status === "onboarding_required"
  )
    return withTheme(
      createElement(
        Space,
        { direction: "vertical", ...classProps(className) },
        environment,
        createElement(Alert, {
          type: "info",
          message:
            snapshot.status === "onboarding_required"
              ? (labels?.onboarding ??
                "Complete your account setup to continue")
              : (labels?.accountSelection ?? "Choose account"),
        }),
      ),
      theme,
    );
  return withTheme(
    createElement(
      Form<LoginInput>,
      {
        form,
        layout: "vertical",
        disabled: disabled || busy,
        "aria-busy": busy,
        ...classProps(className),
        onFinish: (values: unknown) => {
          if (
            typeof values !== "object" ||
            values === null ||
            !("identifier" in values) ||
            typeof values.identifier !== "string" ||
            !("password" in values) ||
            typeof values.password !== "string"
          )
            return;
          const input = {
            identifier: values.identifier,
            password: values.password,
          };
          void action.run(
            () => client.login(input),
            onLogin,
            (result) => resultIsCurrent(result, client.getSnapshot()),
            () => form.resetFields(["password"]),
          );
        },
      },
      environment,
      createElement(
        Form.Item,
        {
          name: "identifier",
          label:
            fields?.identifier?.label ?? labels?.identifier ?? "Email or phone",
          rules: fields?.identifier?.rules ?? [{ required: true }],
        },
        fields?.identifier?.control ??
          createElement(Input, {
            autoComplete: "username",
            ...(fields?.identifier?.placeholder === undefined
              ? {}
              : { placeholder: fields.identifier.placeholder }),
          }),
      ),
      createElement(
        Form.Item,
        {
          name: "password",
          label: fields?.password?.label ?? labels?.password ?? "Password",
          rules: fields?.password?.rules ?? [{ required: true }],
        },
        fields?.password?.control ??
          createElement(Input.Password, {
            autoComplete: "current-password",
            ...(fields?.password?.placeholder === undefined
              ? {}
              : { placeholder: fields.password.placeholder }),
          }),
      ),
      extraFields,
      errorNode(action.error ?? snapshot.error),
      createElement(
        Button,
        { type: "primary", htmlType: "submit", loading: busy, disabled },
        labels?.login ?? "Sign in",
      ),
    ),
    theme,
  );
};

export const AccountSelectionPanel = ({
  labels,
  className,
  theme,
  disabled = false,
  onError,
  onSelected,
  renderAccountLabel,
}: AccountSelectionPanelProps = {}): ReactNode => {
  const client = useAuth();
  const snapshot = useAuthSelector((snapshot) => snapshot);
  const action = useAction(client, onError);
  if (snapshot.status === "error")
    return withTheme(errorNode(action.error ?? snapshot.error), theme);
  if (snapshot.status !== "account_selection_required" && !action.busy)
    return null;
  const accounts = snapshot.accounts;
  return withTheme(
    createElement(
      Space,
      {
        direction: "vertical",
        ...classProps(className),
        "aria-busy": action.busy,
      },
      createElement(Select<string>, {
        "aria-label": labels?.accountSelection ?? "Choose account",
        loading: action.busy,
        disabled:
          disabled ||
          action.busy ||
          snapshot.status !== "account_selection_required" ||
          accounts.length === 0,
        options: accounts.map((account) => ({
          label:
            renderAccountLabel?.(account) ??
            account.displayName ??
            account.accountId,
          value: account.accountId,
        })),
        onChange: (accountId) => {
          if (accounts.some((account) => account.accountId === accountId))
            void action.run(
              () => client.selectAccount(accountId),
              onSelected,
              (result) => resultIsCurrent(result, client.getSnapshot()),
            );
        },
      }),
      accounts.length === 0
        ? createElement(Alert, {
            type: "info",
            message: labels?.emptyAccounts ?? "No accounts available",
          })
        : null,
      errorNode(action.error ?? snapshot.error),
    ),
    theme,
  );
};

export const OrganizationSwitcher = ({
  labels,
  className,
  theme,
  disabled = false,
  onError,
  onSwitched,
  renderAccountLabel,
}: OrganizationSwitcherProps = {}): ReactNode => {
  const client = useAuth();
  const snapshot = useAuthSelector((snapshot) => snapshot);
  const action = useAction(client, onError);
  const [loading, setLoading] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const errorCallback = useRef(onError);
  useEffect(() => {
    errorCallback.current = onError;
  }, [onError]);
  useEffect(() => {
    let active = true;
    setUnavailable(false);
    if (snapshot.status !== "authenticated") {
      setLoading(false);
      return;
    }
    setLoading(true);
    void client
      .listAccounts()
      .catch(async () => {
        if (!active) return;
        const error = client.getSnapshot().error ?? fallbackError;
        setUnavailable(error.code === "unsupported");
        try {
          await errorCallback.current?.(error);
        } catch {
          /* Host callback isolated. */
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [
    client,
    snapshot.status,
    snapshot.account?.userId,
    snapshot.account?.accountId,
    snapshot.account?.organizationId,
  ]);
  if (snapshot.status === "error")
    return withTheme(errorNode(action.error ?? snapshot.error), theme);
  if (
    snapshot.status !== "authenticated" &&
    snapshot.status !== "refreshing" &&
    snapshot.status !== "switching"
  )
    return null;
  const busy = loading || action.busy || isBusy(snapshot.status);
  return withTheme(
    createElement(
      Space,
      { direction: "vertical", ...classProps(className), "aria-busy": busy },
      createElement(Select<string>, {
        "aria-label":
          labels?.organizationSwitch ?? "Switch organization or account",
        loading: busy,
        disabled:
          disabled || busy || unavailable || snapshot.accounts.length === 0,
        value: snapshot.accounts.some(
          (option) => option.accountId === snapshot.account?.accountId,
        )
          ? (snapshot.account?.accountId ?? null)
          : null,
        options: snapshot.accounts.map((account) => ({
          label:
            renderAccountLabel?.(account) ??
            account.displayName ??
            account.organizationId ??
            account.accountId,
          value: account.accountId,
        })),
        onChange: (accountId) => {
          if (
            accountId !== snapshot.account?.accountId &&
            snapshot.accounts.some((account) => account.accountId === accountId)
          )
            void action.run(
              () => client.switchAccount(accountId),
              onSwitched,
              (account) =>
                client.getSnapshot().status === "authenticated" &&
                client.getSnapshot().account?.accountId === account.accountId,
            );
        },
      }),
      unavailable
        ? createElement(Alert, {
            type: "info",
            message: labels?.unavailable ?? "Account switching is unavailable",
          })
        : null,
      snapshot.accounts.length === 0
        ? createElement(Alert, {
            type: "info",
            message: labels?.emptyAccounts ?? "No accounts available",
          })
        : null,
      errorNode(action.error ?? snapshot.error),
    ),
    theme,
  );
};

export const SessionExpiredNotice = ({
  labels,
  className,
  theme,
  disabled = false,
  onError,
  onReauthenticate,
}: SessionExpiredNoticeProps = {}): ReactNode => {
  const client = useAuth();
  const snapshot = useAuthSelector((snapshot) => snapshot);
  const action = useAction(client, onError);
  if (snapshot.status !== "auth_required") return null;
  return withTheme(
    createElement(Alert, {
      ...classProps(className),
      type: "warning",
      role: "alert",
      message: labels?.sessionExpired ?? "Your session has expired",
      description: action.error?.message,
      action:
        onReauthenticate === undefined
          ? undefined
          : createElement(
              Button,
              {
                disabled,
                loading: action.busy,
                onClick: () => {
                  void action.run(async () => {
                    await onReauthenticate();
                  });
                },
              },
              labels?.login ?? "Sign in",
            ),
    }),
    theme,
  );
};

export const AuthStatus = ({
  labels,
  className,
  theme,
  disabled = false,
  onError,
  showLogout = true,
  onLogout,
  ...environmentProps
}: AuthStatusProps = {}): ReactNode => {
  const client = useAuth();
  const snapshot = useAuthSelector((snapshot) => snapshot);
  const action = useAction(client, onError);
  return withTheme(
    createElement(
      Space,
      {
        ...classProps(className),
        direction: "vertical",
        "aria-busy": action.busy || isBusy(snapshot.status),
      },
      createElement(
        Typography.Text,
        { role: "status" },
        labels?.statuses?.[snapshot.status] ?? snapshot.status,
      ),
      createElement(EnvironmentChoice, {
        client,
        labels,
        disabled: disabled || action.busy || isBusy(snapshot.status),
        ...environmentProps,
        run: action.run,
      }),
      showLogout && (snapshot.status === "authenticated" || action.busy)
        ? createElement(
            Button,
            {
              disabled,
              loading: action.busy,
              onClick: () => {
                void action.run(
                  () => client.logout(),
                  onLogout,
                  () => client.getSnapshot().status === "signed_out",
                );
              },
            },
            labels?.logout ?? "Sign out",
          )
        : null,
      errorNode(action.error ?? snapshot.error),
    ),
    theme,
  );
};
