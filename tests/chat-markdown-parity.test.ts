// @vitest-environment jsdom
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { expect, it, vi } from "vitest";
import { ChatMarkdownContent } from "../packages/chat-ui-antd/src/markdown-content.js";
import { ChatResourceProvider } from "../packages/chat-react/src/index.js";

it("copies only the selected fenced block and renders private Markdown images through the host port", async () => {
  const copy = vi.fn(async (text: string) => {
    void text;
  });
  const previous = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: copy },
  });
  const resolve = vi.fn(() => ({ url: "https://example.com/resolved.png" }));
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = create(
        createElement(
          ChatResourceProvider,
          { port: { resolve } },
          createElement(ChatMarkdownContent, {
            children:
              "![private](s3://bucket/image)\n\n```js\nconst first = 1;\n```\n\n```unknown\nsecond block\n```",
          }),
        ),
      );
      await vi.dynamicImportSettled();
    });
    expect(renderer.root.findByType("img").props["src"]).toBe(
      "https://example.com/resolved.png",
    );
    await act(async () => {
      renderer.root
        .findAllByType("button")
        .filter((button) => button.children.includes("Copy code"))[1]
        ?.props["onClick"]();
    });
    expect(copy).toHaveBeenCalledWith("second block");
    expect(copy).not.toHaveBeenCalledWith(expect.stringContaining("first"));
    copy.mockRejectedValueOnce(new Error("denied"));
    await act(async () => {
      renderer.root
        .findAllByType("button")
        .filter((button) => button.children.includes("Copy code"))[0]
        ?.props["onClick"]();
    });
    expect(JSON.stringify(renderer.toJSON())).toContain("Copy failed");
  } finally {
    act(() => renderer?.unmount());
    if (previous) Object.defineProperty(navigator, "clipboard", previous);
    else Reflect.deleteProperty(navigator, "clipboard");
  }
});

it("preserves a real DOM selection through streamed Markdown and asynchronous highlighting", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const render = async (code: string) => {
    await act(async () => {
      root.render(
        createElement(ChatMarkdownContent, {
          children: "```js\n" + code + "\n```",
        }),
      );
    });
    await act(async () => {
      await vi.dynamicImportSettled();
    });
  };
  try {
    await render("const answer = 1;");
    const node = container.querySelector("code .hljs-keyword")?.firstChild;
    if (!node) throw new Error("Missing highlighted keyword");
    document.getSelection()?.setBaseAndExtent(node, 0, node, 5);
    expect(document.getSelection()?.toString()).toBe("const");
    await render("const answer = 1;\nconsole.log(answer);");
    expect(document.getSelection()?.toString()).toBe("const");
    await render("const answer = 1;\nconsole.log(answer);\n// complete");
    expect(document.getSelection()?.toString()).toBe("const");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

it("routes public and private Markdown links through host open and rejects executable schemes", async () => {
  const open = vi.fn();
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      createElement(
        ChatResourceProvider,
        { port: { open } },
        createElement(ChatMarkdownContent, {
          children:
            "[public](https://example.com) [private](s3://bucket/doc) [unsafe](javascript:alert)",
        }),
      ),
    );
  });
  try {
    const links = renderer.root.findAllByType("a");
    expect(links).toHaveLength(2);
    for (const link of links)
      await act(async () =>
        link.props["onClick"]({ preventDefault: () => undefined }),
      );
    expect(open.mock.calls.map((args) => args[0].resource.uri)).toEqual([
      "https://example.com",
      "s3://bucket/doc",
    ]);
  } finally {
    act(() => renderer.unmount());
  }
});

it("preserves relative, fragment and mailto links through the default safe open policy", async () => {
  const clicked: string[] = [];
  const click = vi
    .spyOn(HTMLAnchorElement.prototype, "click")
    .mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push(this.href);
    });
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = create(
        createElement(ChatMarkdownContent, {
          children:
            "[relative](/guide) [section](#details) [mail](mailto:reader@example.com)",
        }),
      );
    });
    const links = renderer.root.findAllByType("a");
    expect(links).toHaveLength(3);
    for (const link of links)
      await act(async () =>
        link.props["onClick"]({ preventDefault: () => undefined }),
      );
    expect(clicked).toEqual([
      new URL("/guide", document.baseURI).href,
      new URL("#details", document.baseURI).href,
      "mailto:reader@example.com",
    ]);
  } finally {
    act(() => renderer?.unmount());
    click.mockRestore();
  }
});
