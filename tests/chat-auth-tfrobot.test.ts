import { describe, expect, it } from "vitest";

import {
  createTfRobotAuthTransport,
  type TfRobotRequestInit,
} from "../packages/chat-auth/src/tfrobot.js";

const response = (status: number, body: unknown) => ({
  status,
  async json() {
    return body;
  },
});

describe("TFRobot auth transport", () => {
  it.each([
    "javascript:alert(1)",
    "https://user:pass@robot.example.test",
    "https://robot.example.test?token=secret",
  ])("rejects unsafe base URL %s", (baseUrl) => {
    expect(() => createTfRobotAuthTransport({ baseUrl })).toThrow("baseUrl");
  });

  it("maps login, account, me and switch endpoints while keeping token out of models", async () => {
    const requests: Array<{ url: string; init?: TfRobotRequestInit }> = [];
    const transport = createTfRobotAuthTransport({
      baseUrl: "https://robot.example.test/",
      fetch: async (url, init) => {
        requests.push({ url, ...(init === undefined ? {} : { init }) });
        if (url.endsWith("login-by-password")) {
          return response(200, {
            access_token: "secret-token",
            account: { userId: "user-1", accountId: "account-1" },
          });
        }
        if (url.endsWith("accounts/my")) {
          return response(200, {
            accounts: [
              { userId: "user-1", accountId: "account-1" },
              { userId: "user-1", accountId: "account-2" },
            ],
          });
        }
        if (url.endsWith("auth/me")) {
          return response(200, { userId: "user-1", accountId: "account-1" });
        }
        return response(200, {
          accessToken: "rotated-token",
          account: { userId: "user-1", accountId: "account-2" },
        });
      },
    });

    const login = await transport.login({
      identifier: "user@example.test",
      password: "one-time",
    });
    expect(login).toMatchObject({
      kind: "authenticated",
      account: { accountId: "account-1" },
    });
    expect(JSON.stringify(login)).not.toContain("secret-token");
    expect(await transport.getCurrentAccount()).toMatchObject({
      userId: "user-1",
    });
    expect(await transport.listAccounts()).toHaveLength(2);
    expect(await transport.switchAccount("account-2")).toMatchObject({
      accountId: "account-2",
    });
    expect(requests[1]?.init?.headers).toMatchObject({
      Authorization: "Bearer secret-token",
    });
  });

  it.each([
    [401, "authentication_required"],
    [403, "authorization_denied"],
    [404, "unsupported"],
  ] as const)("maps HTTP %s to %s", async (status, code) => {
    const transport = createTfRobotAuthTransport({
      baseUrl: "https://robot.example.test",
      fetch: async () => response(status, { detail: "secret-token" }),
    });
    await expect(transport.getCurrentAccount()).rejects.toMatchObject({
      code,
      status,
    });
  });
});
