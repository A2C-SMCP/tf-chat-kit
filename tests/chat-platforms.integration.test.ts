import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  TFRobotChatGateway,
  createTFRobotPlatformClient,
} from "../packages/chat-gateway-tfrobot/src/index.js";
import { createManagerChatController } from "../packages/chat-kit/src/manager.js";
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((fn) => fn()));
});
const deadline = () => ({ deadlineAt: Date.now() + 5_000 });
const sessionProvider = {
  getSession: () => ({ kind: "bearer" as const, token: "fixture-robot-token" }),
};
const messageCreatorProvider = () => ({ name: "Test", uid: "user" });
const json = (res: ServerResponse, data: unknown, status = 200) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ code: status, message: "Fixture", data }));
};
async function serve(
  handler: (req: IncomingMessage, res: ServerResponse, body: string) => void,
) {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on("end", () => handler(req, res, body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing port");
  cleanup.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return `http://127.0.0.1:${address.port}`;
}
describe("Server conversation contract over real HTTP", () => {
  it.each(["query-v1", "json-v2"] as const)(
    "sends only the explicit %s contract",
    async (conversationContract) => {
      const wire: Array<{
        url: string;
        body: string;
        type: string | undefined;
        auth: string | undefined;
      }> = [];
      const baseUrl = await serve((req, res, body) => {
        wire.push({
          url: req.url ?? "",
          body,
          type: req.headers["content-type"],
          auth: req.headers.authorization,
        });
        json(res, {
          conversationId: 42,
          title: "Word UAT",
          description: null,
          updateTimestamp: Date.now(),
        });
      });
      const gateway = new TFRobotChatGateway({
        baseUrl,
        sessionProvider,
        messageCreatorProvider,
        conversationContract,
        platformId: 17,
      });
      try {
        expect(
          await gateway.createConversation({
            ...deadline(),
            title: "Word UAT",
          }),
        ).toMatchObject({ ok: true, value: { id: "42" } });
        expect(wire).toHaveLength(1);
        expect(wire[0]?.auth).toBe("Bearer fixture-robot-token");
        if (conversationContract === "json-v2") {
          expect(wire[0]?.url).toBe("/v1/chat/conversations");
          expect(JSON.parse(wire[0]?.body ?? "")).toEqual({
            title: "Word UAT",
            platformId: 17,
          });
          expect(wire[0]?.type).toContain("application/json");
        } else {
          expect(
            new URL(wire[0]?.url ?? "", baseUrl).searchParams.get("platformId"),
          ).toBe("17");
          expect(wire[0]?.body).toBe("");
        }
      } finally {
        gateway.dispose(deadline());
      }
    },
  );
  it.each([undefined, "17", 0, -1, 1.2, NaN, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid json-v2 platform %s before sending",
    async (platformId) => {
      let requests = 0;
      const baseUrl = await serve((_req, res) => {
        requests++;
        json(res, null);
      });
      const gateway = new TFRobotChatGateway({
        baseUrl,
        sessionProvider,
        messageCreatorProvider,
        conversationContract: "json-v2",
        platformId,
      });
      try {
        expect(
          await gateway.createConversation({ ...deadline(), title: "UAT" }),
        ).toMatchObject({ ok: false, error: { code: "validation" } });
        expect(requests).toBe(0);
      } finally {
        gateway.dispose(deadline());
      }
    },
  );
  it("does not retry the legacy creation protocol after a 422", async () => {
    let requests = 0;
    const baseUrl = await serve((_req, res) => {
      requests++;
      json(res, null, 422);
    });
    const gateway = new TFRobotChatGateway({
      baseUrl,
      sessionProvider,
      messageCreatorProvider,
      conversationContract: "json-v2",
      platformId: 17,
    });
    try {
      expect(
        await gateway.createConversation({ ...deadline(), title: "UAT" }),
      ).toMatchObject({ ok: false, error: { code: "validation" } });
      expect(requests).toBe(1);
    } finally {
      gateway.dispose(deadline());
    }
  });
  it.each([null, [], [{ platformId: 17, name: "Word" }]])(
    "returns actual catalog or an empty list",
    async (data) => {
      const baseUrl = await serve((req, res) => {
        expect(req.url).toBe("/v1/chat/platforms");
        expect(req.headers.authorization).toBe("Bearer fixture-robot-token");
        json(res, data);
      });
      const catalog = createTFRobotPlatformClient({ baseUrl, sessionProvider });
      expect(await catalog.list(deadline())).toEqual({
        ok: true,
        value: data ?? [],
      });
      catalog.dispose();
      expect(await catalog.list(deadline())).toMatchObject({
        ok: false,
        error: { code: "conflict" },
      });
    },
  );
  it.each([403, 422])("preserves catalog HTTP %i failures", async (status) => {
    const baseUrl = await serve((_req, res) => json(res, null, status));
    const catalog = createTFRobotPlatformClient({ baseUrl, sessionProvider });
    try {
      expect(await catalog.list(deadline())).toMatchObject({
        ok: false,
        error: { code: status === 403 ? "authorization" : "validation" },
      });
    } finally {
      catalog.dispose();
    }
  });
  it("requires explicit selection, rejects stale IDs and releases the old client when switching", async () => {
    const baseUrl = await serve((_req, res) =>
      json(res, [
        { platformId: 17, name: "Word" },
        { platformId: 18, name: "Other" },
      ]),
    );
    let releases = 0;
    const controller = createManagerChatController({
      manager: {
        subscribe: () => () => {},
        connect: async () => ({
          target: {
            baseUrl,
            socketNamespaceUrl: `${baseUrl}/chat`,
            socketPath: "/socket.io/",
          },
          sessionProvider,
          dispose: () => {
            releases++;
          },
        }),
      },
      chat: { messageCreatorProvider, conversationContract: "json-v2" },
    });
    try {
      await controller.select("robot");
      expect(controller.getSnapshot()).toMatchObject({
        status: "platform-selection-required",
        platforms: [{ platformId: 17 }, { platformId: 18 }],
      });
      await controller.select("robot", { platformId: 99 });
      expect(controller.getSnapshot()).toMatchObject({
        status: "error",
        error: { code: "invalid_platform" },
      });
      await controller.select("robot", { platformId: 17 });
      const first = controller.getSnapshot().client;
      expect(first).toBeDefined();
      await controller.select("robot", { platformId: 18 });
      expect(controller.getSnapshot()).toMatchObject({
        status: "ready",
        platformId: 18,
      });
      expect(controller.getSnapshot().client).not.toBe(first);
      expect(releases).toBe(3);
    } finally {
      await controller.dispose();
    }
    expect(releases).toBe(4);
  });
  it("discards an in-flight catalog on identity change", async () => {
    let arrived!: () => void;
    const started = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    const baseUrl = await serve(() => {
      arrived();
    });
    let identity:
      | ((snapshot: { status: string; identityRevision: number }) => void)
      | undefined;
    const controller = createManagerChatController({
      manager: {
        subscribe: (listener) => {
          identity = listener;
          return () => {};
        },
        connect: async () => ({
          target: {
            baseUrl,
            socketNamespaceUrl: `${baseUrl}/chat`,
            socketPath: "/socket.io/",
          },
          sessionProvider,
          dispose: () => {},
        }),
      },
      chat: {
        messageCreatorProvider,
        conversationContract: "json-v2",
        platformId: 17,
      },
    });
    try {
      const work = controller.select("robot");
      await started;
      identity?.({ status: "ready", identityRevision: 1 });
      await work;
      expect(controller.getSnapshot()).toEqual({ status: "idle" });
    } finally {
      await controller.dispose();
    }
  });
});
