// @vitest-environment jsdom
import {
  ChatWorkspace,
  ChatComposer,
} from "../packages/chat-ui-antd/src/index.js";
import { createChatClient } from "../packages/chat-runtime/src/index.js";
import { createMemoryChatGateway } from "../packages/chat-testing/src/index.js";
import type {
  ChatError,
  GatewayResult,
  UploadedAttachment,
} from "../packages/chat-protocol/src/index.js";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { beforeAll, expect, it, vi } from "vitest";
import { ChatProvider } from "../packages/chat-react/src/index.js";
import { ChatNotices } from "../packages/chat-ui-antd/src/chat-notices.js";
import { createLoadedClient, deadlineAt } from "./support/chat-react.js";
import type { ChatLifecycle } from "../packages/chat-protocol/src/index.js";
beforeAll(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  Object.defineProperty(window, "matchMedia", {
    value: () => ({
      matches: false,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
    }),
    configurable: true,
  });
});
async function fixture() {
  const { client, memory } = await createLoadedClient();
  const conversationId = memory.fixtures.conversation.id;
  const element = document.createElement("div");
  document.body.append(element);
  const root = createRoot(element);
  await act(async () =>
    root.render(
      createElement(
        ChatProvider,
        { client },
        createElement(ChatNotices, {
          conversationId,
          getDeadlineAt: deadlineAt,
        }),
      ),
    ),
  );
  const emit = async (lifecycle: ChatLifecycle) => {
    await act(async () =>
      memory.controller.emitUpdateToAll({
        kind: "lifecycle.changed",
        conversationId,
        lifecycle,
      }),
    );
  };
  return {
    client,
    memory,
    element,
    conversationId,
    emit,
    close: async () => {
      await act(async () => root.unmount());
      element.remove();
      await client.dispose({ deadlineAt: deadlineAt() });
      vi.useRealTimers();
    },
  };
}
it("keeps initial connection quiet for 2 seconds and does not announce initial degraded", async () => {
  const f = await fixture();
  vi.useFakeTimers();
  try {
    await f.emit({ status: "connecting" });
    await act(async () => vi.advanceTimersByTime(1999));
    expect(f.element.textContent).not.toContain("Connecting");
    await act(async () => vi.advanceTimersByTime(1));
    expect(f.element.textContent).toContain("Connecting");
    expect(f.element.querySelectorAll(".ant-alert")).toHaveLength(0);
    await f.emit({
      status: "degraded",
      recovery: {
        complete: false,
        assurance: "best-effort",
        source: "rest-rebase",
      },
    });
    expect(f.element.textContent).toContain("best-effort");
    expect(f.element.textContent).not.toContain("Connection restored");
  } finally {
    await f.close();
  }
});
it("escalates a continuous disconnect after 5 seconds and pauses recovery while focused", async () => {
  const f = await fixture();
  vi.useFakeTimers();
  try {
    await f.emit({
      status: "reconnecting",
      generation: 2,
      reconnectAttempt: 1,
    });
    expect(f.element.textContent).toContain("Connection lost");
    await act(async () => vi.advanceTimersByTime(4999));
    expect(f.element.querySelectorAll(".ant-alert")).toHaveLength(0);
    await f.emit({ status: "recovering", generation: 2, reconnectAttempt: 1 });
    await act(async () => vi.advanceTimersByTime(1));
    expect(f.element.querySelectorAll(".ant-alert")).toHaveLength(1);
    await f.emit({
      status: "active",
      generation: 2,
      reconnectAttempt: 1,
      recovery: { complete: true, assurance: "verified" },
    });
    expect(f.element.textContent).toContain(
      "Connection and missed updates restored",
    );
    await act(async () => vi.advanceTimersByTime(1000));
    const notice = f.element.querySelector<HTMLElement>(
      '[tabindex="0"][role="status"]',
    )!;
    await act(async () => notice.focus());
    await act(async () => vi.advanceTimersByTime(10000));
    expect(f.element.textContent).toContain(
      "Connection and missed updates restored",
    );
    await act(async () =>
      notice.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })),
    );
    await act(async () => notice.blur());
    await act(async () => vi.advanceTimersByTime(10000));
    expect(f.element.textContent).toContain(
      "Connection and missed updates restored",
    );
    await act(async () =>
      notice.dispatchEvent(new MouseEvent("mouseout", { bubbles: true })),
    );
    await act(async () => vi.advanceTimersByTime(1999));
    expect(f.element.textContent).toContain(
      "Connection and missed updates restored",
    );
    await act(async () => vi.advanceTimersByTime(1));
    expect(f.element.textContent).not.toContain(
      "Connection and missed updates restored",
    );
  } finally {
    await f.close();
  }
});
it("shows authentication immediately, retains independent same-text errors and keeps one banner", async () => {
  const f = await fixture();
  try {
    await f.emit({ status: "auth-required", generation: 1 });
    expect(f.element.querySelectorAll(".ant-alert")).toHaveLength(1);
    await f.emit({ status: "active" });
    for (const id of ["first", "second"])
      await act(async () =>
        f.memory.controller.emitUpdateToAll({
          kind: "error.reported",
          conversationId: f.conversationId,
          error: {
            code: "server",
            message: "same",
            retryable: false,
            conversationId: f.conversationId,
          },
          errorId: id,
          generation: 1,
          source: "domain",
          scope: { kind: "conversation", id: f.conversationId },
        }),
      );
    expect(f.element.querySelectorAll(".ant-alert")).toHaveLength(1);
    expect(f.element.textContent).toContain("2 active faults");
    expect(f.client.getDiagnostics(f.conversationId)).toHaveLength(2);
    await act(async () =>
      f.memory.controller.emitUpdateToAll({
        kind: "error.resolved",
        conversationId: f.conversationId,
        errorId: "second",
      }),
    );
    expect(f.element.querySelectorAll(".ant-alert")).toHaveLength(1);
    await act(async () =>
      f.memory.controller.emitUpdateToAll({
        kind: "error.resolved",
        conversationId: f.conversationId,
        errorId: "first",
      }),
    );
    expect(f.element.querySelectorAll(".ant-alert")).toHaveLength(0);
    expect(f.client.getDiagnostics(f.conversationId)).toHaveLength(2);
  } finally {
    await f.close();
  }
});

it.each([false, true])(
  "retries the failed Workspace selection through its controller (existing selection: %s)",
  async (hasSelection) => {
    const memory = createMemoryChatGateway();
    const client = createChatClient({ gateway: memory.gateway, cache: false });
    const firstId = memory.fixtures.conversation.id;
    memory.controller.setSnapshot({
      ...memory.fixtures.initialSnapshot,
      conversation: {
        ...memory.fixtures.conversation,
        id: "B",
        title: "Conversation B",
      },
      timeline: [],
      run: null,
    });
    const element = document.createElement("div");
    document.body.append(element);
    const root = createRoot(element);
    const original = client.loadConversation.bind(client);
    let failId = hasSelection ? "B" : firstId;
    const load = vi
      .spyOn(client, "loadConversation")
      .mockImplementation(async (input) => {
        if (input.conversationId === failId) {
          failId = "";
          return {
            ok: false,
            error: {
              code: "network",
              message: "failed",
              retryable: true,
              conversationId: input.conversationId,
            },
          };
        }
        return original(input);
      });
    const click = async (name: string) => {
      const button = [...element.querySelectorAll("button")].find((button) =>
        button.textContent?.includes(name),
      );
      expect(button, name).toBeDefined();
      await act(async () => button!.click());
    };
    try {
      await act(async () =>
        root.render(
          createElement(
            ChatProvider,
            { client },
            createElement(ChatWorkspace, {
              initialSelection: "none",
              getDeadlineAt: deadlineAt,
            }),
          ),
        ),
      );
      // The actual conversation-list controls drive the selection and its failure.
      await click(memory.fixtures.conversation.title);
      if (hasSelection) await click("Conversation B");
      await click("Try again");
      const target = hasSelection ? "B" : firstId;
      expect(load.mock.calls.at(-1)?.[0].conversationId).toBe(target);
      expect(client.getSnapshot()?.conversation.id).toBe(target);
      expect(element.querySelector("[data-chat-event-layout]")).not.toBeNull();
    } finally {
      await act(async () => root.unmount());
      element.remove();
      await client.dispose({ deadlineAt: deadlineAt() });
    }
  },
);
it.each([false, true])(
  "records a late upload failure for A without displaying it in B (throws: %s)",
  async (throws) => {
    const { client } = await createLoadedClient();
    let settle!: (value: GatewayResult<UploadedAttachment>) => void;
    let reject!: (reason: unknown) => void;
    const pending = new Promise<GatewayResult<UploadedAttachment>>(
      (resolve, fail) => {
        settle = resolve;
        reject = fail;
      },
    );
    const uploader = { upload: () => pending };
    const element = document.createElement("div");
    document.body.append(element);
    const root = createRoot(element);
    const render = async (id: string) => {
      await act(async () =>
        root.render(
          createElement(ChatComposer, {
            resetKey: id,
            attachmentUploader: uploader,
            getDeadlineAt: deadlineAt,
            onSend: () => true,
            onUploadError: (error: ChatError) =>
              client.recordDiagnostic({ ...error, conversationId: id }),
          }),
        ),
      );
    };
    try {
      await render("A");
      const input =
        element.querySelector<HTMLInputElement>('input[type="file"]')!;
      Object.defineProperty(input, "files", {
        value: [new File(["private"], "private.txt", { type: "text/plain" })],
        configurable: true,
      });
      await act(async () =>
        input.dispatchEvent(new Event("change", { bubbles: true })),
      );
      await render("B");
      await act(async () => {
        if (throws) reject(new Error("private body"));
        else
          settle({
            ok: false,
            error: {
              code: "server",
              message: "private body",
              retryable: false,
            },
          });
      });
      expect(client.getDiagnostics("A")).toHaveLength(1);
      expect(client.getDiagnostics("B")).toHaveLength(0);
      expect(element.querySelector('[role="alert"]')).toBeNull();
    } finally {
      await act(async () => root.unmount());
      element.remove();
      await client.dispose({ deadlineAt: deadlineAt() });
    }
  },
);
it("uses five seconds for best-effort recovery and does not announce a batched invisible fault", async () => {
  const f = await fixture();
  vi.useFakeTimers();
  try {
    await act(async () => {
      f.memory.controller.emitUpdateToAll({
        kind: "lifecycle.changed",
        conversationId: f.conversationId,
        lifecycle: { status: "reconnecting", reconnectAttempt: 1 },
      });
      f.memory.controller.emitUpdateToAll({
        kind: "lifecycle.changed",
        conversationId: f.conversationId,
        lifecycle: {
          status: "active",
          reconnectAttempt: 1,
          recovery: { complete: true },
        },
      });
    });
    expect(f.element.textContent).not.toContain(
      "Connection and missed updates restored",
    );
    await f.emit({ status: "reconnecting", reconnectAttempt: 2 });
    await f.emit({
      status: "degraded",
      reconnectAttempt: 2,
      recovery: {
        complete: false,
        assurance: "best-effort",
        source: "rest-rebase",
      },
    });
    expect(f.element.textContent).toContain(
      "Connection restored with limited recovery",
    );
    await act(async () => vi.advanceTimersByTime(4999));
    expect(f.element.textContent).toContain(
      "Connection restored with limited recovery",
    );
    await act(async () => vi.advanceTimersByTime(1));
    expect(f.element.textContent).not.toContain(
      "Connection restored with limited recovery",
    );
  } finally {
    await f.close();
  }
});

it("keeps dismissed global faults inspectable without exposing another conversation", async () => {
  const f = await fixture();
  try {
    f.client.recordDiagnostic({
      code: "server",
      message: "private",
      retryable: false,
      conversationId: "B",
      diagnostic: { errorId: "other-conversation" },
    });
    await act(async () =>
      f.memory.controller.emitUpdateToAll({
        kind: "error.reported",
        conversationId: f.conversationId,
        error: {
          code: "server",
          message: "private global body",
          retryable: false,
        },
        errorId: "global-fault",
        generation: 1,
        source: "domain",
        scope: { kind: "global" },
      }),
    );
    expect(f.element.textContent).toContain("Diagnostics (1)");
    expect(f.element.textContent).not.toContain("private global body");
    await act(async () =>
      f.element
        .querySelector<HTMLButtonElement>(".ant-alert-close-icon")!
        .click(),
    );
    expect(f.element.querySelector(".ant-alert")).toBeNull();
    const open = [...f.element.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Diagnostics"),
    )!;
    await act(async () => open.click());
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain("global-fault");
    expect(dialog.textContent).not.toContain("other-conversation");
    await act(async () =>
      f.memory.controller.emitUpdateToAll({
        kind: "error.resolved",
        conversationId: f.conversationId,
        errorId: "global-fault",
      }),
    );
    expect(
      f.client.getDiagnostics().find((record) => record.id === "global-fault")
        ?.resolved,
    ).toBe(true);
  } finally {
    await f.close();
  }
});
