import { Alert, Button, Form, Input, Select, Spin, Typography } from "antd";
import { createElement, type ReactNode } from "react";

import { useAuth, useAuthSelector } from "./react.js";

export interface AuthUiLabels {
  readonly login?: string;
  readonly accountSelection?: string;
  readonly sessionExpired?: string;
}

export interface AuthUiProps {
  readonly labels?: AuthUiLabels;
  readonly className?: string;
}

const errorNode = (message: string | undefined): ReactNode =>
  message === undefined
    ? null
    : createElement(Alert, { type: "error", message });
const classProps = (className: string | undefined) =>
  className === undefined ? {} : { className };

export const LoginPanel = ({
  labels,
  className,
}: AuthUiProps = {}): ReactNode => {
  const client = useAuth();
  const status = useAuthSelector((snapshot) => snapshot.status);
  const error = useAuthSelector((snapshot) => snapshot.error?.message);
  if (status === "authenticating")
    return createElement(Spin, classProps(className));
  return createElement(
    Form,
    {
      layout: "vertical",
      ...classProps(className),
      onFinish: (values: unknown) => {
        void client
          .login(values as { identifier: string; password: string })
          .catch(() => undefined);
      },
    },
    createElement(
      Form.Item,
      {
        name: "identifier",
        label: labels?.login ?? "Sign in",
        rules: [{ required: true }],
      },
      createElement(Input),
    ),
    createElement(
      Form.Item,
      { name: "password", label: "Password", rules: [{ required: true }] },
      createElement(Input.Password),
    ),
    errorNode(error),
    createElement(
      Button,
      { type: "primary", htmlType: "submit" },
      labels?.login ?? "Sign in",
    ),
  );
};

export const AccountSelectionPanel = ({
  labels,
  className,
}: AuthUiProps = {}): ReactNode => {
  const client = useAuth();
  const accounts = useAuthSelector((snapshot) => snapshot.accounts);
  const status = useAuthSelector((snapshot) => snapshot.status);
  if (status !== "account_selection_required") return null;
  return createElement(Select, {
    ...classProps(className),
    "aria-label": labels?.accountSelection ?? "Choose account",
    options: accounts.map((account) => ({
      label: account.displayName ?? account.accountId,
      value: account.accountId,
    })),
    onChange: (accountId: unknown) => {
      if (typeof accountId === "string")
        void client.selectAccount(accountId).catch(() => undefined);
    },
  });
};

export const OrganizationSwitcher = ({
  className,
}: AuthUiProps = {}): ReactNode => {
  const organizationId = useAuthSelector(
    (snapshot) => snapshot.account?.organizationId,
  );
  if (organizationId === undefined) return null;
  return createElement(Typography.Text, classProps(className), organizationId);
};

export const SessionExpiredNotice = ({
  labels,
  className,
}: AuthUiProps = {}): ReactNode => {
  const status = useAuthSelector((snapshot) => snapshot.status);
  if (status !== "auth_required") return null;
  return createElement(Alert, {
    ...classProps(className),
    type: "warning",
    message: labels?.sessionExpired ?? "Your session has expired",
  });
};

export const AuthStatus = ({ className }: AuthUiProps = {}): ReactNode => {
  const status = useAuthSelector((snapshot) => snapshot.status);
  return createElement(Typography.Text, classProps(className), status);
};
