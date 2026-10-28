// @vitest-environment jsdom
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { expect, it, vi } from "vitest";
import { ValueInspector } from "../packages/chat-ui-antd/src/value-inspector.js";
import { renderToStaticMarkup } from "react-dom/server";

it("renders nested JSON as fields and folded objects with an accessible icon copy action", () => {
  const html = renderToStaticMarkup(
    createElement(ValueInspector, {
      value: '{"rows":7616,"totals":{"amount":12846.52}}',
      label: "执行结果",
    }),
  );
  expect(html).toContain("rows");
  expect(html).toContain("7616");
  expect(html).toContain('<details open=""');
  expect(html).toContain('aria-label="复制执行结果"');
  expect(html).toContain("<svg");
  expect(html).not.toContain("Copy received result");
});

it("keeps cyclic values in the safe serialization fallback", () => {
  const value: { loop?: unknown } = {};
  value.loop = value;
  const html = renderToStaticMarkup(createElement(ValueInspector, { value }));
  expect(html).toContain("could not be serialized");
});

it("renders Markdown results safely while retaining raw copy and leaving arguments as text", () => {
  const value =
    "### Result\n\n**已完成**\n\n- 第一项\n- 第二项\n<script>alert(1)</script>";
  const html = renderToStaticMarkup(createElement(ValueInspector, { value }));
  expect(html).toContain("<h3");
  expect(html).toContain("<strong>已完成</strong>");
  expect(html).not.toContain("<script>");
  const args = renderToStaticMarkup(
    createElement(ValueInspector, { value: "### code", label: "输入参数" }),
  );
  expect(args).not.toContain("<h3");
});

it("shows simple object arrays directly as a table and opens shallow nested fields", () => {
  const html = renderToStaticMarkup(
    createElement(ValueInspector, {
      value: [
        { id: "1", name: "开始" },
        { id: "2", name: "完成" },
      ],
    }),
  );
  expect(html).toContain("<table");
  expect(html).toContain("<th");
  expect(html).toContain("完成");
  const nested = renderToStaticMarkup(
    createElement(ValueInspector, {
      value: { connection: { connected: true } },
    }),
  );
  expect(nested).toContain('<details open=""');
});

it("expands received long results and copies their complete value", async () => {
  const value = "result".repeat(3_000);
  const copy = vi.fn(async (text: string) => {
    void text;
  });
  const previous = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: copy },
  });
  let renderer!: ReactTestRenderer;
  try {
    act(() => {
      renderer = create(createElement(ValueInspector, { value }));
    });
    expect(renderer.root.findByType("pre").children.join("")).toHaveLength(
      4_000,
    );
    act(() =>
      renderer.root
        .findAllByType("button")
        .find((button) => button.children.includes("Show more result"))
        ?.props["onClick"](),
    );
    expect(renderer.root.findByType("pre").children.join("")).toBe(value);
    await act(async () =>
      renderer.root
        .findAllByType("button")
        .find((button) => button.props["aria-label"] === "复制执行结果")
        ?.props["onClick"](),
    );
    expect(copy).toHaveBeenCalledWith(value);
    act(() =>
      renderer.update(
        createElement(ValueInspector, {
          value:
            "[Tool result omitted: exceeds safe display size or structure limits]",
        }),
      ),
    );
    expect(JSON.stringify(renderer.toJSON())).toContain("Tool result omitted");
  } finally {
    act(() => renderer?.unmount());
    if (previous) Object.defineProperty(navigator, "clipboard", previous);
    else Reflect.deleteProperty(navigator, "clipboard");
  }
});

it("preserves expansion across equivalent result objects and resets for changed content", () => {
  const value = { payload: "result ".repeat(1000), marker: "last" };
  let renderer!: ReactTestRenderer;
  try {
    act(() => {
      renderer = create(createElement(ValueInspector, { value }));
    });
    act(() =>
      renderer.root
        .findAllByType("button")
        .find((button) => button.children.includes("Show more result"))!
        .props["onClick"](),
    );
    const full = JSON.stringify(value, null, 2);
    expect(renderer.root.findByType("pre").children.join("")).toBe(full);
    act(() =>
      renderer.update(createElement(ValueInspector, { value: { ...value } })),
    );
    expect(renderer.root.findByType("pre").children.join("")).toBe(full);
    act(() =>
      renderer.update(
        createElement(ValueInspector, {
          value: { ...value, marker: "updated" },
        }),
      ),
    );
    expect(renderer.root.findByType("pre").children.join("")).toHaveLength(
      4000,
    );
  } finally {
    act(() => renderer?.unmount());
  }
});
