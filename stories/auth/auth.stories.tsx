import type { Meta, StoryObj } from "@storybook/react-vite";
import { useCallback } from "react";
import { Button, Space } from "antd";
import {
  createAuthClient,
  type AccountContext,
  type AuthSession,
} from "@turingfocus/chat-auth/headless";
import { AuthProvider, useAuthSelector } from "@turingfocus/chat-auth/react";
import {
  LoginPanel,
  AccountSelectionPanel,
  OrganizationSwitcher,
  SessionExpiredNotice,
  AuthStatus,
} from "@turingfocus/chat-auth/antd";
import {
  Owned,
  Resettable,
  Results,
  Scene,
} from "../support/decorators/scene.js";
import { useShowcase } from "../support/decorators/settings.js";
const accounts: AccountContext[] = [
  {
    accountId: "design",
    userId: "viewer",
    organizationId: "design-org",
    displayName: "设计团队",
  },
  {
    accountId: "engineering",
    userId: "viewer",
    organizationId: "engineering-org",
    displayName: "工程团队",
  },
];
function Panels({ expire }: { expire: () => void }) {
  const snapshot = useAuthSelector((v) => v);
  const { locale } = useShowcase();
  const labels =
    locale === "zh-CN"
      ? {
          identifier: "演示账号",
          password: "演示密码",
          login: "登录",
          logout: "退出",
          accountSelection: "选择账号",
          organizationSwitch: "切换组织",
          sessionExpired: "会话已过期",
        }
      : {};
  return (
    <Space direction="vertical" style={{ width: "100%" }}>
      <LoginPanel labels={labels} />
      <AccountSelectionPanel labels={labels} />
      <OrganizationSwitcher labels={labels} />
      <SessionExpiredNotice labels={labels} />
      <AuthStatus labels={labels} />
      <Button onClick={expire}>模拟会话过期</Button>
      <Results value={snapshot} />
    </Space>
  );
}
function AuthDemo({
  selection,
  authenticated,
  expired,
}: {
  selection: boolean;
  authenticated: boolean;
  expired: boolean;
}) {
  const create = useCallback(async () => {
    let current = accounts[0]!;
    let session: AuthSession | null = null;
    const auth = createAuthClient({
      environment: "staging",
      transport: {
        login: async () => {
          session = { kind: "bearer", token: "storybook-fixture-only" };
          return selection
            ? { kind: "account-selection-required", accounts }
            : { kind: "authenticated", account: current };
        },
        selectAccount: async (id) => {
          current = accounts.find((v) => v.accountId === id) ?? current;
          return { kind: "authenticated", account: current };
        },
        switchAccount: async (id) => {
          current = accounts.find((v) => v.accountId === id) ?? current;
          return current;
        },
        listAccounts: async () => accounts,
        getCurrentAccount: async () => current,
        getSession: async () => session,
        clearSession: () => {
          session = null;
        },
        logout: async () => {
          session = null;
        },
      },
    });
    if (authenticated || expired || selection)
      await auth.login({ identifier: "demo", password: "demo" });
    const expire = () => auth.createSessionProvider().invalidate?.("expired");
    if (expired) expire();
    return { auth, expire, dispose: () => auth.dispose() };
  }, [selection, authenticated, expired]);
  return (
    <Scene
      title="认证公共组件"
      description="可输入任意演示账号/密码。认证适配器只在内存中工作；不保存输入，也不连接真实账号系统。"
    >
      <Resettable>
        <Owned create={create}>
          {(scene) => (
            <AuthProvider client={scene.auth}>
              <Panels expire={scene.expire} />
            </AuthProvider>
          )}
        </Owned>
      </Resettable>
    </Scene>
  );
}
const meta = {
  title: "认证与接入/认证流程",
  component: AuthDemo,
  args: { selection: false, authenticated: false, expired: false },
} satisfies Meta<typeof AuthDemo>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Login: Story = { name: "登录与退出" };
export const SelectAccount: Story = {
  name: "账号选择",
  args: { selection: true },
};
export const Organizations: Story = {
  name: "组织切换",
  args: { authenticated: true },
};
export const Expired: Story = { name: "会话过期", args: { expired: true } };
