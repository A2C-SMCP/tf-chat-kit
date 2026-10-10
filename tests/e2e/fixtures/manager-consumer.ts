import { fileURLToPath } from "node:url";
import { test, expect } from "@playwright/test";
export const registerManagerConsumerTests = () => {
  test("public Manager chain uses native fetch, pagination, both routing formats and revocation", async ({
    page,
  }) => {
    await page.goto("/");
    const root = fileURLToPath(new URL("../../../", import.meta.url));
    const result = await page.evaluate(async (root) => {
      const authPath = `/@fs/${root}packages/chat-auth/src/headless.ts`;
      const transportPath = `/@fs/${root}packages/chat-auth/src/tfrobot.ts`;
      const managerPath = `/@fs/${root}packages/chat-auth/src/manager.ts`;
      const chatPath = `/@fs/${root}packages/chat-kit/src/manager.ts`;
      const { createAuthClient } = await import(authPath);
      const { createTfRobotAuthTransport } = await import(transportPath);
      const { createManagerClient } = await import(managerPath);
      const { createManagerChatController } = await import(chatPath);
      const origin = "http://127.0.0.1:4312";
      const auth = createAuthClient({
        environment: "staging",
        transport: createTfRobotAuthTransport({
          baseUrl: origin,
          fetch: globalThis.fetch,
        }),
      });
      await auth.login({ identifier: "fixture", password: "transient" });
      let now = Date.now();
      const statuses: string[] = [],
        paths: string[] = [];
      for (const kind of ["bff", "direct"]) {
        const manager = createManagerClient({
          auth,
          baseUrl: origin,
          fetch: globalThis.fetch,
          now: () => now,
          routing: {
            allowedOrigins: [origin],
            http:
              kind === "bff" ? { kind, baseUrl: `${origin}/api` } : { kind },
          },
        });
        const owned = createManagerChatController({
          manager,
          chat: {
            serverProfile: { kind: "current-server" },
            messageCreatorProvider: () => ({
              name: "Browser fixture",
              uid: "manager-user",
            }),
          },
        });
        try {
          await manager.loadPage(1, 1);
          await manager.loadPage(2, 1);
          if (manager.getSnapshot().items.length !== 2)
            throw new Error("Pagination lost");
          for (const robot of manager.getSnapshot().items) {
            await owned.select(robot);
            const chat = owned.getSnapshot().client;
            if (!chat) throw new Error("No chat");
            const list = await chat.listConversations({
              deadlineAt: Date.now() + 5000,
            });
            if (!list.ok) throw new Error("REST failed");
            const load = await chat.loadConversation({
              conversationId: "42",
              deadlineAt: Date.now() + 5000,
            });
            if (!load.ok) throw new Error("Socket failed");
            statuses.push(chat.getSnapshot().lifecycle.status);
            const info = await manager.getConnectionInfo(robot.employeeId);
            paths.push(info.sioPath);
            now += 11_000; // Demand-driven renewal, no polling or wall-clock sleep.
            const renewed = await chat.listConversations({
              deadlineAt: Date.now() + 5000,
            });
            if (!renewed.ok) throw new Error("Renewal failed");
          }
          await owned.select(undefined);
          if (owned.getSnapshot().client)
            throw new Error("Selection retained chat");
        } finally {
          await owned.dispose();
          await manager.dispose();
        }
      }
      const manager = createManagerClient({
        auth,
        baseUrl: origin,
        fetch: globalThis.fetch,
        routing: { allowedOrigins: [origin], http: { kind: "direct" } },
      });
      const source = manager.createRobotSessionProvider("account-a");
      await source.getSession();
      const owned = createManagerChatController({
        manager,
        chat: {
          serverProfile: { kind: "current-server" },
          messageCreatorProvider: () => ({
            name: "Fixture",
            uid: "manager-user",
          }),
        },
      });
      const first = await manager.loadPage(1, 1);
      await owned.select(first.items[0]);
      const old = owned.getSnapshot().client;
      await auth.switchAccount("browser-account-b");
      if (owned.getSnapshot().client !== undefined)
        throw new Error("Identity switch retained chat");
      await owned.dispose();
      if (!old?.disposed) throw new Error("Identity socket retained");
      let switched = false;
      try {
        await source.getSession();
      } catch {
        switched = true;
      }
      const current = manager.createRobotSessionProvider("account-a");
      await current.getSession();
      await auth.logout();
      let revoked = false;
      try {
        await current.getSession();
      } catch {
        revoked = true;
      }
      await manager.dispose();
      await auth.dispose();
      return { statuses, paths, revoked, switched };
    }, root);
    expect(result.statuses).toHaveLength(4);
    expect(result.paths).toContain("/socket.io/");
    expect(result.paths).toContain("/c/tfrobot/robot-b/socket.io/");
    expect(result.revoked).toBe(true);
    expect(result.switched).toBe(true);
  });
};
