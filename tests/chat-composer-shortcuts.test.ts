// @vitest-environment jsdom
import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { beforeAll, expect, it, vi } from "vitest";
import {
  ChatComposer,
  ChatConversationView,
  ChatWorkspace,
  type ChatComposerProps,
} from "../packages/chat-kit/src/index.js";
import { ChatProvider } from "../packages/chat-kit/src/react.js";
import {
  createLoadedClient,
  deadlineAt,
  flushMicrotasks,
} from "./support/chat-react.js";

beforeAll(() => {
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
const mount = async (node: ReactNode) => {
  const element = document.createElement("div");
  document.body.append(element);
  const root = createRoot(element);
  const prior = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const render = async (next: ReactNode) => {
    await act(async () => {
      root.render(next);
      await flushMicrotasks();
    });
  };
  await render(node);
  return {
    element,
    render,
    async close() {
      await act(async () => {
        root.unmount();
      });
      element.remove();
      Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", prior);
    },
  };
};
const inputOf = (element: HTMLElement) =>
  element.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')!;
const type = async (input: HTMLTextAreaElement, value: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
const key = (input: HTMLTextAreaElement, init: KeyboardEventInit = {}) => {
  const event = new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    key: "Enter",
    keyCode: 13,
    ...init,
  });
  input.dispatchEvent(event);
  return event;
};

it.each([undefined, "ctrl-enter", "enter"] as const)(
  "defines exact modifier behavior in %s mode",
  async (mode) => {
    const onSend = vi.fn(() => false);
    const view = await mount(
      createElement(ChatComposer, { onSend, sendShortcut: mode }),
    );
    try {
      const input = inputOf(view.element);
      await type(input, "draft");
      for (const modifiers of [
        { shiftKey: true },
        { metaKey: true },
        { altKey: true },
        { ctrlKey: true, shiftKey: true },
        { ctrlKey: true, metaKey: true },
        { ctrlKey: true, altKey: true },
      ]) {
        await act(async () => {
          expect(key(input, modifiers).defaultPrevented).toBe(false);
        });
      }
      expect(onSend).not.toHaveBeenCalled();
      await act(async () => {
        expect(key(input).defaultPrevented).toBe(mode === "enter");
      });
      expect(onSend).toHaveBeenCalledTimes(mode === "enter" ? 1 : 0);
      await act(async () => {
        expect(key(input, { ctrlKey: true }).defaultPrevented).toBe(true);
      });
      expect(onSend).toHaveBeenCalledTimes(mode === "enter" ? 2 : 1);
      expect(input.getAttribute("aria-describedby")).toBeTruthy();
      expect(view.element.textContent).toContain(
        mode === "enter" ? "Shift+Enter" : "Ctrl+Enter to send",
      );
    } finally {
      await view.close();
    }
  },
);

it.each(["ctrl-enter", "enter"] as const)(
  "protects IME composition and end-before-keydown in %s mode",
  async (sendShortcut) => {
    const onSend = vi.fn(() => false);
    const view = await mount(
      createElement(ChatComposer, { onSend, sendShortcut }),
    );
    try {
      const input = inputOf(view.element);
      await type(input, "中文");
      await act(async () => {
        for (const ctrlKey of [false, true]) {
          input.dispatchEvent(
            new CompositionEvent("compositionstart", { bubbles: true }),
          );
          key(input, { ctrlKey });
          input.dispatchEvent(
            new CompositionEvent("compositionend", {
              bubbles: true,
              data: "中文",
            }),
          );
          // WebKit can report isComposing=false on the IME's confirming keydown.
          key(input, { keyCode: 229, isComposing: false, ctrlKey });
          key(input, { isComposing: true, ctrlKey });
        }
      });
      expect(onSend).not.toHaveBeenCalled();
      await act(async () => {
        key(input, { ctrlKey: true });
      });
      expect(onSend).toHaveBeenCalledExactlyOnceWith("中文", []);
    } finally {
      await view.close();
    }
  },
);

it("ignores repeats and serializes keyboard/button submissions before React commits", async () => {
  let finish!: (value: boolean) => void;
  const onSend = vi.fn(
    () =>
      new Promise<boolean>((resolve) => {
        finish = resolve;
      }),
  );
  const view = await mount(createElement(ChatComposer, { onSend }));
  try {
    const input = inputOf(view.element);
    await type(input, "draft");
    await act(async () => {
      key(input, { ctrlKey: true, repeat: true });
      expect(onSend).not.toHaveBeenCalled();
      key(input, { ctrlKey: true });
      key(input, { ctrlKey: true });
      view.element.querySelector<HTMLButtonElement>("button")!.click();
    });
    expect(onSend).toHaveBeenCalledTimes(1);
    await act(async () => {
      finish(false);
    });
    expect(input.value).toBe("draft");
    await act(async () => {
      key(input, { ctrlKey: true, repeat: true });
    });
    expect(onSend).toHaveBeenCalledTimes(1);
    await act(async () => {
      view.element.querySelector<HTMLButtonElement>("button")!.click();
    });
    expect(onSend).toHaveBeenCalledTimes(2);
    await act(async () => {
      finish(true);
    });
    expect(input.value).toBe("");
  } finally {
    await view.close();
  }
});

it("retains controlled text and attachments when changing mode, and supports translated hints", async () => {
  const onSend = vi.fn(() => false);
  const draft: NonNullable<ChatComposerProps["draft"]> = {
    conversationId: "A",
    text: "saved",
    attachments: [
      { uri: "file:attachment", name: "notes.txt", mimeType: "text/plain" },
    ],
    longTexts: [],
    revision: 1,
  };
  const view = await mount(createElement(ChatComposer, { onSend, draft }));
  try {
    const original = inputOf(view.element);
    await view.render(
      createElement(ChatComposer, {
        onSend,
        draft,
        sendShortcut: "enter",
        labels: { composerEnterHint: "按 Enter 发送，Shift+Enter 换行" },
      }),
    );
    expect(inputOf(view.element)).toBe(original);
    expect(original.value).toBe("saved");
    expect(view.element.textContent).toContain("notes.txt");
    expect(view.element.textContent).toContain("按 Enter 发送");
    await act(async () => {
      key(original);
    });
    expect(onSend).toHaveBeenCalledExactlyOnceWith("saved", draft.attachments);
  } finally {
    await view.close();
  }
});

it.each([{ disabled: true }, { textInputDisabled: true }, {}])(
  "preserves disabled and empty-content guards: %j",
  async (flags) => {
    const onSend = vi.fn(() => false);
    const view = await mount(createElement(ChatComposer, { onSend, ...flags }));
    try {
      const input = inputOf(view.element);
      if (flags.disabled || flags.textInputDisabled) await type(input, "draft");
      await act(async () => {
        key(input, { ctrlKey: true });
      });
      expect(onSend).not.toHaveBeenCalled();
    } finally {
      await view.close();
    }
  },
);

it.each(["view", "workspace"] as const)(
  "forwards mode through the public %s entry and uses the Runtime send path",
  async (entry) => {
    const { client, memory } = await createLoadedClient();
    const renderEntry = (sendShortcut: "enter" | "ctrl-enter") =>
      createElement(
        ChatProvider,
        { client },
        entry === "view"
          ? createElement(ChatConversationView, {
              getDeadlineAt: deadlineAt,
              sendShortcut,
            })
          : createElement(ChatWorkspace, {
              getDeadlineAt: deadlineAt,
              initialSelection: "first",
              conversationViewProps: { sendShortcut },
            }),
      );
    const view = await mount(renderEntry("enter"));
    try {
      const input = inputOf(view.element);
      expect(input).not.toBeNull();
      await type(input, "kept while switching");
      await view.render(renderEntry("ctrl-enter"));
      expect(inputOf(view.element).value).toBe("kept while switching");
      await act(async () => {
        key(inputOf(view.element));
      });
      expect(
        memory.controller.calls.filter((call) => call.operation === "sendText"),
      ).toHaveLength(0);
      await act(async () => {
        key(inputOf(view.element), { ctrlKey: true });
        await flushMicrotasks();
      });
      expect(
        memory.controller.calls.filter((call) => call.operation === "sendText"),
      ).toHaveLength(1);
    } finally {
      await view.close();
      await client.dispose({ deadlineAt: deadlineAt() });
    }
  },
);

it("keeps keyboard sending blocked while an attachment is uploading", async () => {
  type UploadResult = Awaited<
    ReturnType<NonNullable<ChatComposerProps["attachmentUploader"]>["upload"]>
  >;
  let finish!: (result: UploadResult) => void;
  const attachmentUploader = {
    upload: () =>
      new Promise<UploadResult>((resolve) => {
        finish = resolve;
      }),
  };
  const onSend = vi.fn(() => false);
  const view = await mount(
    createElement(ChatComposer, {
      onSend,
      attachmentUploader,
      getDeadlineAt: deadlineAt,
    }),
  );
  try {
    const input = inputOf(view.element);
    await type(input, "draft");
    const fileInput =
      view.element.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(fileInput, "files", {
      configurable: true,
      value: [new File(["data"], "notes.txt", { type: "text/plain" })],
    });
    await act(async () => {
      fileInput.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => {
      key(input, { ctrlKey: true });
    });
    expect(onSend).not.toHaveBeenCalled();
    await act(async () => {
      finish({
        ok: true,
        value: { uri: "file:notes", mimeType: "text/plain", name: "notes.txt" },
      });
    });
    await act(async () => {
      key(input, { ctrlKey: true });
    });
    expect(onSend).toHaveBeenCalledTimes(1);
  } finally {
    await view.close();
  }
});
