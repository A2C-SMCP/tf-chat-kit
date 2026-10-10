import { createElement, StrictMode, act } from "react";
import {
  AuthProvider,
  useAuth,
  useAuthSelector,
} from "@turingfocus/chat-auth/react";
import { authFixture, check, setupDom } from "../auth-common.js";

export const runAuthReactConsumerVerification = async (): Promise<void> => {
  const dom = setupDom();
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(dom.container);
  const first = authFixture();
  const second = authFixture("production");
  const Host = () => {
    const client = useAuth();
    const state = useAuthSelector((snapshot) => ({
      status: snapshot.status,
      accountId: snapshot.account?.accountId,
    }));
    return createElement(
      "p",
      { "data-environment": client.environment },
      `${state.status}:${state.accountId ?? "none"}`,
    );
  };
  const render = async (client: typeof first.client) => {
    await act(async () =>
      root.render(
        createElement(
          StrictMode,
          null,
          createElement(AuthProvider, { client }, createElement(Host)),
        ),
      ),
    );
  };
  try {
    await render(first.client);
    check(
      dom.container.textContent === "signed_out:none",
      "Initial snapshot missing",
    );
    await act(async () => {
      await first.client.login({
        identifier: "fixture",
        password: "transient",
      });
    });
    check(
      dom.container.textContent === "authenticated:a",
      "Login did not update React subscriber",
    );
    await act(async () => {
      await first.client.switchAccount("b");
    });
    check(
      dom.container.textContent === "authenticated:b",
      "Account switch did not update subscriber",
    );
    await render(second.client);
    await act(async () => {
      await first.client.logout();
    });
    check(
      dom.container.querySelector("p")?.dataset["environment"] === "production",
      "Old client polluted replacement environment",
    );
    check(
      dom.container.textContent === "signed_out:none",
      "Old subscription polluted replacement snapshot",
    );
    await act(async () => {
      await second.client.login({
        identifier: "fixture",
        password: "transient",
      });
    });
    check(
      !dom.container.innerHTML.includes("private-fixture-credential"),
      "Token rendered by React consumer",
    );
    await act(async () => root.unmount());
    check(
      second.client.getSnapshot().status === "authenticated",
      "Provider disposed external client",
    );
    await second.client.logout();
    check(
      second.client.getSnapshot().status === "signed_out",
      "External client unusable after unmount",
    );
  } finally {
    await act(async () => root.unmount());
    await Promise.all([first.client.dispose(), second.client.dispose()]);
    dom.close();
  }
};
