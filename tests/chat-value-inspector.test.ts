// @vitest-environment jsdom
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { expect, it, vi } from "vitest";
import { ValueInspector } from "../packages/chat-ui-antd/src/value-inspector.js";

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
        .find((button) => button.children.includes("Copy received result"))
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
