// @vitest-environment jsdom
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { expect, it, vi } from "vitest";
import {
  ChatCodeContent,
  ChatCodeDiff,
} from "../packages/chat-ui-antd/src/code-content.js";
import { highlightCode } from "../packages/chat-ui-antd/src/code-highlight.js";

it("highlights known languages while escaping HTML and bounding highlighter work", () => {
  expect(highlightCode("const value = '<script>'", "js")).toContain(
    "hljs-keyword",
  );
  expect(highlightCode("const value = '<script>'", "js")).not.toContain(
    "<script>",
  );
  expect(highlightCode("unknown", "future")).toBeUndefined();
  expect(highlightCode("x".repeat(40_001), "js")).toBeUndefined();
});

it("copies exact current code, folds large code and updates without leaking prior content", async () => {
  const writeText = vi.fn(async (text: string) => {
    void text;
  });
  const old = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  let renderer!: ReactTestRenderer;
  try {
    const code = "line\n".repeat(2_000);
    await act(async () => {
      renderer = create(createElement(ChatCodeContent, { code }));
    });
    expect(
      renderer.root.findAllByType("code")[0]?.children.join("").length,
    ).toBe(4_000);
    await act(async () => {
      renderer.root
        .findAllByType("button")
        .find((button) => button.children.includes("Copy code"))
        ?.props["onClick"]();
    });
    expect(writeText).toHaveBeenCalledWith(code);
    act(() => {
      renderer.root
        .findAllByType("button")
        .find((button) => button.props["aria-expanded"] === false)
        ?.props["onClick"]();
    });
    expect(renderer.root.findAllByType("code")[0]?.children.join("")).toBe(
      code,
    );
    await act(async () => {
      renderer.update(createElement(ChatCodeContent, { code: "replacement" }));
    });
    expect(JSON.stringify(renderer.toJSON())).not.toContain("line\\n");
    act(() => renderer.unmount());
  } finally {
    if (old) Object.defineProperty(navigator, "clipboard", old);
    else Reflect.deleteProperty(navigator, "clipboard");
  }
});

it("keeps empty and large diff inputs accessible and read-only", async () => {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      createElement(ChatCodeDiff, { original: "", modified: "new\n" }),
    );
    await vi.dynamicImportSettled();
  });
  expect(JSON.stringify(renderer.toJSON())).toContain("+new");
  await act(async () => {
    renderer.update(
      createElement(ChatCodeDiff, {
        original: "old".repeat(30_000),
        modified: "replacement",
      }),
    );
  });
  expect(JSON.stringify(renderer.toJSON())).toContain("both complete versions");
  expect(renderer.root.findAllByType("textarea")).toHaveLength(0);
  act(() => renderer.unmount());
});
