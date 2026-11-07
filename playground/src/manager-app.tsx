import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Button, Checkbox, Space, Spin } from "antd";
import { ManagerChatApp } from "@turingfocus/chat-kit/manager-antd";
import {
  createManagerClient,
  type ManagerClient,
} from "@turingfocus/chat-kit/auth/manager";
import type { AuthClient } from "@turingfocus/chat-kit/auth";

declare const __TF_CHAT_PLAYGROUND_ALLOWED_SERVER_ORIGINS__: string;

/** The Playground consumes the same complete Manager UI as external hosts. */
export function PlaygroundManagerApp({
  auth,
  baseUrl,
  onReset,
}: {
  readonly auth: AuthClient;
  readonly baseUrl: string;
  readonly onReset: () => void;
}) {
  const [entry, setEntry] = useState<{
    auth: AuthClient;
    baseUrl: string;
    client: ManagerClient;
  }>();
  const manager =
    entry?.auth === auth && entry.baseUrl === baseUrl
      ? entry.client
      : undefined;
  const [debug, setDebug] = useState(false);
  const status = useSyncExternalStore(
    (listener) => auth.subscribe(listener),
    () => auth.getSnapshot().status,
    () => auth.getSnapshot().status,
  );
  useEffect(() => {
    const client = createManagerClient({
      auth,
      baseUrl,
      timeoutMs: 60_000,
      routing: {
        allowedOrigins:
          typeof __TF_CHAT_PLAYGROUND_ALLOWED_SERVER_ORIGINS__ === "string"
            ? __TF_CHAT_PLAYGROUND_ALLOWED_SERVER_ORIGINS__
                .split(",")
                .map((origin) => origin.trim())
                .filter(Boolean)
            : [],
        isTrustedOrigin: (origin) => {
          const url = new URL(origin);
          return (
            url.protocol === "https:" &&
            (url.hostname === "turingfocus.cn" ||
              url.hostname.endsWith(".turingfocus.cn"))
          );
        },
        http: { kind: "routed-server" },
      },
    });
    setEntry({ auth, baseUrl, client });
    return () => {
      void client.dispose();
    };
  }, [auth, baseUrl]);
  const chat = useMemo(
    () => ({
      conversationContract: "json-v2" as const,
      serverProfile: { kind: "current-server" as const },
      messageCreatorProvider: () => ({
        uid: auth.getSnapshot().account?.userId ?? "manager-user",
        name: "Manager 用户",
      }),
    }),
    [auth],
  );
  return (
    <>
      <Space style={{ padding: "0 16px 12px" }}>
        <Checkbox
          checked={debug}
          onChange={(event) => setDebug(event.target.checked)}
        >
          开发诊断
        </Checkbox>
        {status === "signed_out" ? (
          <Button onClick={onReset}>更换 Manager 环境</Button>
        ) : null}
      </Space>
      {manager ? (
        <ManagerChatApp
          auth={auth}
          manager={manager}
          chat={chat}
          debug={debug}
          requestTimeoutMs={60_000}
          locale="zh-CN"
          style={{ height: "80vh", minHeight: 480 }}
        />
      ) : (
        <Spin />
      )}
    </>
  );
}
