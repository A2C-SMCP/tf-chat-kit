import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  createTFRobotChatClient,
  createTFRobotRemoteToolClient,
  createTFRobotSocketConnection,
  defineRemoteTool,
} from "../../../packages/chat-kit/dist/headless.js";

const python = spawn(
  process.env["TFCK_PYTHON"] ?? "python3",
  [new URL("./python-socket-server.py", import.meta.url).pathname],
  { stdio: ["ignore", "pipe", "inherit"] },
);
const [chunk] = await once(python.stdout, "data");
const origin = `http://127.0.0.1:${String(chunk).trim()}`;
const context = createTFRobotSocketConnection({ serverUrl: origin });
const sessionProvider = {
  getSession: () => ({ kind: "bearer", token: "local-python-probe" }),
};
const chat = createTFRobotChatClient({
  baseUrl: origin,
  socketFactory: context.socketFactory,
  sessionProvider,
  messageCreatorProvider: () => ({ uid: "local", name: "Local" }),
});
const tools = createTFRobotRemoteToolClient({
  baseUrl: origin,
  socketFactory: context.socketFactory,
  sessionProvider,
  connectionTimeoutMs: 300,
  tools: [
    defineRemoteTool({
      definition: {
        toolName: "host_tool",
        description: "Probe",
        parameters: { type: "object" },
        tags: ["Read"],
      },
      validate: () => undefined,
      execute: () => ({ ok: true, resultForLlm: "local" }),
    }),
  ],
});
const state = (expected) =>
  new Promise((resolve, reject) => {
    if (tools.getSnapshot().status === expected) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      stop();
      reject(new Error(JSON.stringify(tools.getSnapshot())));
    }, 3000);
    const stop = tools.subscribe(() => {
      if (tools.getSnapshot().status === expected) {
        clearTimeout(timer);
        stop();
        resolve();
      }
    });
  });
try {
  const loaded = await chat.loadConversation({
    conversationId: "1",
    deadlineAt: Date.now() + 5000,
  });
  if (!loaded.ok) throw new Error(JSON.stringify(loaded));
  tools.start();
  await state("error");
  await fetch(`${origin}/release`);
  tools.retry();
  await state("ready");
  const stats = await (await fetch(`${origin}/stats`)).json();
  console.log(
    JSON.stringify({
      ...stats,
      toolState: tools.getSnapshot(),
      chatLifecycle: chat.getSnapshot()?.lifecycle,
    }),
  );
  if (
    stats.chat_disconnects ||
    stats.chat_connects !== 1 ||
    stats.engines !== 1
  )
    throw new Error("Chat was disturbed");
} finally {
  tools.dispose();
  await chat.dispose({ deadlineAt: Date.now() + 1000 });
  context.dispose();
  python.kill("SIGTERM");
  await once(python, "exit");
}
