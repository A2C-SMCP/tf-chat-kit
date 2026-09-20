import { describe, expect, it } from "vitest";
import { createServer } from "node:http";

import {
  loadManagerConnectionInfo,
  loadManagerRobotDirectory,
  parsePlaygroundConnectionInfo,
  parsePlaygroundRobots,
} from "../playground/src/manager-directory.js";
import { createAuthClient } from "../packages/chat-auth/src/headless.js";

const authClient = () =>
  createAuthClient({
    environment: "staging",
    transport: {
      async login() {
        return {
          kind: "authenticated" as const,
          account: { userId: "user", accountId: "account" },
        };
      },
      async logout() {},
      async getCurrentAccount() {
        return { userId: "user", accountId: "account" };
      },
      async getSession() {
        return { kind: "bearer" as const, token: "manager-token" };
      },
      async listAccounts() {
        return [];
      },
      async selectAccount() {
        return {
          kind: "authenticated" as const,
          account: { userId: "user", accountId: "account" },
        };
      },
      async switchAccount() {
        return { userId: "user", accountId: "account" };
      },
    },
  });
describe("Playground Manager directory adapter", () => {
  it("keeps employee identity separate from robot routing identity", () => {
    expect(
      parsePlaygroundRobots({
        data: {
          items: [
            {
              id: 41,
              name: "Research assistant",
              robotId: "rid-41",
              robotAccountId: "org:robot-41",
              namespace: "tenant-acme",
            },
            { id: 42, name: "Legacy robot" },
          ],
        },
      }),
    ).toEqual([
      {
        id: "rid-41",
        managerEmployeeId: "41",
        name: "Research assistant",
        namespace: "tenant-acme",
        robotAccountId: "org:robot-41",
        robotId: "rid-41",
        canAutoConnect: true,
      },
      {
        id: "42",
        managerEmployeeId: "42",
        name: "Legacy robot",
        canAutoConnect: false,
      },
    ]);
  });

  it("accepts current connection-info fields without retaining legacy tokens", () => {
    expect(
      parsePlaygroundConnectionInfo({
        data: {
          socketBaseURL: "https://staging.turingfocus.cn",
          namespace: "tenant-acme",
          routingHeaders: {
            "X-TF-Namespace": "tenant-acme",
            access_token: "must-not-be-used-as-routing-data",
          },
          accessToken: "legacy-secret",
        },
      }),
    ).toEqual({
      namespace: "tenant-acme",
      socketBaseUrl: "https://staging.turingfocus.cn",
      routingHeaders: {
        "X-TF-Namespace": "tenant-acme",
      },
    });
  });

  it("loads the Manager directory through a real local HTTP request", async () => {
    const server = createServer((request, response) => {
      expect(request.url).toBe("/api/v1/digital-employees");
      expect(request.headers.authorization).toBe("Bearer manager-token");
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          data: {
            items: [
              {
                id: 7,
                name: "Real robot",
                robotId: "robot-7",
                robotAccountId: "org:robot-7",
              },
            ],
          },
        }),
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (address === null || typeof address === "string") {
      server.close();
      throw new Error("local Manager server did not expose a port");
    }
    try {
      const client = authClient();
      const robots = await loadManagerRobotDirectory(
        client,
        `http://127.0.0.1:${address.port}`,
        "org-real",
      );
      expect(robots[0]).toMatchObject({
        id: "robot-7",
        managerEmployeeId: "7",
        robotAccountId: "org:robot-7",
        canAutoConnect: true,
      });
      await client.dispose();
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) =>
          error === undefined ? resolve() : reject(error),
        ),
      );
    }
  });

  it("loads connection-info with the Manager bearer and rejects legacy auth fields", async () => {
    const client = authClient();
    const info = await loadManagerConnectionInfo(
      client,
      "https://manager.example",
      "employee/7",
      async (input, init) => {
        expect(input).toBe(
          "https://manager.example/api/v1/digital-employees/employee%2F7/connection-info",
        );
        expect(init?.headers).toEqual({
          Authorization: "Bearer manager-token",
        });
        return new Response(
          JSON.stringify({
            data: {
              socketBaseURL: "https://api-staging.turingfocus.cn",
              robotType: "tfrobot",
              namespace: "tenant-acme",
              rid: "rid-7",
              sioPath: "socket.io",
              routingHeaders: {
                "X-TF-Namespace": "tenant-acme",
                Authorization: "must-not-be-retained",
              },
              accessToken: "legacy-secret",
            },
          }),
          { status: 200 },
        );
      },
    );
    expect(info).toEqual({
      socketBaseUrl: "https://api-staging.turingfocus.cn",
      robotType: "tfrobot",
      namespace: "tenant-acme",
      rid: "rid-7",
      sioPath: "socket.io",
      routingHeaders: { "X-TF-Namespace": "tenant-acme" },
    });
    await client.dispose();
  });
});
