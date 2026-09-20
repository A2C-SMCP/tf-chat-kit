import { describe, expect, it } from "vitest";

import {
  ManagerRobotTokenExchangeError,
  ManagerRobotTokenSource,
} from "../playground/src/manager-token-exchange.js";

const request = {
  operation: "read" as const,
  purpose: "request" as const,
};

describe("Manager RobotServer token exchange", () => {
  it("sends the client-compatible RFC 8693 form and caches the short token", async () => {
    let calls = 0;
    let captured:
      { init: RequestInit | undefined; input: RequestInfo | URL } | undefined;
    const source = new ManagerRobotTokenSource({
      tokenUrl: "https://manager.example/api/v1/oauth/token",
      getManagerUserJwt: async () => "manager-jwt",
      robotAccountId: "org:robot-7",
      fetch: async (input, init) => {
        calls += 1;
        captured = { input, init };
        return new Response(
          JSON.stringify({
            access_token: "robot-short-token",
            expires_in: 3600,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
      now: () => 1_000,
    });

    expect(await source.getSession(request)).toEqual({
      kind: "bearer",
      token: "robot-short-token",
    });
    expect(await source.getSession(request)).toEqual({
      kind: "bearer",
      token: "robot-short-token",
    });
    expect(calls).toBe(1);
    expect(captured?.input).toBe("https://manager.example/api/v1/oauth/token");
    expect(captured?.init?.headers).toEqual({
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    });
    expect(captured?.init?.headers).not.toHaveProperty("Authorization");
    expect(new URLSearchParams(String(captured?.init?.body))).toEqual(
      new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
        subject_token: "manager-jwt",
        subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
        audience: "robot:org:robot-7",
        scope: "chat:read chat:send",
        token_profile: "session",
      }),
    );
  });

  it("deduplicates concurrent exchange requests and refreshes after expiry", async () => {
    let now = 1_000;
    let calls = 0;
    const source = new ManagerRobotTokenSource({
      tokenUrl: "https://manager.example/api/v1/oauth/token",
      getManagerUserJwt: async () => "manager-jwt",
      robotAccountId: "robot-7",
      now: () => now,
      fetch: async () => {
        calls += 1;
        return new Response(
          JSON.stringify({ access_token: `token-${calls}`, expires_in: 40 }),
          { status: 200 },
        );
      },
    });
    const first = await Promise.all([
      source.getSession(request),
      source.getSession(request),
    ]);
    expect(first[0]).toEqual(first[1]);
    expect(calls).toBe(1);
    now += 11_000;
    expect(await source.getSession(request)).toEqual({
      kind: "bearer",
      token: "token-2",
    });
    expect(calls).toBe(2);
  });

  it("maps exchange failures without exposing credential material", async () => {
    const source = new ManagerRobotTokenSource({
      tokenUrl: "https://manager.example/api/v1/oauth/token",
      getManagerUserJwt: async () => "manager-secret-jwt",
      robotAccountId: "robot-7",
      fetch: async () => new Response("forbidden", { status: 403 }),
    });
    await expect(source.getSession(request)).rejects.toMatchObject({
      code: "authorization",
      status: 403,
      message: "当前用户无权访问该机器人。",
    } satisfies Partial<ManagerRobotTokenExchangeError>);
    await expect(source.getSession(request)).rejects.not.toThrow(
      /manager-secret-jwt/u,
    );
  });
});
