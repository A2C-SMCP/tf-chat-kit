import { createServer } from "node:http";
import { afterEach, expect, it } from "vitest";
import { createManagerChatController } from "../packages/chat-kit/src/manager.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

it("Manager uploads use the selected robot session and route; switching cancels old uploads", async () => {
  const requests: {
    url: string;
    authorization: string | undefined;
    body: string;
  }[] = [];
  let started!: () => void;
  const pending = new Promise<void>((resolve) => {
    started = resolve;
  });
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on("end", () => {
      requests.push({
        url: req.url!,
        authorization: req.headers.authorization,
        body,
      });
      if (body.includes('filename="pending.png"')) {
        started();
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          code: 200,
          message: "Success",
          data: { uri: "s3://image" },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing port");
  const origin = `http://127.0.0.1:${address.port}`;
  const controller = createManagerChatController({
    manager: {
      subscribe: () => () => {},
      connect: async (robot: string) => ({
        target: {
          baseUrl: `${origin}/${robot}`,
          socketNamespaceUrl: `${origin}/chat`,
          socketPath: "/socket.io/",
        },
        sessionProvider: {
          getSession: () => ({ kind: "bearer" as const, token: robot }),
        },
        dispose() {},
      }),
    },
    chat: { messageCreatorProvider: () => ({ uid: "user", name: "User" }) },
  });
  cleanups.push(async () => {
    await controller.dispose();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const input = {
    blob: new Blob(["image"], { type: "image/png" }),
    fileName: "image.png",
    deadlineAt: Date.now() + 10_000,
  };
  await controller.select("robot-a");
  const first = controller.getSnapshot().attachmentUploader!;
  expect(await first.upload(input)).toMatchObject({
    ok: true,
    value: { uri: "s3://image", mimeType: "image/png" },
  });
  const uploading = first.upload({ ...input, fileName: "pending.png" });
  await pending;
  await controller.select("robot-b");
  expect((await uploading).ok).toBe(false);
  expect((await first.upload(input)).ok).toBe(false);
  const second = controller.getSnapshot().attachmentUploader!;
  expect(second).not.toBe(first);
  expect((await second.upload(input)).ok).toBe(true);
  expect(
    requests.map(({ url, authorization }) => ({ url, authorization })),
  ).toEqual([
    {
      url: "/robot-a/v1/chat/attachments",
      authorization: "Bearer robot-a",
    },
    {
      url: "/robot-a/v1/chat/attachments",
      authorization: "Bearer robot-a",
    },
    {
      url: "/robot-b/v1/chat/attachments",
      authorization: "Bearer robot-b",
    },
  ]);
  expect(requests[0]!.body).toContain('name="file"; filename="image.png"');
  await controller.dispose();
  expect(controller.getSnapshot().attachmentUploader).toBeUndefined();
  expect((await second.upload(input)).ok).toBe(false);
});
