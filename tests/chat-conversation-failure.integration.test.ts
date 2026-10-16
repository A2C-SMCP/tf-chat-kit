// @vitest-environment jsdom
import { createServer, type ServerResponse } from "node:http";
import { Server as SocketServer, type Socket } from "socket.io";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { beforeAll, expect, it, vi } from "vitest";
import { createTFRobotChatGateway } from "../packages/chat-gateway-tfrobot/src/index.js";
import { createChatClient } from "../packages/chat-runtime/src/index.js";
import {
  ChatProvider,
  type ChatAttachmentUploader,
} from "../packages/chat-react/src/index.js";
import { ChatConversationView } from "../packages/chat-ui-antd/src/index.js";
import { compactChatZhCN } from "../packages/chat-ui-antd/src/compact-labels.js";
import {
  getConversationFailure,
  type ChatError,
} from "../packages/chat-protocol/src/index.js";

beforeAll(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: () => ({
      matches: false,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
    }),
  });
});
const deadline = () => ({ deadlineAt: Date.now() + 5_000 });
const originalText = "我选中的文字加粗 <img src=x onerror=alert(1)>";
const reason =
  "当前 Chain 的 Token 使用量 139132 超过最大限制 128000。请拆分问题。";

async function fixture(
  attachmentUploader?: ChatAttachmentUploader,
  recoveryErrorTimestamp?: number,
) {
  const originals = {
    msgId: "input-1",
    conversationId: "42",
    createTimestamp: 10,
    msgType: "text",
    role: "user",
    content: originalText,
  };
  const record = {
    id: "saved-1",
    conversationId: "42",
    createTimestamp: 20,
    error: `${reason} fixture-session`,
    code: null,
    message: originals,
  };
  let page = 0;
  let postCount = 0;
  const diagnostics: ChatError[] = [];
  const reply = (response: ServerResponse, data: unknown) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ code: 200, message: "Success", data }));
  };
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const id = url.pathname.includes("/other/") ? "other" : "42";
    if (request.method === "POST") {
      postCount++;
      reply(response, { taskId: "posted" });
    } else if (url.pathname.endsWith("/status"))
      reply(response, { working: true, taskId: "new-running-task" });
    else if (url.pathname.endsWith("/messages")) {
      const older = url.searchParams.has("cursor");
      reply(response, {
        messages:
          recoveryErrorTimestamp !== undefined
            ? [
                {
                  ...originals,
                  msgId: "checkpoint-message",
                  role: "assistant",
                  createTimestamp: 100,
                  content: "Known checkpoint message",
                },
              ]
            : [],
        events: [],
        errors:
          id === "42"
            ? [
                {
                  ...record,
                  id: older
                    ? "saved-older"
                    : page > 0
                      ? "saved-recovered"
                      : "saved-1",
                  createTimestamp: older
                    ? 5
                    : page > 0
                      ? (recoveryErrorTimestamp ?? 300)
                      : 20,
                },
              ]
            : [],
        cursor: older || page > 0 ? null : "older",
      });
    } else
      reply(response, {
        conversations: [{ conversationId: id, title: "Failure contract" }],
        cursor: null,
      });
  });
  const sockets = new SocketServer(server, { transports: ["websocket"] });
  const connected: Socket[] = [];
  sockets.of("/chat").on("connection", (socket) => {
    connected.push(socket);
    socket.on("join_conversation", (_input, ack: (value: unknown) => void) =>
      ack({ accepted: true }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No address");
  const origin = `http://127.0.0.1:${address.port}`;
  const makeClient = () =>
    createChatClient({
      gateway: createTFRobotChatGateway({
        baseUrl: origin,
        socketNamespaceUrl: `${origin}/chat`,
        serverProfile: { kind: "current-server" },
        sessionProvider: {
          getSession: () => ({ kind: "bearer", token: "fixture-session" }),
        },
        messageCreatorProvider: () => ({ uid: "test", name: "Test" }),
        onDiagnostic: (error) => {
          diagnostics.push(error);
        },
      }),
    });
  const client = makeClient();
  expect(
    (await client.loadConversation({ conversationId: "42", ...deadline() })).ok,
  ).toBe(true);
  const container = document.createElement("div");
  container.style.height = "800px";
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      createElement(
        ChatProvider,
        { client, attachmentUploader },
        createElement(ChatConversationView, {
          getDeadlineAt: () => deadline().deadlineAt,
          presentation: "compact",
          labels: compactChatZhCN,
          defaultEventDetailMode: "modal",
        }),
      ),
    ),
  );
  const click = async (label: string) => {
    const button = [...document.querySelectorAll("button")].find(
      (entry) =>
        entry.textContent?.replaceAll(/\s/gu, "") ===
        label.replaceAll(/\s/gu, ""),
    );
    expect(button, label).toBeDefined();
    await act(async () => button!.click());
  };
  return {
    client,
    makeClient,
    container,
    connected,
    sockets,
    diagnostics,
    click,
    postCount: () => postCount,
    recover: () => {
      page++;
    },
    close: async () => {
      await act(async () => root.unmount());
      container.remove();
      await client.dispose(deadline());
      await new Promise<void>((resolve) => sockets.close(() => resolve()));
      server.closeAllConnections();
      if (server.listening)
        await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

it("drives actual HTTP + Socket.IO through Gateway, Runtime and the default UI, with isolated errors and no resend", async () => {
  const f = await fixture();
  const second = f.makeClient();
  try {
    expect(f.container.textContent).toContain("本轮生成失败");
    expect(f.container.textContent).toContain(reason);
    expect(f.container.textContent).toContain("历史错误记录");
    expect(f.container.querySelector("img[src=x]")).toBeNull();
    expect(f.container.textContent).not.toContain("fixture-session");
    await f.click("回填后编辑");
    expect(f.client.getComposerDraft("42").text).toBe(originalText);
    expect(document.activeElement).toBe(f.container.querySelector("textarea"));
    expect(f.postCount()).toBe(0);
    await act(async () =>
      f.client.setComposerDraft({
        conversationId: "42",
        text: "Draft to keep",
      }),
    );
    await f.click("回填后编辑");
    expect(document.body.textContent).toContain("替换当前草稿？");
    await f.click("取消");
    expect(f.client.getComposerDraft("42").text).toBe("Draft to keep");
    await f.click("回填后编辑");
    await f.click("替换草稿");
    expect(f.client.getComposerDraft("42").text).toBe(originalText);
    expect(f.postCount()).toBe(0);
    expect(
      (
        await second.loadConversation({
          conversationId: "other",
          ...deadline(),
        })
      ).ok,
    ).toBe(true);
    const count = f.client.getSnapshot()!.timeline.length;
    await act(async () => {
      f.sockets.of("/chat").emit("chat_error", {
        conversationId: "other",
        error: "Foreign private failure",
        createTimestamp: 40,
      });
      f.sockets.of("/chat").emit("chat_error", {
        conversationId: "42",
        error: `${reason} fixture-session`,
        createTimestamp: 50,
        code: "future.code",
      });
      await vi.waitFor(() =>
        expect(f.client.getSnapshot()!.timeline.length).toBe(count + 1),
      );
    });
    expect(f.container.textContent).toContain("实时错误，尚未确认已保存");
    expect(f.container.textContent).not.toContain("Foreign private failure");
    expect(
      second
        .getSnapshot()!
        .timeline.map(getConversationFailure)
        .filter(Boolean),
    ).toHaveLength(1);
    expect(f.client.getSnapshot()?.run).toMatchObject({
      id: "new-running-task",
      status: "running",
    });
    const observed = f.client
      .getSnapshot()!
      .timeline.find(
        (item) => getConversationFailure(item)?.source === "realtime",
      )!;
    expect(getConversationFailure(observed)?.originalMessage).toBeUndefined();
    expect(
      f.container.querySelector(
        `[data-chat-conversation-failure="${observed.id}"] button`,
      ),
    ).toBeNull();
    expect(f.client.getSnapshot()!.activeErrors).toMatchObject([
      { source: "domain", timelineItemId: observed.id },
    ]);
    expect(
      f.container.querySelector("[data-chat-notices]")?.textContent,
    ).not.toContain("待处理问题");
    expect(
      f.container.querySelector("[data-chat-notices] .ant-alert-error"),
    ).toBeNull();
    expect(
      JSON.stringify([...f.diagnostics, ...f.client.getDiagnostics()]),
    ).not.toMatch(/139132|fixture-session|我选中/);
    await act(async () => {
      expect(
        (
          await f.client.loadConversation({
            conversationId: "42",
            previousCursor: "older",
            ...deadline(),
          })
        ).ok,
      ).toBe(true);
    });
    expect(
      f.client
        .getSnapshot()!
        .timeline.map(getConversationFailure)
        .filter((entry) => entry?.source === "history"),
    ).toHaveLength(2);
    expect(f.postCount()).toBe(0);
  } finally {
    await second.dispose(deadline());
    await f.close();
  }
});

it("rejects stale overwrite confirmations after draft edits or a conversation switch", async () => {
  const f = await fixture();
  try {
    await act(async () =>
      f.client.setComposerDraft({ conversationId: "42", text: "Old draft" }),
    );
    await f.click("回填后编辑");
    await act(async () =>
      f.client.setComposerDraft({ conversationId: "42", text: "Newer draft" }),
    );
    await f.click("替换草稿");
    expect(f.client.getComposerDraft("42").text).toBe("Newer draft");
    await f.click("回填后编辑");
    await act(async () => {
      await f.client.loadConversation({
        conversationId: "other",
        ...deadline(),
      });
    });
    expect(f.client.getComposerDraft("other").text).toBe("");
    expect(f.client.getComposerDraft("42").text).toBe("Newer draft");
    expect(f.postCount()).toBe(0);
  } finally {
    await f.close();
  }
});

it.each([undefined, 100, 90])(
  "recovers persisted failures through the real bounded current-server REST rebase (checkpoint error timestamp: %s)",
  async (timestamp) => {
    const f = await fixture(undefined, timestamp);
    try {
      const socket = f.connected[0]!;
      const transport = socket.conn;
      f.recover();
      await act(async () => {
        transport.close();
        await vi.waitFor(
          () =>
            expect(
              f.client
                .getSnapshot()!
                .timeline.some(
                  (item) =>
                    getConversationFailure(item)?.recordId ===
                    "saved-recovered",
                ),
            ).toBe(true),
          { timeout: 5000 },
        );
      });
      expect(
        f.client
          .getSnapshot()!
          .timeline.some(
            (item) => getConversationFailure(item)?.recordId === "saved-1",
          ),
      ).toBe(true);
      expect(f.postCount()).toBe(0);
    } finally {
      await f.close();
    }
  },
);

it.each(["attachments", "references"])(
  "asks before replacing a draft containing only %s",
  async (kind) => {
    const f = await fixture();
    try {
      await act(async () =>
        f.client.setComposerDraft({
          conversationId: "42",
          text: kind === "references" ? "[reference]" : "",
          attachments:
            kind === "attachments"
              ? [
                  {
                    uri: "https://example.invalid/old.txt",
                    name: "Old attachment",
                    mimeType: "text/plain",
                  },
                ]
              : [],
          longTexts:
            kind === "references"
              ? [
                  {
                    id: "ref",
                    label: "[reference]",
                    content: "Referenced document",
                    start: 0,
                    end: 11,
                  },
                ]
              : [],
        }),
      );
      await f.click("回填后编辑");
      expect(document.body.textContent).toContain("替换当前草稿？");
      await f.click("替换草稿");
      expect(f.client.getComposerDraft("42")).toMatchObject({
        text: originalText,
        attachments: [],
        longTexts: [],
      });
      expect(f.postCount()).toBe(0);
    } finally {
      await f.close();
    }
  },
);

it("keeps disk-only failure input display-only after a partial live history merge", async () => {
  const { createCacheRecord, parseCacheRecord } =
    await import("../packages/chat-runtime/src/cache-record.js");
  const { emptyComposerDraft } =
    await import("../packages/chat-runtime/src/composer-draft.js");
  const { mergeCachedHistory } =
    await import("../packages/chat-runtime/src/conversation-cache.js");
  const { historyDtoSchema } =
    await import("../packages/chat-gateway-tfrobot/src/dto.js");
  const { mapSnapshot } =
    await import("../packages/chat-gateway-tfrobot/src/mapper.js");
  const { createMemoryChatGateway } =
    await import("../packages/chat-testing/src/index.js");
  const value = mapSnapshot(
    { id: "42", title: "Cached failure" },
    historyDtoSchema.parse({
      messages: [
        {
          msgId: "overlap",
          conversationId: "42",
          createTimestamp: 100,
          content: "Overlap",
          msgType: "text",
          role: "assistant",
        },
      ],
      events: [],
      errors: [
        {
          id: "disk-failure",
          conversationId: "42",
          createTimestamp: 20,
          error: reason,
          message: {
            msgId: "cached-input",
            conversationId: "42",
            createTimestamp: 10,
            msgType: "text",
            role: "user",
            content: "Disk-only input",
          },
        },
      ],
    }),
    { working: false },
  );
  const encoded = createCacheRecord(
    "scope",
    value,
    emptyComposerDraft("42"),
    200,
    [],
  );
  // Include a legacy/untrusted cache that supplies actionable-looking input.
  const forged = JSON.parse(JSON.stringify(encoded)) as typeof encoded;
  const entry = forged.snapshot.timeline.find(
    (item) => item.kind === "agent-event",
  );
  if (entry?.kind !== "agent-event") throw new Error("Missing cached failure");
  Object.assign(entry.transitions[0]!.failure!, {
    originalMessage: { id: "cached-input", text: "Disk-only input" },
  });
  const restored = parseCacheRecord(forged, "scope", "42")!;
  const latest = {
    ...value,
    timeline: value.timeline.filter((item) => item.kind === "message"),
    pageInfo: { hasPreviousPage: true, previousCursor: "older" },
  };
  const merged = mergeCachedHistory(latest, restored.snapshot);
  const memory = createMemoryChatGateway();
  memory.controller.setSnapshot(merged);
  const client = createChatClient({ gateway: memory.gateway });
  await client.loadConversation({ conversationId: "42", ...deadline() });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        createElement(
          ChatProvider,
          { client },
          createElement(ChatConversationView, {
            getDeadlineAt: () => deadline().deadlineAt,
            labels: compactChatZhCN,
          }),
        ),
      ),
    );
    expect(container.textContent).toContain(reason);
    expect(
      [...container.querySelectorAll("button")].some((button) =>
        button.textContent?.includes("回填后编辑"),
      ),
    ).toBe(false);
    expect(client.getComposerDraft("42").text).toBe("");
    memory.controller.setSnapshot({
      ...value,
      pageInfo: { hasPreviousPage: true, previousCursor: "older" },
    });
    await act(async () => {
      await client.loadConversation({ conversationId: "42", ...deadline() });
    });
    const restore = [
      ...container.querySelectorAll<HTMLButtonElement>("button"),
    ].find((button) => button.textContent?.includes("回填后编辑"));
    expect(restore).toBeDefined();
    await act(async () => restore!.click());
    expect(client.getComposerDraft("42").text).toBe("Disk-only input");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    await client.dispose(deadline());
  }
});

it("blocks restoration while an old attachment is pending and confirms replacement after upload completes", async () => {
  let finish!: (
    value: Awaited<ReturnType<ChatAttachmentUploader["upload"]>>,
  ) => void;
  const uploading = new Promise<
    Awaited<ReturnType<ChatAttachmentUploader["upload"]>>
  >((resolve) => {
    finish = resolve;
  });
  const f = await fixture({ upload: () => uploading });
  try {
    const picker =
      f.container.querySelector<HTMLInputElement>('input[type="file"]')!;
    expect(picker).not.toBeNull();
    Object.defineProperty(picker, "files", {
      configurable: true,
      value: [new File(["old"], "old.txt", { type: "text/plain" })],
    });
    await act(async () =>
      picker.dispatchEvent(new Event("change", { bubbles: true })),
    );
    const restore = [
      ...f.container.querySelectorAll<HTMLButtonElement>("button"),
    ].find((button) => button.textContent?.includes("回填后编辑"))!;
    expect(restore.disabled).toBe(true);
    await act(async () => restore.click());
    expect(f.client.getComposerDraft("42").text).toBe("");
    await act(async () => {
      finish({
        ok: true,
        value: {
          uri: "https://example.invalid/old.txt",
          name: "old.txt",
          mimeType: "text/plain",
        },
      });
      await uploading;
    });
    expect(restore.disabled).toBe(false);
    await f.click("回填后编辑");
    expect(document.body.textContent).toContain("替换当前草稿？");
    await f.click("替换草稿");
    expect(f.client.getComposerDraft("42")).toMatchObject({
      text: originalText,
      attachments: [],
      longTexts: [],
    });
    expect(f.postCount()).toBe(0);
  } finally {
    finish({
      ok: false,
      error: { code: "unknown", retryable: false, message: "Closed" },
    });
    await f.close();
  }
});

it("does not merge independently observed realtime failures when a new Gateway joins cached history", async () => {
  const f = await fixture();
  const second = f.makeClient();
  try {
    await second.loadConversation({ conversationId: "42", ...deadline() });
    await act(async () => {
      f.sockets.of("/chat").emit("chat_error", {
        conversationId: "42",
        error: reason,
        createTimestamp: 200,
      });
      await vi.waitFor(() =>
        expect(
          second
            .getSnapshot()!
            .timeline.some(
              (item) => getConversationFailure(item)?.source === "realtime",
            ),
        ).toBe(true),
      );
    });
    const firstObservation = f.client
      .getSnapshot()!
      .timeline.find(
        (item) => getConversationFailure(item)?.source === "realtime",
      )!;
    const secondObservation = second
      .getSnapshot()!
      .timeline.find(
        (item) => getConversationFailure(item)?.source === "realtime",
      )!;
    expect(firstObservation.id).not.toBe(secondObservation.id);
    const { createCacheRecord, parseCacheRecord } =
      await import("../packages/chat-runtime/src/cache-record.js");
    const { emptyComposerDraft } =
      await import("../packages/chat-runtime/src/composer-draft.js");
    const { mergeCachedHistory } =
      await import("../packages/chat-runtime/src/conversation-cache.js");
    const encoded = createCacheRecord(
      "scope",
      f.client.getSnapshot()!,
      emptyComposerDraft("42"),
      300,
      [],
    );
    const restored = parseCacheRecord(
      JSON.parse(JSON.stringify(encoded)),
      "scope",
      "42",
    )!;
    const merged = mergeCachedHistory(
      {
        ...second.getSnapshot()!,
        pageInfo: { hasPreviousPage: true, previousCursor: "older" },
      },
      restored.snapshot,
    );
    expect(
      merged.timeline.filter(
        (item) => getConversationFailure(item)?.source === "realtime",
      ),
    ).toHaveLength(2);
  } finally {
    await second.dispose(deadline());
    await f.close();
  }
});

it.each(["inflight", "failed"])(
  "allows removing a %s upload and ignores its late result after restoring text",
  async (mode) => {
    let finish!: (
      value: Awaited<ReturnType<ChatAttachmentUploader["upload"]>>,
    ) => void;
    let cancelled = () => false;
    const uploading = new Promise<
      Awaited<ReturnType<ChatAttachmentUploader["upload"]>>
    >((resolve) => {
      finish = resolve;
    });
    const f = await fixture({
      upload: (input) => {
        cancelled = () => input.cancellation?.aborted === true;
        return uploading;
      },
    });
    try {
      const picker =
        f.container.querySelector<HTMLInputElement>('input[type="file"]')!;
      Object.defineProperty(picker, "files", {
        configurable: true,
        value: [new File(["old"], "old.txt", { type: "text/plain" })],
      });
      await act(async () =>
        picker.dispatchEvent(new Event("change", { bubbles: true })),
      );
      if (mode === "failed")
        await act(async () => {
          finish({
            ok: false,
            error: {
              code: "network",
              retryable: true,
              message: "Upload unavailable",
            },
          });
          await uploading;
        });
      const restore = [
        ...f.container.querySelectorAll<HTMLButtonElement>("button"),
      ].find((button) => button.textContent?.includes("回填后编辑"))!;
      expect(restore.disabled).toBe(true);
      await act(async () =>
        f.container
          .querySelector<HTMLButtonElement>('[aria-label="移除附件 old.txt"]')!
          .click(),
      );
      expect(restore.disabled).toBe(false);
      if (mode === "inflight") expect(cancelled()).toBe(true);
      await f.click("回填后编辑");
      await act(async () => {
        finish({
          ok: true,
          value: {
            uri: "https://example.invalid/late.txt",
            mimeType: "text/plain",
          },
        });
        await uploading;
      });
      expect(f.client.getComposerDraft("42")).toMatchObject({
        text: originalText,
        attachments: [],
        longTexts: [],
      });
      expect(f.postCount()).toBe(0);
    } finally {
      finish({
        ok: false,
        error: { code: "unknown", retryable: false, message: "Closed" },
      });
      await f.close();
    }
  },
);
