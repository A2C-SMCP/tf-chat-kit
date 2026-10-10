import { createElement, act } from "react";
import type {
  AuthStatusProps,
  OrganizationSwitcherProps,
} from "@turingfocus/chat-auth/antd";
import { authFixture, check, setupDom } from "../auth-common.js";

export const runAuthAntdConsumerVerification = async (): Promise<void> => {
  const dom = setupDom();
  const { createRoot } = await import("react-dom/client");
  const { AuthProvider } = await import("@turingfocus/chat-auth/react");
  const { AuthStatus, OrganizationSwitcher, SessionExpiredNotice } =
    await import("@turingfocus/chat-auth/antd");
  const root = createRoot(dom.container);
  const { client } = authFixture();
  let switches = 0;
  let logouts = 0;
  try {
    await client.login({ identifier: "fixture", password: "transient" });
    await act(async () =>
      root.render(
        createElement(
          AuthProvider,
          { client },
          createElement(
            "section",
            null,
            createElement<OrganizationSwitcherProps>(OrganizationSwitcher, {
              onSwitched: () => {
                ++switches;
              },
            }),
            createElement<AuthStatusProps>(AuthStatus, {
              labels: { logout: "Leave" },
              onLogout: () => {
                ++logouts;
              },
            }),
            createElement(SessionExpiredNotice),
          ),
        ),
      ),
    );
    const input = dom.container.querySelector<HTMLInputElement>(
      'input[role="combobox"]',
    )!;
    check(
      input !== null && !input.disabled,
      "Account switch control unavailable",
    );
    for (const [key, keyCode] of [
      ["ArrowDown", 40],
      ["ArrowDown", 40],
      ["Enter", 13],
    ] as const) {
      await act(async () => {
        input.dispatchEvent(
          new KeyboardEvent("keydown", {
            key,
            keyCode,
            which: keyCode,
            bubbles: true,
          }),
        );
      });
    }
    check(
      client.getSnapshot().account?.accountId === "b" && switches === 1,
      "Packed keyboard account switch failed",
    );
    check(
      !dom.container.innerHTML.includes("private-fixture-credential"),
      "Credential appeared in AntD DOM",
    );
    await act(async () =>
      dom.container.querySelector<HTMLButtonElement>("button")!.click(),
    );
    check(
      client.getSnapshot().status === "signed_out" && logouts === 1,
      "Packed logout failed",
    );
    await act(async () => client.createSessionProvider().invalidate?.());
    check(
      client.getSnapshot().status === "auth_required" &&
        [...dom.container.querySelectorAll('[role="alert"]')].some((alert) =>
          alert.textContent?.includes("Your session has expired"),
        ),
      "Expired-session state missing",
    );
    check(
      !dom.container.innerHTML.includes("private-fixture-credential"),
      "Credential appeared in error DOM",
    );
  } finally {
    await act(async () => root.unmount());
    await client.dispose();
    dom.close();
  }
};
