import type { Meta, StoryObj } from "@storybook/react-vite";
import { ManagerChatApp } from "@turingfocus/chat-kit/manager-antd";
import {
  createAuthClient,
  type AuthSession,
} from "@turingfocus/chat-auth/headless";
import { createManagerClient } from "@turingfocus/chat-auth/manager";
import type {
  TFRobotSocketFactory,
  TFRobotSocketListener,
} from "@turingfocus/chat-gateway-tfrobot";
import { Owned, Resettable, Scene } from "../support/decorators/scene.js";
import { useShowcase } from "../support/decorators/settings.js";

/** In-memory boundary adapter: actual Manager/Auth/Gateway/Runtime UI runs above it. */
const create = async () => {
  const account = {
    accountId: "demo-account",
    userId: "demo-viewer",
    organizationId: "demo-org",
    displayName: "演示组织",
  };
  let session: AuthSession | null = null;
  const auth = createAuthClient({
    environment: "staging",
    transport: {
      login: async () => {
        session = { kind: "bearer", token: "storybook-fixture-only" };
        return { kind: "authenticated", account };
      },
      selectAccount: async () => ({ kind: "authenticated", account }),
      switchAccount: async () => account,
      getCurrentAccount: async () => account,
      listAccounts: async () => [account],
      getSession: async () => session,
      clearSession: () => {
        session = null;
      },
      logout: async () => {
        session = null;
      },
    },
  });
  let nextConversationId = 43;
  const conversations = new Map([
    [
      42,
      {
        conversationId: 42,
        title: "演示会话",
        description: null,
        updateTimestamp: Date.now(),
      },
    ],
  ]);
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    );
    const method =
      init?.method ?? (input instanceof Request ? input.method : "GET");
    const body =
      typeof init?.body === "string"
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : {};
    const conversationId = Number(
      url.pathname.match(/conversations\/(\d+)/u)?.[1],
    );
    let payload: unknown;
    if (url.pathname.endsWith("/digital-employees"))
      payload = {
        code: 200,
        data: {
          items: [
            {
              id: "demo",
              robotId: "demo-robot",
              robotAccountId: "demo-robot-account",
              name: "项目助理",
              status: "running",
              templateType: "tfrserver",
            },
          ],
          page: 1,
          pageSize: 20,
          total: 1,
        },
      };
    else if (url.pathname.endsWith("/connection-info"))
      payload = {
        code: 200,
        data: {
          socketBaseURL: "https://storybook.invalid",
          namespace: "tenant",
          rid: "demo-robot",
          robotType: "tfrobot",
          sioPath: "/socket.io/",
        },
      };
    else if (url.pathname.endsWith("/oauth/token"))
      payload = {
        access_token: "storybook-robot-fixture",
        token_type: "Bearer",
        expires_in: 3600,
      };
    else if (url.pathname.endsWith("/platforms"))
      payload = { code: 200, data: [{ platformId: 17, name: "组件展示" }] };
    else if (url.pathname.endsWith("/status"))
      payload = { code: 200, data: { working: false, taskId: null } };
    else if (url.pathname.endsWith("/messages") && method === "POST")
      payload = { code: 200, data: { taskId: "demo-task" } };
    else if (url.pathname.endsWith("/messages"))
      payload = {
        code: 200,
        data: {
          messages:
            conversationId === 42
              ? [
                  {
                    msgId: "demo-message",
                    conversationId: 42,
                    content: "这是 ManagerChatApp 的受控演示会话。",
                    role: "assistant",
                    msgType: "text",
                    createTimestamp: Date.now(),
                    additionalKwargs: {},
                    attachments: null,
                    creator: { uid: "robot", name: "项目助理", avatar: null },
                  },
                ]
              : [],
          events: [],
          cursor: null,
        },
      };
    else if (url.pathname.endsWith("/conversations") && method === "POST") {
      const created = {
        conversationId: nextConversationId++,
        title:
          typeof body["title"] === "string" ? body["title"] : "新建演示对话",
        description: null,
        updateTimestamp: Date.now(),
      };
      conversations.set(created.conversationId, created);
      payload = { code: 200, data: created };
    } else if (url.pathname.endsWith("/conversations"))
      payload = {
        code: 200,
        data: { conversations: [...conversations.values()], cursor: null },
      };
    else if (conversations.has(conversationId) && method === "PATCH") {
      const updated = {
        ...conversations.get(conversationId)!,
        title:
          typeof body["title"] === "string"
            ? body["title"]
            : conversations.get(conversationId)!.title,
      };
      conversations.set(conversationId, updated);
      payload = { code: 200, data: updated };
    } else if (conversations.has(conversationId) && method === "DELETE") {
      conversations.delete(conversationId);
      payload = { code: 200, data: { conversationId, message: "Deleted" } };
    } else return new Response("{}", { status: 404 });
    if (typeof payload === "object" && payload !== null && "code" in payload)
      payload = { ...payload, message: "Success" };
    return new Response(JSON.stringify(payload), {
      headers: { "Content-Type": "application/json" },
    });
  };
  const socketFactory: TFRobotSocketFactory = () => {
    const listeners = new Map<string, Set<TFRobotSocketListener>>();
    let connected = false;
    return {
      get connected() {
        return connected;
      },
      connect() {
        connected = true;
        queueMicrotask(() => {
          if (connected) for (const fn of listeners.get("connect") ?? []) fn();
        });
      },
      disconnect() {
        connected = false;
        listeners.clear();
      },
      on(name, fn) {
        if (!listeners.has(name)) listeners.set(name, new Set());
        listeners.get(name)!.add(fn);
      },
      off(name, fn) {
        listeners.get(name)?.delete(fn);
      },
      emit(name, ...args) {
        if (name === "join_conversation") {
          const ack = args.at(-1);
          if (typeof ack === "function")
            ack({ accepted: true, recoveryComplete: true });
        }
      },
    };
  };
  const manager = createManagerClient({
    auth,
    baseUrl: "https://storybook.invalid",
    routing: {
      allowedOrigins: ["https://storybook.invalid"],
      http: { kind: "routed-server" },
    },
    fetch,
  });
  return {
    auth,
    manager,
    chat: {
      conversationContract: "json-v2" as const,
      fetch,
      socketFactory,
      messageCreatorProvider: () => ({ uid: account.userId, name: "演示用户" }),
    },
    dispose: async () => {
      await manager.dispose();
      await auth.dispose();
    },
  };
};
function Manager() {
  const { locale } = useShowcase();
  return (
    <Scene
      title="Manager 完整接入流程"
      description="输入任意演示账号和密码，选择机器人、平台并打开会话。所有 HTTP/Socket 端口在本地内存中响应，不连接真实服务。"
    >
      <Resettable>
        <Owned create={create}>
          {(scene) => (
            <div className="showcase-workspace">
              <ManagerChatApp
                auth={scene.auth}
                manager={scene.manager}
                chat={scene.chat}
                locale={locale}
              />
            </div>
          )}
        </Owned>
      </Resettable>
    </Scene>
  );
}
const meta = {
  title: "认证与接入/ManagerChatApp",
  component: Manager,
} satisfies Meta<typeof Manager>;
export default meta;
export const Flow: StoryObj<typeof meta> = { name: "登录、选择机器人与聊天" };
