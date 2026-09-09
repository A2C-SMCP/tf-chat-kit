// @vitest-environment jsdom
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it } from "vitest";
import {
  ChatResourceError,
  normalizeChatResourceError,
  type ChatResourceErrorCode,
  type ChatResourcePort,
} from "../packages/chat-protocol/src/index.js";
import { ChatResourceProvider } from "../packages/chat-react/src/index.js";
import {
  ChatResourceView,
  ChatEventDetail,
  ChatTimeline,
  defaultChatUiLabels,
} from "../packages/chat-ui-antd/src/index.js";
import { playgroundChatLabels } from "../playground/src/playground-zh-cn.js";
import { createCapabilityTimeline } from "../playground/src/capability-scenarios.js";

const codes: readonly ChatResourceErrorCode[] = [
  "unauthorized",
  "network",
  "not-found",
  "expired",
  "unsupported",
  "cancelled",
  "unknown",
];
const privateDiagnostic =
  "token=secret Cookie=session https://private.test/?signature=secret backend-stack";
const renderResource = (
  port: ChatResourcePort,
  props: Parameters<typeof ChatResourceView>[0],
) =>
  createElement(
    ChatResourceProvider,
    { port },
    createElement(ChatResourceView, props),
  );
const press = async (renderer: ReactTestRenderer, label: string) => {
  await act(async () => {
    const button = renderer.root
      .findAllByType("button")
      .find((node) => node.children.includes(label));
    expect(button).toBeDefined();
    button?.props["onClick"]();
  });
};

it("normalizes only safe outcomes, including native cancellation and hostile errors", () => {
  let reads = 0;
  expect(
    normalizeChatResourceError({
      get code() {
        return ++reads === 1 ? "network" : privateDiagnostic;
      },
    }),
  ).toEqual({ code: "network", retryable: true });
  expect(reads).toBe(1);
  for (const code of codes) {
    const error = {
      code,
      message: privateDiagnostic,
      cause: privateDiagnostic,
      stack: privateDiagnostic,
      retryable: true,
    };
    const result = normalizeChatResourceError(error);
    expect(result).toEqual({
      code,
      retryable: ["unauthorized", "network", "expired", "unknown"].includes(
        code,
      ),
    });
    expect(JSON.stringify(result)).not.toContain("secret");
  }
  expect(
    normalizeChatResourceError(
      new DOMException(privateDiagnostic, "AbortError"),
    ).code,
  ).toBe("cancelled");
  expect(normalizeChatResourceError(new Error(privateDiagnostic)).code).toBe(
    "unknown",
  );
  expect(normalizeChatResourceError({ code: "backend-code" }).code).toBe(
    "unknown",
  );
  expect(
    normalizeChatResourceError(
      new Proxy(
        {},
        {
          has() {
            throw new Error(privateDiagnostic);
          },
        },
      ),
    ).code,
  ).toBe("unknown");
});

for (const [language, labels] of [
  ["en", defaultChatUiLabels],
  ["zh", playgroundChatLabels],
] as const) {
  describe(language, () => {
    it.each(codes)(
      "renders safe %s outcomes consistently for images, audio, video and files",
      async (code) => {
        let renderer!: ReactTestRenderer;
        try {
          for (const kind of ["image", "audio", "video", "file"] as const) {
            await act(async () => {
              renderer = create(
                renderResource(
                  {
                    resolve: () => {
                      throw { code, message: privateDiagnostic };
                    },
                  },
                  { resource: { uri: "private:resource" }, kind, labels },
                ),
              );
            });
            const output = JSON.stringify(renderer.toJSON());
            expect(output).toContain(labels.resource![code]);
            expect(output).not.toContain("secret");
            expect(
              renderer.root.findAllByProps({ role: "alert" }),
            ).toHaveLength(code === "cancelled" ? 0 : 1);
            expect(output.includes(labels.resource!.retry!)).toBe(
              ["unauthorized", "network", "expired", "unknown"].includes(code),
            );
            if (language === "zh")
              expect(output).not.toMatch(
                /Unavailable|Resource action|Retry resource|Download|Open|Loading/,
              );
            act(() => renderer.unmount());
          }
        } finally {
          act(() => renderer?.unmount());
        }
      },
    );

    it.each(["open", "download"] as const)(
      "localizes %s progress, errors and subsequent successful action",
      async (purpose) => {
        let settle!: () => void;
        let attempt = 0;
        const action = () => {
          attempt++;
          if (attempt === 1) throw new ChatResourceError("network");
          return new Promise<void>((resolve) => {
            settle = resolve;
          });
        };
        let renderer!: ReactTestRenderer;
        try {
          await act(async () => {
            renderer = create(
              renderResource(
                {
                  resolve: () => ({ url: "https://example.test/file" }),
                  [purpose]: action,
                },
                { resource: { uri: "private:file" }, labels },
              ),
            );
          });
          await press(renderer, labels.resource![purpose]!);
          expect(JSON.stringify(renderer.toJSON())).toContain(
            labels.resource!.network,
          );
          await press(renderer, labels.resource![purpose]!);
          expect(renderer.root.findAllByProps({ role: "alert" })).toHaveLength(
            0,
          );
          expect(JSON.stringify(renderer.toJSON())).toContain(
            labels.resource![purpose === "open" ? "opening" : "downloading"],
          );
          await act(async () => settle());
          expect(renderer.root.findAllByProps({ role: "status" })).toHaveLength(
            0,
          );
          expect(attempt).toBe(2);
        } finally {
          act(() => renderer?.unmount());
        }
      },
    );
  });
}

it.each(codes)(
  "classifies host %s errors for open, download and inline links",
  async (code) => {
    for (const purpose of ["open", "download", "inline"] as const) {
      let renderer!: ReactTestRenderer;
      const fail = () => {
        throw { code, message: privateDiagnostic };
      };
      try {
        await act(async () => {
          renderer = create(
            renderResource(
              {
                resolve: () => ({ url: "https://example.test/file" }),
                open: fail,
                download: fail,
              },
              {
                resource: { uri: "private:file" },
                inline: purpose === "inline",
              },
            ),
          );
        });
        if (purpose === "inline")
          await act(async () =>
            renderer.root
              .findByType("a")
              .props["onClick"]({ preventDefault() {} }),
          );
        else await press(renderer, purpose === "open" ? "Open" : "Download");
        expect(renderer.root.findAllByProps({ role: "alert" })).toHaveLength(
          code === "cancelled" ? 0 : 1,
        );
        if (code !== "cancelled")
          expect(JSON.stringify(renderer.toJSON())).toContain(
            defaultChatUiLabels.resource![code],
          );
        expect(JSON.stringify(renderer.toJSON())).not.toContain("secret");
      } finally {
        act(() => renderer?.unmount());
      }
    }
  },
);

it("retries a localized expired image through the original port and renders the recovered URL", async () => {
  let resolve!: (value: { url: string }) => void;
  let attempts = 0;
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = create(
        renderResource(
          {
            resolve: () => {
              if (++attempts === 1) throw new ChatResourceError("expired");
              return new Promise((done) => {
                resolve = done;
              });
            },
          },
          {
            resource: { uri: "private:image" },
            kind: "image",
            labels: playgroundChatLabels,
          },
        ),
      );
    });
    await press(renderer, "重试资源");
    expect(JSON.stringify(renderer.toJSON())).toContain("正在加载资源…");
    await act(async () =>
      resolve({ url: "https://example.test/recovered.png" }),
    );
    expect(renderer.root.findByType("img").props["src"]).toBe(
      "https://example.test/recovered.png",
    );
    expect(renderer.root.findAllByProps({ role: "alert" })).toHaveLength(0);
  } finally {
    act(() => renderer?.unmount());
  }
});

it("suppresses native cancelled actions and ignores failures arriving after scope replacement or unmount", async () => {
  const rejects: Array<(reason: unknown) => void> = [];
  const port: ChatResourcePort = {
    resolve: () => ({ url: "https://example.test/file" }),
    download: () => new Promise((_resolve, reject) => rejects.push(reject)),
  };
  const tree = (scope: string) =>
    createElement(
      ChatResourceProvider,
      { port, scope },
      createElement(ChatResourceView, { resource: { uri: "private:file" } }),
    );
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(tree("a"));
  });
  await press(renderer, "Download");
  await act(async () =>
    rejects[0]?.(new DOMException(privateDiagnostic, "AbortError")),
  );
  expect(renderer.root.findAllByProps({ role: "alert" })).toHaveLength(0);
  await press(renderer, "Download");
  await act(async () => renderer.update(tree("b")));
  await act(async () => rejects[1]?.(new ChatResourceError("network")));
  expect(renderer.root.findAllByProps({ role: "alert" })).toHaveLength(0);
  await press(renderer, "Download");
  act(() => renderer.unmount());
  await act(async () => rejects[2]?.(new Error(privateDiagnostic)));
  expect(renderer.toJSON()).toBeNull();
});

it("inherits resource translations in timeline Markdown and event details without renderer-specific props", async () => {
  const tool = createCapabilityTimeline("tools", "conversation", "test").find(
    (item) => item.kind === "agent-event" && item.eventType === "Download 示例",
  );
  if (tool?.kind !== "agent-event") throw new Error("Missing resource event");
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(
        createElement(ChatEventDetail, {
          item: tool,
          labels: playgroundChatLabels,
        }),
      );
    });
    expect(
      Array.from(container.querySelectorAll("button")).map(
        (button) => button.textContent,
      ),
    ).toContain("下载");
    expect(
      Array.from(container.querySelectorAll("button")).map(
        (button) => button.textContent,
      ),
    ).not.toContain("Download");
    await act(async () => {
      root.render(
        createElement(ChatTimeline, {
          conversationId: "conversation",
          labels: playgroundChatLabels,
          items: [
            {
              kind: "message",
              id: "markdown",
              conversationId: "conversation",
              role: "assistant",
              createdAt: 1,
              content: {
                kind: "text",
                text: "![图片](https://example.test/image.png)",
              },
            },
          ],
        }),
      );
    });
    expect(
      container.querySelector('[data-chat-resource="image"]')?.textContent,
    ).toContain("下载");
  } finally {
    await act(async () => root.unmount());
  }
});
