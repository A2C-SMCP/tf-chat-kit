// @vitest-environment jsdom
import { createServer } from "node:http";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { ChatProvider } from "../packages/chat-react/src/index.js";
import type {
  ChatResourceRequest,
  ChatResolvedResource,
} from "../packages/chat-protocol/src/index.js";
import { createLoadedClient, deadlineAt } from "./support/chat-react.js";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { expect, it, vi } from "vitest";
import { ChatResourceProvider } from "../packages/chat-react/src/index.js";
import { ChatResourceView } from "../packages/chat-ui-antd/src/index.js";

it("downloads bytes from a real HTTP resource and releases the browser object URL", async () => {
  const server = createServer((_request, response) => {
    response.end("report bytes");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("No address");
  const createUrl = vi.fn((blob: Blob) => {
    void blob;
    return "blob:https://example.com/download";
  });
  const revoke = vi.fn();
  const click = vi
    .spyOn(HTMLAnchorElement.prototype, "click")
    .mockImplementation(() => undefined);
  const originalCreate = Object.getOwnPropertyDescriptor(
    URL,
    "createObjectURL",
  );
  const originalRevoke = Object.getOwnPropertyDescriptor(
    URL,
    "revokeObjectURL",
  );
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: createUrl,
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    value: revoke,
  });
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = create(
        createElement(ChatResourceView, {
          resource: {
            uri: `http://127.0.0.1:${address.port}/report`,
            name: "report.txt",
          },
        }),
      );
    });
    const clicked = new Promise<void>((resolve) =>
      click.mockImplementation(() => resolve()),
    );
    await act(async () => {
      renderer.root
        .findAllByType("button")
        .find((button) => button.children.includes("Download"))
        ?.props["onClick"]();
      await clicked;
    });
    expect(createUrl.mock.calls[0]?.[0]).toBeDefined();
    expect(revoke).not.toHaveBeenCalled();
    act(() => renderer.unmount());
    expect(revoke).toHaveBeenCalledWith("blob:https://example.com/download");
  } finally {
    act(() => renderer?.unmount());
    click.mockRestore();
    if (originalCreate)
      Object.defineProperty(URL, "createObjectURL", originalCreate);
    else Reflect.deleteProperty(URL, "createObjectURL");
    if (originalRevoke)
      Object.defineProperty(URL, "revokeObjectURL", originalRevoke);
    else Reflect.deleteProperty(URL, "revokeObjectURL");
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it("routes host actions and displays sanitized failure without claiming success", async () => {
  const download = vi.fn(() => {
    throw new Error("private token");
  });
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      createElement(
        ChatResourceProvider,
        { port: { download } },
        createElement(ChatResourceView, {
          resource: { uri: "s3://bucket/file" },
        }),
      ),
    );
  });
  await act(async () => {
    renderer.root
      .findAllByType("button")
      .find((button) => button.children.includes("Download"))
      ?.props["onClick"]();
  });
  expect(download).toHaveBeenCalledOnce();
  expect(JSON.stringify(renderer.toJSON())).toContain("Resource action failed");
  expect(JSON.stringify(renderer.toJSON())).not.toContain("private token");
  act(() => renderer.unmount());
});

it.each(["audio", "video"] as const)(
  "keeps %s src after URL and metadata changes and releases old media",
  async (kind) => {
    const pause = vi
      .spyOn(HTMLMediaElement.prototype, "pause")
      .mockImplementation(() => undefined);
    const load = vi
      .spyOn(HTMLMediaElement.prototype, "load")
      .mockImplementation(() => undefined);
    const container = document.createElement("div");
    const root = createRoot(container);
    const render = async (uri: string, name: string) => {
      await act(async () =>
        root.render(
          createElement(ChatResourceView, { resource: { uri, name }, kind }),
        ),
      );
    };
    try {
      await render("https://example.com/a.mp3", "first");
      const first = container.querySelector(kind);
      await render("https://example.com/b.mp3", "second");
      expect(container.querySelector(kind)?.getAttribute("src")).toBe(
        "https://example.com/b.mp3",
      );
      expect(first?.getAttribute("src")).toBeNull();
      expect(pause).toHaveBeenCalledOnce();
      await render("https://example.com/b.mp3", "renamed");
      expect(container.querySelector(kind)?.getAttribute("src")).toBe(
        "https://example.com/b.mp3",
      );
      expect(pause).toHaveBeenCalledOnce();
    } finally {
      await act(async () => root.unmount());
      pause.mockRestore();
      load.mockRestore();
    }
  },
);

it("cancels same-URI actions across client, conversation and authorization changes and releases late leases", async () => {
  const first = await createLoadedClient();
  const second = await createLoadedClient();
  const requests: ChatResourceRequest[] = [];
  const pending: Array<(value: ChatResolvedResource) => void> = [];
  const port = {
    resolve: (request: ChatResourceRequest) => {
      if (request.purpose === "display")
        return { url: "https://example.com/same" };
      requests.push(request);
      return new Promise<ChatResolvedResource>((resolve) =>
        pending.push(resolve),
      );
    },
  };
  const click = vi
    .spyOn(HTMLAnchorElement.prototype, "click")
    .mockImplementation(() => undefined);
  const tree = (client = first.client, scope = "a") =>
    createElement(
      ChatProvider,
      { client },
      createElement(
        ChatResourceProvider,
        { port, scope },
        createElement(ChatResourceView, {
          resource: { uri: "https://example.com/same" },
        }),
      ),
    );
  let renderer!: ReactTestRenderer;
  const start = async () =>
    act(async () =>
      renderer.root
        .findAllByType("button")
        .find((button) => button.children.includes("Open"))
        ?.props["onClick"](),
    );
  try {
    await act(async () => {
      renderer = create(tree());
    });
    await start();
    expect(requests[0]?.conversationId).toBe(
      first.memory.fixtures.conversation.id,
    );
    await act(async () => renderer.update(tree(second.client)));
    expect(requests[0]?.signal.aborted).toBe(true);
    await start();
    await act(async () => renderer.update(tree(second.client, "b")));
    expect(requests[1]?.signal.aborted).toBe(true);
    await start();
    second.memory.controller.setSnapshot({
      ...second.memory.fixtures.initialSnapshot,
      timeline: [],
      run: null,
      conversation: { ...second.memory.fixtures.conversation, id: "next" },
    });
    await act(async () => {
      await second.client.loadConversation({
        conversationId: "next",
        deadlineAt: deadlineAt(),
      });
    });
    expect(requests[2]?.signal.aborted).toBe(true);
    const dispose = vi.fn();
    await act(async () => {
      for (const resolve of pending)
        resolve({ url: "https://example.com/late", dispose });
    });
    expect(dispose).toHaveBeenCalledTimes(3);
    expect(click).not.toHaveBeenCalled();
  } finally {
    act(() => renderer?.unmount());
    click.mockRestore();
    await first.client.dispose({ deadlineAt: deadlineAt() });
    await second.client.dispose({ deadlineAt: deadlineAt() });
  }
});

it.each(["audio", "video"] as const)(
  "releases the current %s node after error, retry with the same URL and client replacement",
  async (kind) => {
    const first = await createLoadedClient();
    const second = await createLoadedClient();
    const pause = vi
      .spyOn(HTMLMediaElement.prototype, "pause")
      .mockImplementation(() => undefined);
    const load = vi
      .spyOn(HTMLMediaElement.prototype, "load")
      .mockImplementation(() => undefined);
    const container = document.createElement("div");
    const root = createRoot(container);
    const render = async (client = first.client) =>
      act(async () =>
        root.render(
          createElement(
            ChatProvider,
            { client },
            createElement(ChatResourceView, {
              resource: { uri: "https://example.com/same" },
              kind,
            }),
          ),
        ),
      );
    try {
      await render();
      const failed = container.querySelector(kind);
      await act(async () => {
        failed?.dispatchEvent(new Event("error"));
      });
      expect(failed?.getAttribute("src")).toBeNull();
      await act(async () =>
        Array.from(container.querySelectorAll("button"))
          .find((button) => button.textContent === "Retry resource")
          ?.click(),
      );
      const current = container.querySelector(kind);
      expect(current).not.toBe(failed);
      expect(current?.getAttribute("src")).toBe("https://example.com/same");
      await render(second.client);
      expect(pause.mock.contexts).toContain(current);
      expect(current?.getAttribute("src")).toBe("https://example.com/same");
      await act(async () => root.unmount());
      expect(current?.getAttribute("src")).toBeNull();
    } finally {
      await act(async () => root.unmount());
      pause.mockRestore();
      load.mockRestore();
      await first.client.dispose({ deadlineAt: deadlineAt() });
      await second.client.dispose({ deadlineAt: deadlineAt() });
    }
  },
);

it.each([
  [401, "unauthorized"],
  [403, "unauthorized"],
  [404, "not-found"],
  [410, "expired"],
  [415, "unsupported"],
  [500, "unknown"],
  [0, "network"],
] as const)(
  "classifies real HTTP download status %s without displaying response diagnostics",
  async (status, code) => {
    const { defaultChatUiLabels } =
      await import("../packages/chat-ui-antd/src/index.js");
    const server = createServer((request, response) => {
      if (status === 0) {
        request.socket.destroy();
        return;
      }
      response.writeHead(status);
      response.end("token=secret Cookie=private signed-url backend-stack");
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new Error("Missing HTTP address");
    const container = document.createElement("div");
    const root = createRoot(container);
    const appears = (selector: string): Promise<Element> =>
      new Promise((resolve, reject) => {
        const observer = new MutationObserver(() => {
          const node = container.querySelector(selector);
          if (node) {
            clearTimeout(timeout);
            observer.disconnect();
            resolve(node);
          }
        });
        const timeout = setTimeout(() => {
          observer.disconnect();
          reject(new Error("Resource UI did not settle"));
        }, 5000);
        observer.observe(container, { childList: true, subtree: true });
      });
    try {
      const ready = appears("button");
      root.render(
        createElement(ChatResourceView, {
          resource: {
            uri: `http://127.0.0.1:${address.port}/file`,
            name: "file",
          },
        }),
      );
      await ready;
      const failed = appears('[role="alert"]');
      const download = Array.from(container.querySelectorAll("button")).find(
        (node) => node.textContent === "Download",
      );
      expect(download).toBeDefined();
      download?.click();
      expect((await failed).textContent).toBe(
        defaultChatUiLabels.resource![code],
      );
      expect(container.textContent).not.toMatch(
        /secret|Cookie|signed-url|backend-stack/,
      );
    } finally {
      root.unmount();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);
